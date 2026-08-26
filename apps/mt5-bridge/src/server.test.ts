import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isMt5BridgeLivePayload, startMt5BridgeServer } from "./server.js";

const SECRET = "test-secret-value-32chars-long!";

describe("mt5-bridge server", () => {
  it("treats only ok+service JSON as a passing live healthcheck", () => {
    expect(isMt5BridgeLivePayload(JSON.stringify({ ok: true, service: "mt5-bridge" }))).toBe(true);
    expect(isMt5BridgeLivePayload("connected")).toBe(false);
    expect(isMt5BridgeLivePayload(JSON.stringify({ ok: false }))).toBe(false);
  });

  it("/health/live stays independent of a hung EA mailbox wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-bridge-"));
    const server = await startMt5BridgeServer({
      host: "127.0.0.1",
      port: 0,
      secret: SECRET,
      mailboxPath: root,
      commandTimeoutMs: 5_000
    });
    try {
      const addr = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;

      const command = fetch(`${base}/v1/command`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ command: "ping", payload: {}, requestId: "live-indep", idempotencyKey: "live-indep" })
      });

      const started = Date.now();
      const live = await fetch(`${base}/health/live`);
      const liveMs = Date.now() - started;
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ ok: true, service: "mt5-bridge" });
      expect(liveMs).toBeLessThan(500);

      await new Promise((r) => setTimeout(r, 80));
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(200);
      const readyBody = (await ready.json()) as { inFlight: number; eaHealth: string };
      expect(readyBody.inFlight).toBeGreaterThanOrEqual(1);
      expect(readyBody.eaHealth).toBe("unknown");

      const reply = await command;
      expect(reply.status).toBe(504);
      const body = (await reply.json()) as { errorCode: string };
      expect(body.errorCode).toBe("MT5_EA_TIMEOUT");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
