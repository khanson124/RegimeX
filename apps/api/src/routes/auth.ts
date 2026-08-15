import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { type FastifyInstance } from "fastify";
import {
  AuthenticationError,
  ConflictError,
  loginSchema,
  refreshSchema,
  registerSchema
} from "@regimex/shared";
import { type AppContext } from "../context.js";
import { sha256hex } from "../lib/crypto.js";
import { requireAuth } from "../plugins/auth.js";

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma, tokens } = ctx;

  async function issueTokenPair(userId: string, familyId?: string) {
    const { token: refreshToken, expiresAt } = tokens.generateRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256hex(refreshToken),
        familyId: familyId ?? randomUUID(),
        expiresAt
      }
    });
    return {
      accessToken: tokens.signAccessToken(userId),
      refreshToken,
      expiresIn: tokens.accessTtlSeconds
    };
  }

  app.post(
    "/auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      const existing = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
      if (existing) throw new ConflictError("An account with this email already exists");

      const user = await prisma.user.create({
        data: {
          email: body.email.toLowerCase(),
          passwordHash: await argon2.hash(body.password)
        }
      });
      const pair = await issueTokenPair(user.id);
      return reply.status(201).send({ user: { id: user.id, email: user.email }, ...pair });
    }
  );

  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request) => {
      const body = loginSchema.parse(request.body);
      const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() } });
      // Constant-shape failure: same error whether user exists or not.
      if (!user || user.status !== "ACTIVE") {
        throw new AuthenticationError("Invalid email or password");
      }
      const valid = await argon2.verify(user.passwordHash, body.password);
      if (!valid) throw new AuthenticationError("Invalid email or password");

      const pair = await issueTokenPair(user.id);
      return { user: { id: user.id, email: user.email }, ...pair };
    }
  );

  app.post(
    "/auth/refresh",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const body = refreshSchema.parse(request.body);
      const tokenHash = sha256hex(body.refreshToken);
      const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

      if (!stored) throw new AuthenticationError("Invalid refresh token");

      if (stored.revokedAt) {
        // Reuse of a rotated token → revoke the whole family (theft signal).
        await prisma.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: new Date() }
        });
        throw new AuthenticationError("Refresh token reuse detected; session revoked");
      }
      if (stored.expiresAt < new Date()) {
        throw new AuthenticationError("Refresh token expired");
      }

      // Rotate: revoke the old token, issue a new one in the same family.
      const pair = await issueTokenPair(stored.userId, stored.familyId);
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date(), replacedBy: sha256hex(pair.refreshToken) }
      });
      return pair;
    }
  );

  app.post("/auth/logout", { preHandler: requireAuth(ctx) }, async (request) => {
    const body = refreshSchema.safeParse(request.body);
    if (body.success) {
      const stored = await prisma.refreshToken.findUnique({
        where: { tokenHash: sha256hex(body.data.refreshToken) }
      });
      if (stored && stored.userId === request.userId) {
        await prisma.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: new Date() }
        });
      }
    }
    return { success: true };
  });

  app.get("/auth/me", { preHandler: requireAuth(ctx) }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.userId },
      select: { id: true, email: true, createdAt: true }
    });
    if (!user) throw new AuthenticationError("User not found");
    return { user };
  });
}
