import { type FastifyInstance } from "fastify";
import { type WebSocket } from "ws";
import { CHANNELS, type AppWsEvent } from "@regimex/shared";
import { type AppContext } from "../context.js";
import { extractWsAccessToken } from "../lib/wsAuth.js";

/** Event types throttled per-connection (high-frequency price updates). */
const THROTTLED_EVENTS = new Set(["market.tick"]);
const THROTTLE_MS = 1_000;

/**
 * Application WebSocket for mobile clients.
 *
 * - Authenticated via `Authorization: Bearer` or `?token=<accessToken>` at upgrade time.
 * - Request logs redact query tokens; prefer the Authorization header when the client can send it.
 * - Receives events published by the worker on Redis pub/sub and forwards
 *   only the events belonging to the authenticated user.
 * - `market.tick` is throttled to at most one per second per client; candles,
 *   regimes, signals, trades and engine status are forwarded immediately.
 * - Credentials or tokens are never included in outbound payloads.
 */
export function registerWsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const clients = new Map<string, Set<WebSocket>>();
  const lastSentByType = new WeakMap<WebSocket, Map<string, number>>();

  // Single Redis subscription fans out to all connected clients.
  void ctx.sub.subscribe(CHANNELS.appEvents);
  ctx.sub.on("message", (channel, raw) => {
    if (channel !== CHANNELS.appEvents) return;
    let event: AppWsEvent;
    try {
      event = JSON.parse(raw) as AppWsEvent;
    } catch {
      return;
    }
    const sockets = clients.get(event.userId);
    if (!sockets || sockets.size === 0) return;

    const outbound = JSON.stringify({ type: event.type, payload: event.payload, ts: event.ts });
    for (const socket of sockets) {
      if (socket.readyState !== socket.OPEN) continue;
      if (THROTTLED_EVENTS.has(event.type)) {
        let perType = lastSentByType.get(socket);
        if (!perType) {
          perType = new Map();
          lastSentByType.set(socket, perType);
        }
        const last = perType.get(event.type) ?? 0;
        if (event.ts - last < THROTTLE_MS) continue;
        perType.set(event.type, event.ts);
      }
      socket.send(outbound);
    }
  });

  app.get("/ws", { websocket: true }, (socket, request) => {
    const token = extractWsAccessToken({
      headers: request.headers,
      query: request.query
    });
    let userId: string;
    try {
      if (!token) throw new Error("missing token");
      userId = ctx.tokens.verifyAccessToken(token).sub;
    } catch {
      socket.close(4401, "Unauthorized");
      return;
    }

    let set = clients.get(userId);
    if (!set) {
      set = new Set();
      clients.set(userId, set);
    }
    set.add(socket);
    socket.send(JSON.stringify({ type: "connection.ready", payload: {}, ts: Date.now() }));

    socket.on("close", () => {
      set.delete(socket);
      if (set.size === 0) clients.delete(userId);
    });
    // Server-side keepalive.
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 30_000);
    socket.on("close", () => clearInterval(ping));
  });
}
