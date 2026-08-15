import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { DerivAuthenticationError, DerivConnectionError } from "@regimex/shared";
import {
  type DerivAuthorizeInfo,
  type DerivBuyResult,
  type DerivClientEvents,
  type DerivConnectionState,
  type DerivContractUpdate,
  type DerivHistoricalCandle,
  type DerivProposal,
  type DerivTick
} from "./types.js";

export interface DerivClientOptions {
  wsUrl: string;
  appId: string;
  /** Deriv API token; omit for public (market data only) connections. */
  apiToken?: string;
  /** Milliseconds between pings. Deriv drops idle connections around 2 min. */
  pingIntervalMs?: number;
  requestTimeoutMs?: number;
  maxReconnectDelayMs?: number;
  /** Minimum spacing between outbound requests (rate-limit awareness). */
  minRequestSpacingMs?: number;
  logger?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

interface PendingRequest {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  request: Record<string, unknown>;
}

type TickCallback = (tick: DerivTick) => void;

/**
 * Deriv WebSocket client.
 *
 * - Correlates requests/responses via req_id.
 * - Automatic reconnection with exponential backoff + jitter.
 * - Heartbeat pings to keep the connection alive.
 * - Restores tick and contract subscriptions after reconnect.
 * - Normalizes Deriv errors into typed application errors.
 * - Spaces outbound requests to stay under rate limits.
 */
export class DerivClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: DerivConnectionState = "DISCONNECTED";
  private reqCounter = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly tickSubscriptions = new Map<string, TickCallback>();
  private readonly contractSubscriptions = new Set<string>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;
  private lastSendAt = 0;
  private sendQueue: Promise<void> = Promise.resolve();
  private authorizeInfo: DerivAuthorizeInfo | null = null;

  constructor(private readonly options: DerivClientOptions) {
    super();
  }

  override on<E extends keyof DerivClientEvents>(event: E, listener: DerivClientEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  get connectionState(): DerivConnectionState {
    return this.state;
  }

  get accountInfo(): DerivAuthorizeInfo | null {
    return this.authorizeInfo;
  }

  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUser = false;
    await this.openSocket();
    if (this.options.apiToken) {
      await this.authorize(this.options.apiToken);
    }
  }

