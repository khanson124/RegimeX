import { type FastifyInstance } from "fastify";
import { NotFoundError, symbolPatchSchema } from "@regimex/shared";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerSymbolRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = requireAuth(ctx);

  app.get("/symbols", { preHandler: auth }, async () => {
    const symbols = await ctx.prisma.symbol.findMany({ orderBy: { derivSymbol: "asc" } });
    return { symbols };
  });

  app.patch("/symbols/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = symbolPatchSchema.parse(request.body);
    const existing = await ctx.prisma.symbol.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Symbol");
    const symbol = await ctx.prisma.symbol.update({ where: { id }, data: body });
    return { symbol };
  });
}
