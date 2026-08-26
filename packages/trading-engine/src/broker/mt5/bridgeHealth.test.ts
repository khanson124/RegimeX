import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { probeMt5BridgeLive } from "./bridgeHealth.js";
import { MT5_BRIDGE_TIMEOUT, MT5_BRIDGE_UNAVAILABLE } from "./bridgeCircuit.js";

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          })
      });
    });
    server.on("error", reject);
  });
}

describe("probeMt5BridgeLive", () => {
  it("classifies HTTP timeout as MT5_BRIDGE_TIMEOUT", async () => {
    const hung = await listen((_req, _res) => {
      /* accept TCP, never write headers */
    });
    try {
      const probe = await probeMt5BridgeLive(hung.url, 50);
      expect(probe.ok).toBe(false);
      expect(probe.errorCode).toBe(MT5_BRIDGE_TIMEOUT);
    } finally {
      await hung.close();
    }
  });

  it("classifies connection refused as MT5_BRIDGE_UNAVAILABLE", async () => {
    const probe = await probeMt5BridgeLive("http://127.0.0.1:1", 200);
    expect(probe.ok).toBe(false);
    expect(probe.errorCode).toBe(MT5_BRIDGE_UNAVAILABLE);
  });

  it("returns ok for a live 200 body", async () => {
    const live = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "mt5-bridge" }));
    });
    try {
      const probe = await probeMt5BridgeLive(live.url, 500);
      expect(probe.ok).toBe(true);
      expect(probe.statusCode).toBe(200);
    } finally {
      await live.close();
    }
  });
});
