import { describe, expect, it } from "vitest";
import { TokenService } from "./tokens.js";

const service = new TokenService({
  accessSecret: "access-secret-that-is-long-enough-123456",
  refreshSecret: "refresh-secret-that-is-long-enough-12345",
  accessTtlSeconds: 900,
  refreshTtlSeconds: 3600
});

describe("TokenService", () => {
  it("signs and verifies access tokens", () => {
    const token = service.signAccessToken("user-1");
    const payload = service.verifyAccessToken(token);
    expect(payload.sub).toBe("user-1");
  });

  it("rejects tampered tokens", () => {
    const token = service.signAccessToken("user-1");
    expect(() => service.verifyAccessToken(token + "x")).toThrow();
  });

  it("rejects tokens signed with a different secret", () => {
    const other = new TokenService({
      accessSecret: "another-secret-that-is-long-enough-9999",
      refreshSecret: "refresh",
      accessTtlSeconds: 900,
      refreshTtlSeconds: 3600
    });
    const token = other.signAccessToken("user-1");
    expect(() => service.verifyAccessToken(token)).toThrow();
  });

  it("generates high-entropy refresh tokens with expiry", () => {
    const a = service.generateRefreshToken();
    const b = service.generateRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThan(40);
    expect(a.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
