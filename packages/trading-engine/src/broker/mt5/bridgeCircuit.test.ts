import { describe, expect, it } from "vitest";
import {
  Mt5BridgeCircuitBreaker,
  MT5_BRIDGE_TIMEOUT,
  MT5_BRIDGE_UNHEALTHY
} from "./bridgeCircuit.js";

describe("Mt5BridgeCircuitBreaker", () => {
  it("opens after N consecutive failures and skips requests during cooldown", () => {
    let now = 1_000;
    const transitions: string[] = [];
    const circuit = new Mt5BridgeCircuitBreaker({
      failureThreshold: 3,
      openMs: 30_000,
      now: () => now,
      onTransition: (from, to) => transitions.push(`${from}->${to}`)
    });

    expect(circuit.allowRequest()).toBe(true);
    circuit.recordFailure(MT5_BRIDGE_TIMEOUT);
    circuit.recordFailure(MT5_BRIDGE_TIMEOUT);
    expect(circuit.snapshot().circuitState).toBe("CLOSED");
    circuit.recordFailure(MT5_BRIDGE_TIMEOUT);
    expect(circuit.snapshot().circuitState).toBe("OPEN");
    expect(circuit.allowRequest()).toBe(false);
    expect(transitions).toEqual(["CLOSED->OPEN"]);

    now += 29_000;
    expect(circuit.allowRequest()).toBe(false);

    now += 2_000;
    expect(circuit.allowRequest()).toBe(true);
    expect(circuit.snapshot().circuitState).toBe("HALF_OPEN");
    expect(circuit.allowRequest()).toBe(false);
    expect(transitions).toEqual(["CLOSED->OPEN", "OPEN->HALF_OPEN"]);
  });

  it("successful health probe closes the circuit", () => {
    let now = 0;
    const circuit = new Mt5BridgeCircuitBreaker({
      failureThreshold: 2,
      openMs: 10,
      now: () => now
    });
    circuit.recordFailure();
    circuit.recordFailure();
    expect(circuit.snapshot().circuitState).toBe("OPEN");
    now = 20;
    expect(circuit.allowRequest()).toBe(true);
    circuit.recordSuccess();
    expect(circuit.snapshot().circuitState).toBe("CLOSED");
    expect(circuit.snapshot().consecutiveFailures).toBe(0);
    expect(circuit.allowRequest()).toBe(true);
  });

  it("open circuit maps to MT5_BRIDGE_UNHEALTHY skip rather than a new fetch", () => {
    const circuit = new Mt5BridgeCircuitBreaker({ failureThreshold: 1, openMs: 60_000 });
    circuit.recordFailure(MT5_BRIDGE_TIMEOUT);
    expect(circuit.allowRequest()).toBe(false);
    expect(circuit.snapshot().lastFailureCode).toBe(MT5_BRIDGE_TIMEOUT);
    expect(MT5_BRIDGE_UNHEALTHY).toBe("MT5_BRIDGE_UNHEALTHY");
  });
});
