import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Credential encryption service (AES-256-GCM), shared by API and worker.
 * Ciphertext format: base64(iv):base64(authTag):base64(data).
 * The key is derived from CREDENTIAL_ENCRYPTION_KEY via SHA-256 so any
 * sufficiently long secret works.
 */
export class CredentialCrypto {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters");
    }
    this.key = createHash("sha256").update(secret).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
  }

  decrypt(ciphertext: string): string {
    const [ivB64, tagB64, dataB64] = ciphertext.split(":");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final()
    ]).toString("utf8");
  }
}

/** SHA-256 hex hash used for refresh-token storage (tokens are never stored raw). */
export function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
