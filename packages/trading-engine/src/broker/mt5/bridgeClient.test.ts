import { describe, expect, it, vi, afterEach } from "vitest";
import { HttpMt5BridgeClient } from "./bridgeClient.js";
import { Mt5BridgeCircuitBreaker, MT5_BRIDGE_TIMEOUT, MT5_BRIDGE_UNHEALTHY } from "./bridgeCircuit.js";
import { setMt5TelemetrySink } from "./mt5RequestTelemetry.js";

describe("HttpMt5BridgeClient", () => {
  afterEach(() => {
    setMt5TelemetrySink(null);
  });

  it("emits correlated start/end telemetry on success", async () => {
    const events: Record<string, unknown>[] = [];
    setMt5TelemetrySink((payload) => events.push(payload));
    const fetchImpl = vi.fn(async () =>
      Response.json({
        ok: true,
        command: "getQuote",
        requestId: "quote:corr-1",
        mailboxFileId: "mb-123",
        idempotencyKey: "quote",
        result: { symbol: "Volatility 10 Index", bid: 1, ask: 1.1, timestamp: Date.now() },
        authHmac: "ignored-in-telemetry"
      })
    ) as unknown as typeof fetch;

    const client = new HttpMt5BridgeClient({
      baseUrl: "http://127.0.0.1:8765",
      secret: "test-secret-value-32chars-long!",
      timeoutMs: 1_000,
      fetchImpl,
      circuit: new Mt5BridgeCircuitBreaker({ failureThreshold: 99 })
    });

    await client.request("getQuote", { symbol: "Volatility 10 Index" }, {
      requestId: "quote:corr-1",
      idempotencyKey: "quote"
    });

    expect(events.some((e) => e.event === "mt5_request_start" && e.requestId === "quote:corr-1")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.event === "mt5_request_end" &&
          e.requestId === "quote:corr-1" &&
          e.mailboxFileId === "mb-123"
      )
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("test-secret");
  });

  it("maps abort/timeout to MT5_BRIDGE_TIMEOUT, not a raw fetch failed string", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      if (init?.signal?.aborted) throw err;
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(err));
      });
      throw err;
    }) as unknown as typeof fetch;

    const client = new HttpMt5BridgeClient({
      baseUrl: "http://127.0.0.1:8765",
      secret: "test-secret-value-32chars-long!",
      timeoutMs: 20,
      fetchImpl,
      circuit: new Mt5BridgeCircuitBreaker({ failureThreshold: 99 })
    });
    const reply = await client.request("getOpenPositions", {}, { requestId: "r1", idempotencyKey: "k1" });
    expect(reply.ok).toBe(false);
    expect(reply.errorCode).toBe(MT5_BRIDGE_TIMEOUT);
    expect(reply.errorMessage).not.toBe("fetch failed");
  });

  it("skips broker HTTP while the circuit is open", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const circuit = new Mt5BridgeCircuitBreaker({ failureThreshold: 1, openMs: 60_000 });
    circuit.recordFailure(MT5_BRIDGE_TIMEOUT);
    const client = new HttpMt5BridgeClient({
      baseUrl: "http://127.0.0.1:8765",
      secret: "test-secret-value-32chars-long!",
      timeoutMs: 1_000,
      fetchImpl,
      circuit
    });
    const reply = await client.request("openMarket", {}, { requestId: "r2", idempotencyKey: "k2" });
    expect(reply.ok).toBe(false);
    expect(reply.errorCode).toBe(MT5_BRIDGE_UNHEALTHY);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
