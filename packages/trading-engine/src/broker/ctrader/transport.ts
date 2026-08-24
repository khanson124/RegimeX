import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { type CTraderEnvelope, ProtoOAPayloadType } from "./payloadTypes.js";

export type CTraderMessageHandler = (msg: CTraderEnvelope) => void;

export interface CTraderTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(envelope: CTraderEnvelope): Promise<void>;
  onMessage(handler: CTraderMessageHandler): () => void;
  readonly connected: boolean;
}

export interface WsCTraderTransportOptions {
  /** Host without scheme, e.g. demo.ctraderapi.com */
  host: string;
  /** JSON Open API port — official docs: 5036 */
  port?: number;
  /** Heartbeat interval ms (docs recommend ~10s). */
  heartbeatMs?: number;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

/**
 * WebSocket JSON transport for cTrader Open API.
 * Endpoint: wss://{host}:5036 (JSON). Protobuf uses 5035 — we use JSON only.
 * Docs: https://help.ctrader.com/open-api/proxies-endpoints/
 *       https://help.ctrader.com/open-api/sending-receiving-json/
 */
export class WsCTraderTransport implements CTraderTransport {
  private ws: WebSocket | null = null;
  private handlers = new Set<CTraderMessageHandler>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private _connected = false;

  constructor(private readonly opts: WsCTraderTransportOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  get reconnectCount(): number {
    return this.reconnectAttempts;
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    const port = this.opts.port ?? 5036;
    const url = `wss://${this.opts.host}:${port}`;
    await this.openSocket(url);
  }

  private openSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;

      ws.on("open", () => {
        this._connected = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.opts.logger?.info({ url }, "cTrader WS connected");
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on("message", (data) => {
        try {
          const text = typeof data === "string" ? data : data.toString("utf8");
          const msg = JSON.parse(text) as CTraderEnvelope;
          for (const h of this.handlers) h(msg);
        } catch (err) {
          this.opts.logger?.warn({ err }, "cTrader WS message parse failed");
        }
      });

      ws.on("close", () => {
        this._connected = false;
        this.stopHeartbeat();
        this.opts.logger?.warn({ intentional: this.intentionalClose }, "cTrader WS closed");
        if (!this.intentionalClose && this.opts.reconnect !== false) {
          void this.scheduleReconnect(url);
        }
      });

      ws.on("error", (err) => {
        this.opts.logger?.warn({ err: String(err) }, "cTrader WS error");
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  private async scheduleReconnect(url: string): Promise<void> {
    const max = this.opts.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempts >= max) {
      this.opts.logger?.warn({ attempts: this.reconnectAttempts }, "cTrader reconnect exhausted");
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempts);
    await new Promise((r) => setTimeout(r, delay));
    if (this.intentionalClose) return;
    try {
      await this.openSocket(url);
    } catch {
      void this.scheduleReconnect(url);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const ms = this.opts.heartbeatMs ?? 10_000;
    this.heartbeatTimer = setInterval(() => {
      void this.send({
        clientMsgId: randomUUID(),
        payloadType: ProtoOAPayloadType.PROTO_HEARTBEAT_EVENT,
        payload: {}
      }).catch(() => undefined);
    }, ms);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  async send(envelope: CTraderEnvelope): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("cTrader transport not connected");
    }
    const body = JSON.stringify({
      clientMsgId: envelope.clientMsgId ?? randomUUID(),
      payloadType: envelope.payloadType,
      payload: envelope.payload ?? {}
    });
    this.ws.send(body);
  }

  onMessage(handler: CTraderMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

/** In-memory mock transport for unit tests. */
export class MockCTraderTransport implements CTraderTransport {
  private handlers = new Set<CTraderMessageHandler>();
  private _connected = false;
  readonly sent: CTraderEnvelope[] = [];
  autoResponder?: (req: CTraderEnvelope) => CTraderEnvelope | CTraderEnvelope[] | null;

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  async send(envelope: CTraderEnvelope): Promise<void> {
    if (!this._connected) throw new Error("mock transport not connected");
    this.sent.push(envelope);
    const reply = this.autoResponder?.(envelope);
    if (!reply) return;
    const list = Array.isArray(reply) ? reply : [reply];
    for (const msg of list) {
      queueMicrotask(() => {
        for (const h of this.handlers) h(msg);
      });
    }
  }

  emit(msg: CTraderEnvelope): void {
    for (const h of this.handlers) h(msg);
  }

  onMessage(handler: CTraderMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
