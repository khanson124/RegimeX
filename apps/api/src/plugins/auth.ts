import { type FastifyReply, type FastifyRequest } from "fastify";
import { AuthenticationError } from "@regimex/shared";
import { type AppContext } from "../context.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

/** preHandler that requires a valid Bearer access token. */
export function requireAuth(ctx: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new AuthenticationError("Missing bearer token");
    }
    const payload = ctx.tokens.verifyAccessToken(header.slice(7));
    request.userId = payload.sub;
  };
}
