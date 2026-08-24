import { describe, expect, it } from "vitest";
import { extractWsAccessToken } from "./wsAuth.js";

describe("extractWsAccessToken", () => {
  it("prefers Authorization Bearer over query token", () => {
    expect(
      extractWsAccessToken({
        headers: { authorization: "Bearer header-jwt" },
        query: { token: "query-jwt" }
      })
    ).toBe("header-jwt");
  });

  it("falls back to query token for mobile WebSocket clients", () => {
    expect(
      extractWsAccessToken({
        headers: {},
        query: { token: "query-jwt" }
      })
    ).toBe("query-jwt");
  });

  it("returns undefined when neither is present", () => {
    expect(extractWsAccessToken({ headers: {}, query: {} })).toBeUndefined();
  });
});
