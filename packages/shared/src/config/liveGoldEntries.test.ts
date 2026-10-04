import { describe, expect, it } from "vitest";
import { isLiveGoldEntryPermissionEnabled, liveGoldEntryPermissionKey } from "./liveGoldEntries.js";
describe("LIVE Gold permission", () => {
  it("accepts only the explicit enabled state and isolates users", () => {
    expect(isLiveGoldEntryPermissionEnabled("enabled")).toBe(true);
    expect(liveGoldEntryPermissionKey("u1")).not.toBe(liveGoldEntryPermissionKey("u2"));
  });
  it.each([null, undefined, "", "disabled", "true", "false", "1", "enabled ", "ENABLED"])("defaults OFF for %s", (raw) => {
    expect(isLiveGoldEntryPermissionEnabled(raw)).toBe(false);
  });
});
