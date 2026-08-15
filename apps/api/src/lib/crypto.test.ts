import { describe, expect, it } from "vitest";
import { CredentialCrypto, sha256hex } from "./crypto.js";

const SECRET = "a".repeat(32);

describe("CredentialCrypto", () => {
  it("round-trips plaintext", () => {
    const crypto = new CredentialCrypto(SECRET);
    const token = "deriv-demo-token-abc123";
    const encrypted = crypto.encrypt(token);
    expect(encrypted).not.toContain(token);
    expect(crypto.decrypt(encrypted)).toBe(token);
  });

  it("produces unique ciphertexts per call (random IV)", () => {
    const crypto = new CredentialCrypto(SECRET);
    expect(crypto.encrypt("x")).not.toBe(crypto.encrypt("x"));
  });

  it("rejects tampered ciphertext", () => {
    const crypto = new CredentialCrypto(SECRET);
    const encrypted = crypto.encrypt("secret");
    const parts = encrypted.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${Buffer.from("evil").toString("base64")}`;
    expect(() => crypto.decrypt(tampered)).toThrow();
  });

  it("rejects short keys", () => {
    expect(() => new CredentialCrypto("short")).toThrow();
  });

  it("cannot decrypt with a different key", () => {
    const a = new CredentialCrypto(SECRET);
    const b = new CredentialCrypto("b".repeat(32));
    expect(() => b.decrypt(a.encrypt("secret"))).toThrow();
  });
});

describe("sha256hex", () => {
  it("is deterministic", () => {
    expect(sha256hex("token")).toBe(sha256hex("token"));
    expect(sha256hex("token")).toHaveLength(64);
  });
});
