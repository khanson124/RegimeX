import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import {
  ensureMailboxLayout,
  listUnackedProcessing,
  removeStaleTempFiles,
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
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
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

/**
 * Local-only HTTP front for the Wine/MT5 mailbox.
 * Bind this inside Docker on the internal network. Never publish the port.
 * Nginx must never proxy this service.
 */
export function startMt5BridgeServer(config: Mt5BridgeServerConfig): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handle(req, res, config).catch((err) => {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });
    server.listen(config.port, config.host, () => resolve(server));
    server.on("error", reject);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Mt5BridgeServerConfig
): Promise<void> {
  const url = req.url ?? "/";
  if (req.method === "GET" && (url === "/health" || url === "/health/live")) {
    send(res, 200, { ok: true, service: "mt5-bridge" });
    return;
  }

  if (!authorize(req, config.secret)) {
    send(res, 401, { error: "MT5_BRIDGE_UNAUTHENTICATED" });
    return;
  }

  if (req.method === "GET" && url === "/v1/unacked") {
    const ids = await listUnackedProcessing(config.mailboxPath);
    send(res, 200, { unacked: ids });
    return;
  }

  if (req.method !== "POST" || url !== "/v1/command") {
    send(res, 404, { error: "NOT_FOUND" });
    return;
  }

  const parsed = JSON.parse((await readBody(req)) || "{}") as {
    command?: Mt5CommandType;
    payload?: unknown;
    requestId?: string;
    idempotencyKey?: string;
  };
  if (!parsed.command) {
    send(res, 400, { error: "command required" });
    return;
  }
  const requestId = parsed.requestId || randomUUID();
  const idempotencyKey = parsed.idempotencyKey || requestId;

  await ensureMailboxLayout(config.mailboxPath);
  await removeStaleTempFiles(config.mailboxPath);

  await writePendingCommand(config.mailboxPath, config.secret, {
    requestId,
    idempotencyKey,
    command: parsed.command,
    payload: parsed.payload ?? {}
  });

  try {
    const reply = await waitForReply(config.mailboxPath, requestId, config.commandTimeoutMs);
    if (reply.authHmac && !verifyReply(config.secret, reply)) {
      send(res, 400, {
        requestId,
        idempotencyKey,
        command: parsed.command,
        ok: false,
        errorCode: "MT5_REPLY_HMAC_INVALID",
        createdAt: new Date().toISOString(),
        authHmac: ""
      });
      return;
    }
    send(res, reply.ok ? 200 : 400, reply);
  } catch (err) {
    send(res, 504, {
      requestId,
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
}
