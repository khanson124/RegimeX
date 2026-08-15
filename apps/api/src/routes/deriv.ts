import { type FastifyInstance } from "fastify";
import { derivConnectSchema, NotFoundError, ValidationError } from "@regimex/shared";
import { verifyDerivToken } from "@regimex/trading-engine";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerDerivRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma, credentialCrypto, config } = ctx;
  const auth = requireAuth(ctx);

  /**
   * Connect a Deriv demo API token. The token is verified against Deriv,
   * must belong to a virtual account, is encrypted before storage, and is
   * never returned to the client afterwards.
   */
  app.post(
    "/deriv/connect",
    { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = derivConnectSchema.parse(request.body);

      const info = await verifyDerivToken(config.DERIV_WS_URL, config.DERIV_APP_ID, body.apiToken);
      if (!info.isVirtual) {
        throw new ValidationError(
          "Only demo (virtual) account tokens are accepted. Live-money trading is disabled."
        );
      }

      // Replace any existing credential for this user.
      await prisma.derivCredential.updateMany({
        where: { userId: request.userId, status: "ACTIVE" },
        data: { status: "REVOKED", deletedAt: new Date() }
      });

      const credential = await prisma.derivCredential.create({
        data: {
          userId: request.userId,
          encryptedToken: credentialCrypto.encrypt(body.apiToken)
        }
      });

      const account = await prisma.tradingAccount.upsert({
        where: { userId_derivLoginId: { userId: request.userId, derivLoginId: info.loginId } },
        create: {
          userId: request.userId,
          derivCredentialId: credential.id,
          derivLoginId: info.loginId,
          isVirtual: info.isVirtual,
          currency: info.currency,
          lastKnownBalance: info.balance,
          balanceUpdatedAt: new Date()
        },
        update: {
          derivCredentialId: credential.id,
          isVirtual: info.isVirtual,
          currency: info.currency,
          lastKnownBalance: info.balance,
          balanceUpdatedAt: new Date(),
          status: "ACTIVE"
        }
      });

      return reply.status(201).send({
        account: {
          id: account.id,
          loginId: account.derivLoginId,
          isVirtual: account.isVirtual,
          currency: account.currency,
          balance: Number(account.lastKnownBalance)
        }
      });
    }
  );

  app.get("/deriv/account", { preHandler: auth }, async (request) => {
    const account = await prisma.tradingAccount.findFirst({
      where: { userId: request.userId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" }
    });
    if (!account) return { account: null };
    return {
      account: {
        id: account.id,
        loginId: account.derivLoginId,
        isVirtual: account.isVirtual,
        currency: account.currency,
        balance: account.lastKnownBalance !== null ? Number(account.lastKnownBalance) : null,
        balanceUpdatedAt: account.balanceUpdatedAt
      }
    };
  });

  app.delete("/deriv/disconnect", { preHandler: auth }, async (request) => {
    await prisma.derivCredential.updateMany({
      where: { userId: request.userId, status: "ACTIVE" },
      data: { status: "REVOKED", deletedAt: new Date() }
    });
    await prisma.tradingAccount.updateMany({
      where: { userId: request.userId },
      data: { status: "DISCONNECTED" }
    });
    return { success: true };
  });

  /** Re-verify the stored token against Deriv without exposing it. */
  app.post(
    "/deriv/test-connection",
    { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request) => {
      const credential = await prisma.derivCredential.findFirst({
        where: { userId: request.userId, status: "ACTIVE" },
        orderBy: { createdAt: "desc" }
      });
      if (!credential) throw new NotFoundError("Deriv credential");

      const token = credentialCrypto.decrypt(credential.encryptedToken);
      const info = await verifyDerivToken(config.DERIV_WS_URL, config.DERIV_APP_ID, token);

      await prisma.tradingAccount.updateMany({
        where: { userId: request.userId, derivLoginId: info.loginId },
        data: { lastKnownBalance: info.balance, balanceUpdatedAt: new Date() }
      });

      return {
        connected: true,
        loginId: info.loginId,
        isVirtual: info.isVirtual,
        currency: info.currency,
        balance: info.balance
      };
    }
  );
}
