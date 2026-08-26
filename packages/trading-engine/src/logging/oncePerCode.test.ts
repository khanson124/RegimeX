import { describe, expect, it } from "vitest";
import { OncePerCodeLogger } from "./oncePerCode.js";

describe("OncePerCodeLogger", () => {
  it("does not flood the same heartbeat error", () => {
    const log = new OncePerCodeLogger();
    let writes = 0;
    expect(log.emit("MT5_BRIDGE_TIMEOUT", () => writes++)).toBe(true);
    expect(log.emit("MT5_BRIDGE_TIMEOUT", () => writes++)).toBe(false);
    expect(log.emit("MT5_BRIDGE_TIMEOUT", () => writes++)).toBe(false);
    expect(writes).toBe(1);
    expect(log.emit("MT5_EA_OFFLINE", () => writes++)).toBe(true);
    expect(writes).toBe(2);
    expect(log.reset("OK")).toBe(true);
    expect(log.emit("MT5_BRIDGE_TIMEOUT", () => writes++)).toBe(true);
    expect(writes).toBe(3);
  });
});
