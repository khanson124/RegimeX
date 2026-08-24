import { describe, expect, it } from "vitest";
import { redactSensitiveObject, redactSensitiveUrl } from "./redactSecrets.js";

describe("secret redaction", () => {
  it("redacts JWT query tokens from WebSocket URLs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFBPJVAb77s";
    expect(redactSensitiveUrl(`/ws?token=${jwt}`)).toBe("/ws?token=[REDACTED]");
    expect(redactSensitiveUrl(`/ws?token=${jwt}`)).not.toContain("eyJ");
  });

  it("redacts bearer tokens and MT5 secrets from objects", () => {
    const out = redactSensitiveObject({
      url: "/ws?token=abc.def.ghi",
      authorization: "Bearer abc.def.ghi",
      password: "mt5-pass",
      bridgeSecret: "super-secret-value",
      nested: { apiToken: "deriv-token" }
    }) as Record<string, unknown>;
    expect(out.url).toBe("/ws?token=[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.bridgeSecret).toBe("[REDACTED]");
    expect((out.nested as { apiToken: string }).apiToken).toBe("[REDACTED]");
  });
});
