import { describe, expect, it, vi } from "vitest";
import { createWatchdogLoop, evaluateWatchdogTick } from "./watchdog.js";

describe("mt5-bridge watchdog", () => {
  it("terminates after a sustained live-health failure streak", () => {
    expect(evaluateWatchdogTick(0, true, 3)).toEqual({ consecutiveFailures: 0, shouldTerminate: false });
    expect(evaluateWatchdogTick(2, false, 3)).toEqual({ consecutiveFailures: 3, shouldTerminate: true });
  });

  it("self-termination path fires once after threshold probes fail", async () => {
    const terminate = vi.fn();
    const loop = createWatchdogLoop({
      probe: async () => false,
      terminate,
      failureThreshold: 3
    });
    expect(await loop.tick()).toBe(false);
    expect(await loop.tick()).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
    expect(await loop.tick()).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(await loop.tick()).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
