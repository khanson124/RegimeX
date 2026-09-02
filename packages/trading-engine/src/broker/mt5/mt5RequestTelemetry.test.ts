import { describe, expect, it, afterEach } from "vitest";
import {
  emitMt5Telemetry,
  sanitizeMt5TelemetryPayload,
  setMt5TelemetrySink
} from "./mt5RequestTelemetry.js";

describe("mt5RequestTelemetry", () => {
  afterEach(() => {
    setMt5TelemetrySink(null);
  });

  it("preserves request correlation fields", () => {
    const events: Record<string, unknown>[] = [];
    setMt5TelemetrySink((payload) => events.push(payload));

    emitMt5Telemetry({
      event: "mt5_request_start",
      phase: "worker",
      command: "getQuote",
      requestId: "quote:abc",
      idempotencyKey: "quote"
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "mt5_request_start",
      command: "getQuote",
      requestId: "quote:abc",
      idempotencyKey: "quote"
    });
    expect(typeof events[0]!.ts).toBe("number");
  });

  it("strips secret and auth fields", () => {
    const sanitized = sanitizeMt5TelemetryPayload({
      event: "mt5_bridge_request_received",
      command: "getQuote",
      secret: "super-secret",
      authorization: "Bearer token",
      authHmac: "deadbeef",
      bridgeSecret: "nope",
      requestId: "r1"
    });

    expect(sanitized).toMatchObject({
      event: "mt5_bridge_request_received",
      command: "getQuote",
      requestId: "r1"
    });
    expect(sanitized).not.toHaveProperty("secret");
    expect(sanitized).not.toHaveProperty("authorization");
    expect(sanitized).not.toHaveProperty("authHmac");
    expect(sanitized).not.toHaveProperty("bridgeSecret");
  });
});
