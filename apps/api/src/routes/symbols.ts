import { type FastifyInstance } from "fastify";
import { NotFoundError, instrumentMetadataUpsertSchema, symbolPatchSchema } from "@regimex/shared";
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

  app.put("/symbols/:id/instrument-metadata", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = instrumentMetadataUpsertSchema.parse(request.body);
    const existing = await ctx.prisma.symbol.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Symbol");

    const row = await ctx.prisma.instrumentMetadata.upsert({
      where: { symbolId: id },
      create: { symbolId: id, ...body },
      update: body
    });
    return { instrumentMetadata: row, symbol: existing.derivSymbol };
  });

  app.get("/symbols/:id/instrument-metadata", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await ctx.prisma.symbol.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError("Symbol");
    const row = await ctx.prisma.instrumentMetadata.findUnique({ where: { symbolId: id } });
    return { instrumentMetadata: row };
  });
}
