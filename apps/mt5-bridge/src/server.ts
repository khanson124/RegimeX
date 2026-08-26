import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { access } from "node:fs/promises";
import {
  listUnackedProcessing,
  mailboxDepthSnapshot,
  prepareMailbox,
  verifyReply,
  waitForReply,
  writePendingCommand,
  type Mt5CommandType
} from "@regimex/trading-engine";

export interface Mt5BridgeServerConfig {
  host: string;
  port: number;
  secret: string;
  mailboxPath: string;
  commandTimeoutMs: number;
  maxInFlight?: number;
  mailboxIoTimeoutMs?: number;
  readyTimeoutMs?: number;
}

export interface Mt5BridgeRuntimeState {
  inFlight: number;
  lastSuccessfulEaReplyAt: number | null;
  lastEaTimeoutAt: number | null;
  lastCommandAt: number | null;
  oldestInFlightStartedAt: number | null;
}

const DEFAULT_MAX_IN_FLIGHT = 8;
const DEFAULT_READY_TIMEOUT_MS = 400;
const MAX_BODY_BYTES = 64 * 1024;

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

function readBody(req: IncomingMessage, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(Object.assign(new Error("MT5_BRIDGE_TIMEOUT"), { code: "MT5_BRIDGE_TIMEOUT" }));
    }, timeoutMs);
    req.on("data", (c) => {
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer);
        req.destroy();
        reject(Object.assign(new Error("MT5_BRIDGE_PAYLOAD_TOO_LARGE"), { code: "MT5_BRIDGE_PAYLOAD_TOO_LARGE" }));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store"
  });
  res.end(json);
}

function authorize(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function isMt5BridgeLivePayload(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { ok?: unknown; service?: unknown };
    return parsed.ok === true && parsed.service === "mt5-bridge";
  } catch {
    return false;
  }
}

/**
 * Local-only HTTP front for the Wine/MT5 mailbox.
 * Bind this inside Docker on the internal network. Never publish the port.
 * Nginx must never proxy this service.
 *
 * /health/live is event-loop liveness only — no mailbox, no EA wait.
 */
