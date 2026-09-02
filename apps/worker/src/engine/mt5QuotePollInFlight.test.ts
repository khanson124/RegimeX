import { describe, expect, it, vi } from "vitest";
import { Mt5QuotePollInFlightGate } from "./mt5QuotePollInFlight.js";

describe("Mt5QuotePollInFlightGate", () => {
  it("allows only one concurrent poll", async () => {
    const gate = new Mt5QuotePollInFlightGate();
    expect(gate.tryAcquire()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);
    expect(gate.isInFlight).toBe(true);
  });

  it("allows a later poll after release", async () => {
    const gate = new Mt5QuotePollInFlightGate();
    expect(gate.tryAcquire()).toBe(true);
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
    gate.release();
    expect(gate.isInFlight).toBe(false);
  });

  it("releases after a failed poll simulation", async () => {
    const gate = new Mt5QuotePollInFlightGate();
    const getQuote = vi.fn(async () => {
      throw new Error("MT5_BRIDGE_TIMEOUT");
    });

    expect(gate.tryAcquire()).toBe(true);
    try {
      await getQuote();
    } catch {
      // expected
    } finally {
      gate.release();
    }

    expect(gate.isInFlight).toBe(false);
    expect(gate.tryAcquire()).toBe(true);
    gate.release();
  });

  it("serializes overlapping timer ticks while one poll is slow", async () => {
    const gate = new Mt5QuotePollInFlightGate();
    let concurrent = 0;
    let maxConcurrent = 0;

    const slowPoll = async () => {
      if (!gate.tryAcquire()) return "skipped";
      try {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        return "done";
      } finally {
        concurrent--;
        gate.release();
      }
    };

    const results = await Promise.all([slowPoll(), slowPoll(), slowPoll(), slowPoll()]);
    expect(maxConcurrent).toBe(1);
    expect(results.filter((r) => r === "skipped").length).toBe(3);
    expect(results.filter((r) => r === "done").length).toBe(1);
  });
});
