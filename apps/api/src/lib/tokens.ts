import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { AuthenticationError } from "@regimex/shared";

export interface AccessTokenPayload {
  sub: string;
  type: "access";
}

export interface TokenServiceOptions {
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export class TokenService {
  constructor(private readonly options: TokenServiceOptions) {}

  signAccessToken(userId: string): string {
    return jwt.sign({ type: "access" }, this.options.accessSecret, {
      subject: userId,
      expiresIn: this.options.accessTtlSeconds
    });
  }

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      const decoded = jwt.verify(token, this.options.accessSecret) as jwt.JwtPayload;
      if (decoded.type !== "access" || typeof decoded.sub !== "string") {
        throw new AuthenticationError("Invalid token");
      }
      return { sub: decoded.sub, type: "access" };
    } catch (err) {
      if (err instanceof AuthenticationError) throw err;
      throw new AuthenticationError("Invalid or expired access token");
    }
  }

  /** Opaque, high-entropy refresh token. Stored hashed only. */
  generateRefreshToken(): { token: string; expiresAt: Date } {
    return {
      token: randomBytes(48).toString("base64url"),
      expiresAt: new Date(Date.now() + this.options.refreshTtlSeconds * 1000)
    };
  }

  get accessTtlSeconds(): number {
    return this.options.accessTtlSeconds;
  }
}