export function startMt5BridgeServer(config: Mt5BridgeServerConfig): Promise<Server> {
  const state: Mt5BridgeRuntimeState = {
    inFlight: 0,
    lastSuccessfulEaReplyAt: null,
    lastEaTimeoutAt: null,
    lastCommandAt: null,
    oldestInFlightStartedAt: null
  };
  const inFlightStarted = new Map<string, number>();
  const maxInFlight = config.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;

  const refreshOldest = () => {
    let oldest: number | null = null;
    for (const started of inFlightStarted.values()) {
      if (oldest == null || started < oldest) oldest = started;
    }
    state.oldestInFlightStartedAt = oldest;
    state.inFlight = inFlightStarted.size;
  };

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handle(req, res, config, state, {
        maxInFlight,
        inFlightStarted,
        refreshOldest
      }).catch((err) => {
        const code =
          err && typeof err === "object" && "code" in err && typeof err.code === "string"
            ? err.code
            : "MT5_BRIDGE_UNHEALTHY";
        send(res, code === "MT5_BRIDGE_TIMEOUT" ? 504 : 500, {
          ok: false,
          errorCode: code,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = config.commandTimeoutMs + 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxConnections = 64;
    server.listen(config.port, config.host, () => {
      void prepareMailbox(config.mailboxPath).then((prep) => {
        if (prep.quarantined.length) {
          console.warn(
            JSON.stringify({
              msg: "LEGACY_UNSAFE_MAILBOX_FILENAME",
              quarantined: prep.quarantined.map((q) => q.from)
            })
          );
        }
        resolve(server);
      }, reject);
    });
    server.on("error", reject);

    const prepareTimer = setInterval(() => {
      void prepareMailbox(config.mailboxPath).catch((err) => {
        console.warn(
          JSON.stringify({
            msg: "MT5_MAILBOX_PREPARE_FAILED",
            error: err instanceof Error ? err.message : String(err)
          })
        );
      });
    }, 60_000);
    prepareTimer.unref();
    server.on("close", () => clearInterval(prepareTimer));
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Mt5BridgeServerConfig,
  state: Mt5BridgeRuntimeState,
  flight: {
    maxInFlight: number;
    inFlightStarted: Map<string, number>;
    refreshOldest: () => void;
  }
): Promise<void> {
  const url = (req.url ?? "/").split("?")[0] ?? "/";

  if (req.method === "GET" && (url === "/health" || url === "/health/live")) {
    send(res, 200, { ok: true, service: "mt5-bridge" });
    return;
  }

  if (req.method === "GET" && url === "/health/ready") {
    const readyTimeout = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const snapshot = await withTimeout(
      mailboxDepthSnapshot(config.mailboxPath),
      readyTimeout,
      { pending: -1, processing: -1, replies: -1 }
    );
    const mailboxMounted = await withTimeout(
      access(config.mailboxPath).then(
        () => true,
        () => false
      ),
      readyTimeout,
      false
    );
    const oldestAgeMs =
      state.oldestInFlightStartedAt != null ? Date.now() - state.oldestInFlightStartedAt : null;
    const eaRecent =
      state.lastSuccessfulEaReplyAt != null && Date.now() - state.lastSuccessfulEaReplyAt < 30_000;
    send(res, 200, {
      ok: true,
      service: "mt5-bridge",
      mailboxMounted,
      pending: snapshot.pending,
      processing: snapshot.processing,
      replies: snapshot.replies,
      inFlight: state.inFlight,
      oldestInFlightAgeMs: oldestAgeMs,
      lastSuccessfulEaReplyAt: state.lastSuccessfulEaReplyAt,
      lastEaTimeoutAt: state.lastEaTimeoutAt,
      lastCommandAt: state.lastCommandAt,
      eaRecent,
      eaHealth: eaRecent ? "online" : state.lastSuccessfulEaReplyAt ? "offline" : "unknown"
    });
    return;
  }

  if (!authorize(req, config.secret)) {
    send(res, 401, { error: "MT5_BRIDGE_UNAUTHENTICATED", errorCode: "MT5_BRIDGE_UNAUTHENTICATED" });
    return;
  }

  if (req.method === "GET" && url === "/v1/unacked") {
    const ids = await withTimeout(listUnackedProcessing(config.mailboxPath), 2_000, []);
    send(res, 200, { unacked: ids });
    return;
  }

  if (req.method !== "POST" || url !== "/v1/command") {
    send(res, 404, { error: "NOT_FOUND", errorCode: "NOT_FOUND" });
    return;
  }

  if (flight.inFlightStarted.size >= flight.maxInFlight) {
    send(res, 503, {
      ok: false,
      errorCode: "MT5_MAILBOX_BACKLOG",
      error: "MT5_MAILBOX_BACKLOG",
      inFlight: flight.inFlightStarted.size
    });
    return;
  }

  const parsed = JSON.parse((await readBody(req, 5_000)) || "{}") as {
    command?: Mt5CommandType;
    payload?: unknown;
    requestId?: string;
    idempotencyKey?: string;
  };
  if (!parsed.command) {
    send(res, 400, { error: "command required", errorCode: "MT5_COMMAND_REQUIRED" });
    return;
  }
  const requestId = parsed.requestId || randomUUID();
  const idempotencyKey = parsed.idempotencyKey || requestId;
  state.lastCommandAt = Date.now();
  flight.inFlightStarted.set(requestId, Date.now());
  flight.refreshOldest();

  try {
    const written = await writePendingCommand(config.mailboxPath, config.secret, {
      requestId,
      idempotencyKey,
      command: parsed.command,
      payload: parsed.payload ?? {}
    });

    try {
      const reply = await waitForReply(config.mailboxPath, written.mailboxFileId, config.commandTimeoutMs);
      if (reply.authHmac && !verifyReply(config.secret, reply)) {
        send(res, 400, {
          requestId,
          mailboxFileId: written.mailboxFileId,
          idempotencyKey,
          command: parsed.command,
          ok: false,
          errorCode: "MT5_REPLY_HMAC_INVALID",
          createdAt: new Date().toISOString(),
          authHmac: ""
        });
        return;
      }
      if (reply.ok) state.lastSuccessfulEaReplyAt = Date.now();
      send(res, reply.ok ? 200 : 400, reply);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err && typeof err.code === "string"
          ? err.code
          : "MT5_EA_TIMEOUT";
      if (code === "MT5_MAILBOX_IO_TIMEOUT") {
        send(res, 503, {
          requestId,
          mailboxFileId: written.mailboxFileId,
          idempotencyKey,
          command: parsed.command,
          ok: false,
          errorCode: "MT5_BRIDGE_UNHEALTHY",
          errorMessage: "Mailbox IO timed out",
          needsReconcile: true,
          createdAt: new Date().toISOString(),
          authHmac: ""
        });
        return;
      }
      state.lastEaTimeoutAt = Date.now();
      send(res, 504, {
        requestId,
        mailboxFileId: written.mailboxFileId,
        idempotencyKey,
        command: parsed.command,
        ok: false,
        errorCode: "MT5_EA_TIMEOUT",
        errorMessage: err instanceof Error ? err.message : String(err),
        needsReconcile: true,
        createdAt: new Date().toISOString(),
        authHmac: ""
      });
    }
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err && typeof err.code === "string"
        ? err.code
        : "MT5_BRIDGE_UNHEALTHY";
    send(res, code === "MT5_MAILBOX_IO_TIMEOUT" ? 503 : 500, {
      requestId,
      idempotencyKey,
      command: parsed.command,
      ok: false,
      errorCode: code === "MT5_MAILBOX_IO_TIMEOUT" ? "MT5_BRIDGE_UNHEALTHY" : code,
      errorMessage: err instanceof Error ? err.message : String(err),
      needsReconcile: true,
      createdAt: new Date().toISOString(),
      authHmac: ""
    });
  } finally {
    flight.inFlightStarted.delete(requestId);
    flight.refreshOldest();
  }
}