  async disconnect(): Promise<void> {
    this.closedByUser = true;
    this.stopPing();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DerivConnectionError("Client disconnected"));
    }
    this.pending.clear();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.setState("DISCONNECTED");
  }

  /** Authorize with a Deriv API token; returns normalized account info. */
  async authorize(token: string): Promise<DerivAuthorizeInfo> {
    const res = await this.send({ authorize: token });
    const a = res.authorize as Record<string, unknown>;
    const info: DerivAuthorizeInfo = {
      loginId: String(a.loginid ?? ""),
      isVirtual: Boolean(a.is_virtual),
      currency: String(a.currency ?? "USD"),
      balance: Number(a.balance ?? 0),
      email: a.email ? String(a.email) : null,
      landingCompany: a.landing_company_name ? String(a.landing_company_name) : null
    };
    this.authorizeInfo = info;
    this.setState("AUTHENTICATED");
    return info;
  }

  /** Subscribe to live ticks for a symbol. Restored automatically on reconnect. */
  async subscribeTicks(symbol: string, onTick: TickCallback): Promise<void> {
    this.tickSubscriptions.set(symbol, onTick);
    await this.send({ ticks: symbol, subscribe: 1 });
  }

  async unsubscribeTicks(symbol: string): Promise<void> {
    this.tickSubscriptions.delete(symbol);
    await this.send({ forget_all: "ticks" }).catch(() => undefined);
    // Re-subscribe remaining symbols (forget_all drops everything).
    for (const s of this.tickSubscriptions.keys()) {
      await this.send({ ticks: s, subscribe: 1 });
    }
  }

  /** Fetch historical candles (granularity in seconds). */
  async getCandleHistory(
    symbol: string,
    granularitySeconds: number,
    startEpochSec: number,
    endEpochSec: number,
    count = 5000
  ): Promise<DerivHistoricalCandle[]> {
    const res = await this.send({
      ticks_history: symbol,
      style: "candles",
      granularity: granularitySeconds,
      start: startEpochSec,
      end: endEpochSec,
      count
    });
    const candles = (res.candles as Array<Record<string, unknown>> | undefined) ?? [];
    return candles.map((c) => ({
      openTimeMs: Number(c.epoch) * 1000,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }));
  }

  /** Request a contract price proposal (payout comes from Deriv, not assumed). */
  async requestProposal(params: {
    contractType: "CALL" | "PUT";
    symbol: string;
    stake: number;
    duration: number;
    durationUnit: "t" | "s" | "m";
    currency: string;
  }): Promise<DerivProposal> {
    const res = await this.send({
      proposal: 1,
      amount: params.stake,
      basis: "stake",
      contract_type: params.contractType,
      currency: params.currency,
      duration: params.duration,
      duration_unit: params.durationUnit,
      symbol: params.symbol
    });
    const p = res.proposal as Record<string, unknown>;
    return {
      proposalId: String(p.id),
      askPrice: Number(p.ask_price),
      payout: Number(p.payout),
      spot: Number(p.spot),
      displayValue: String(p.display_value ?? "")
    };
  }

  /** Buy a proposed contract. Requires an authorized demo account. */
  async buyContract(proposalId: string, maxPrice: number): Promise<DerivBuyResult> {
    const res = await this.send({ buy: proposalId, price: maxPrice });
    const b = res.buy as Record<string, unknown>;
    return {
      contractId: String(b.contract_id),
      buyPrice: Number(b.buy_price),
      payout: Number(b.payout),
      startTime: Number(b.start_time) * 1000,
      transactionId: String(b.transaction_id),
      longcode: String(b.longcode ?? "")
    };
  }

  /** Subscribe to open-contract updates until settlement. */
  async subscribeContract(contractId: string): Promise<void> {
    this.contractSubscriptions.add(contractId);
    await this.send({ proposal_open_contract: 1, contract_id: Number(contractId), subscribe: 1 });
  }

  async getBalance(): Promise<{ balance: number; currency: string }> {
    const res = await this.send({ balance: 1 });
    const b = res.balance as Record<string, unknown>;
    return { balance: Number(b.balance), currency: String(b.currency ?? "USD") };
  }

  // ── internals ────────────────────────────────────────────────

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState(this.reconnectAttempts > 0 ? "RECONNECTING" : "CONNECTING");
      const url = `${this.options.wsUrl}?app_id=${this.options.appId}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      const onOpenError = (err: Error): void => {
        reject(new DerivConnectionError(`Failed to connect to Deriv: ${err.message}`));
      };

      ws.once("error", onOpenError);
      ws.once("open", () => {
        ws.removeListener("error", onOpenError);
        this.reconnectAttempts = 0;
        this.setState("CONNECTED");
        this.startPing();
        resolve();
      });

      ws.on("message", (data) => this.handleMessage(data.toString()));
      ws.on("close", () => this.handleClose());
      ws.on("error", (err) => {
        this.options.logger?.warn({ err: err.message }, "Deriv socket error");
        this.emit("error", err);
      });
    });
  }

  private handleClose(): void {
    this.stopPing();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DerivConnectionError("Connection closed"));
    }
    this.pending.clear();
    this.setState("DISCONNECTED");

    if (!this.closedByUser) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const base = Math.min(
      1000 * 2 ** this.reconnectAttempts,
      this.options.maxReconnectDelayMs ?? 30_000
    );
    const delay = base / 2 + Math.random() * (base / 2); // jitter
    this.options.logger?.info({ attempt: this.reconnectAttempts, delayMs: Math.round(delay) }, "Scheduling Deriv reconnect");
    setTimeout(() => {
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.closedByUser) return;
    try {
      await this.openSocket();
      if (this.options.apiToken) {
        await this.authorize(this.options.apiToken);
      }
      // Restore subscriptions.
      for (const symbol of this.tickSubscriptions.keys()) {
        await this.send({ ticks: symbol, subscribe: 1 });
      }
      for (const contractId of this.contractSubscriptions) {
        await this.send({ proposal_open_contract: 1, contract_id: Number(contractId), subscribe: 1 });
      }
      this.emit("reconnected");
    } catch (err) {
      this.options.logger?.warn({ err: err instanceof Error ? err.message : String(err) }, "Reconnect failed");
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.options.logger?.warn({}, "Received non-JSON message from Deriv");
      return;
    }

    // Streaming events
    const msgType = msg.msg_type as string | undefined;
    if (msgType === "tick" && msg.tick) {
      const t = msg.tick as Record<string, unknown>;
      const tick: DerivTick = {
        symbol: String(t.symbol),
        epochMs: Number(t.epoch) * 1000,
        quote: Number(t.quote)
      };
      this.emit("tick", tick);
      this.tickSubscriptions.get(tick.symbol)?.(tick);
      // Streaming messages can still carry a req_id for the initial response.
    }
    if (msgType === "proposal_open_contract" && msg.proposal_open_contract) {
      const c = msg.proposal_open_contract as Record<string, unknown>;
      const update: DerivContractUpdate = {
        contractId: String(c.contract_id),
        status: (c.status as DerivContractUpdate["status"]) ?? "open",
        entrySpot: c.entry_spot !== undefined ? Number(c.entry_spot) : null,
        exitSpot: c.exit_tick !== undefined ? Number(c.exit_tick) : null,
        currentSpot: c.current_spot !== undefined ? Number(c.current_spot) : null,
        buyPrice: Number(c.buy_price ?? 0),
        payout: c.payout !== undefined ? Number(c.payout) : null,
        profit: c.profit !== undefined ? Number(c.profit) : null,
        isSettled: Boolean(c.is_settleable === 0 && c.is_sold === 1) || ["won", "lost", "sold"].includes(String(c.status)),
        expiryTimeMs: c.date_expiry !== undefined ? Number(c.date_expiry) * 1000 : null,
        raw: c
      };
      if (update.isSettled) this.contractSubscriptions.delete(update.contractId);
      this.emit("contractUpdate", update);
    }
    if (msgType === "balance" && msg.balance) {
      const b = msg.balance as Record<string, unknown>;
      this.emit("balance", { balance: Number(b.balance), currency: String(b.currency ?? "USD") });
    }

    // Request/response correlation
    const reqId = msg.req_id as number | undefined;
    if (reqId !== undefined && this.pending.has(reqId)) {
      const p = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(this.normalizeError(msg.error as Record<string, unknown>));
      } else {
        p.resolve(msg);
      }
    }
  }

  private normalizeError(error: Record<string, unknown>): Error {
    const code = String(error.code ?? "UnknownError");
    const message = String(error.message ?? "Unknown Deriv error");
    if (code === "InvalidToken" || code === "AuthorizationRequired") {
      return new DerivAuthenticationError(message);
    }
    if (code === "RateLimit") {
      return new DerivConnectionError(`Deriv rate limit hit: ${message}`, { code });
    }
    return new DerivConnectionError(message, { code });
  }

  /** Send a request with req_id correlation, spacing, and timeout. */
  private send(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reqId = this.reqCounter++;
    const payload = { ...request, req_id: reqId };
    const timeoutMs = this.options.requestTimeoutMs ?? 15_000;
    const spacing = this.options.minRequestSpacingMs ?? 75;

    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new DerivConnectionError(`Deriv request timed out: ${Object.keys(request)[0]}`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer, request: payload });
    });

    // Serialize sends with minimum spacing (rate-limit awareness).
    this.sendQueue = this.sendQueue.then(async () => {
      const wait = this.lastSendAt + spacing - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastSendAt = Date.now();
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const p = this.pending.get(reqId);
        if (p) {
          this.pending.delete(reqId);
          clearTimeout(p.timer);
          p.reject(new DerivConnectionError("Not connected to Deriv"));
        }
        return;
      }
      this.ws.send(JSON.stringify(payload));
    });

    return result;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      void this.send({ ping: 1 }).catch(() => undefined);
    }, this.options.pingIntervalMs ?? 30_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setState(state: DerivConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit("stateChange", state);
    }
  }
}

/**
 * One-shot token verification: connects, authorizes, and disconnects.
 * Used by the API's /deriv/connect and /deriv/test-connection endpoints.
 */
export async function verifyDerivToken(
  wsUrl: string,
  appId: string,
  apiToken: string
): Promise<DerivAuthorizeInfo> {
  const client = new DerivClient({ wsUrl, appId, apiToken });
  try {
    await client.connect();
    const info = client.accountInfo;
    if (!info) throw new DerivAuthenticationError("Authorization did not return account info");
    return info;
  } finally {
    await client.disconnect();
  }
}
