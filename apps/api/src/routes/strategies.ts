import { type FastifyInstance } from "fastify";
import {
  NotFoundError,
  strategyCreateSchema,
  strategyPatchSchema,
  ValidationError,
  type StrategyKind
} from "@regimex/shared";
import { createStrategy, STRATEGY_CATALOGUE } from "@regimex/trading-engine";
import { type AppContext } from "../context.js";
import { requireAuth } from "../plugins/auth.js";

export function registerStrategyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { prisma } = ctx;
  const auth = requireAuth(ctx);

  /** System strategies (userId null) + the user's own. */
  const visibleWhere = (userId: string) => ({
    deletedAt: null,
    OR: [{ userId: null }, { userId }]
  });

  function serialize(definition: {
    id: string;
    kind: string;
    name: string;
    description: string;
    enabled: boolean;
    userId: string | null;
    updatedAt: Date;
    versions: Array<{
      version: string;
      isActive: boolean;
      parameterSets: Array<{ id: string; parameters: unknown; isActive: boolean; origin: string }>;
    }>;
  }) {
    const activeVersion = definition.versions.find((v) => v.isActive);
    const activeParams = activeVersion?.parameterSets.find((p) => p.isActive);
    const impl = createStrategy(definition.kind as StrategyKind);
    return {
      id: definition.id,
      kind: definition.kind,
      name: definition.name,
      description: definition.description,
      enabled: definition.enabled,
      isSystem: definition.userId === null,
      version: activeVersion?.version ?? "1",
      parameters: activeParams?.parameters ?? {},
      parametersOrigin: activeParams?.origin ?? "SEED",
      supportedRegimes: impl.supportedRegimes,
      minimumHistory: impl.minimumHistory,
      eligibility: impl.eligibility,
      updatedAt: definition.updatedAt
    };
  }

  const include = {
    versions: { include: { parameterSets: true } }
  } as const;

  app.get("/strategies", { preHandler: auth }, async (request) => {
    const definitions = await prisma.strategyDefinition.findMany({
      where: visibleWhere(request.userId),
      include,
      orderBy: { createdAt: "asc" }
    });
    return { strategies: definitions.map(serialize), catalogue: STRATEGY_CATALOGUE };
  });

  app.get("/strategies/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const definition = await prisma.strategyDefinition.findFirst({
      where: { id, ...visibleWhere(request.userId) },
      include
    });
    if (!definition) throw new NotFoundError("Strategy");
    return { strategy: serialize(definition) };
  });

  app.post("/strategies", { preHandler: auth }, async (request, reply) => {
    const body = strategyCreateSchema.parse(request.body);
    const impl = createStrategy(body.kind);
    let validated: Record<string, number | boolean | string>;
    try {
      validated = impl.validateParameters(body.parameters);
    } catch (err) {
      throw new ValidationError(`Invalid parameters: ${err instanceof Error ? err.message : "unknown"}`);
    }

    const definition = await prisma.strategyDefinition.create({
      data: {
        userId: request.userId,
        kind: body.kind,
        name: body.name,
        description: body.description ?? "",
        versions: {
          create: {
            version: "1",
            isActive: true,
            parameterSets: { create: { parameters: validated, isActive: true, origin: "MANUAL" } }
          }
        }
      },
      include
    });
    return reply.status(201).send({ strategy: serialize(definition) });
  });

  app.patch("/strategies/:id", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    const body = strategyPatchSchema.parse(request.body);

    // Only user-owned strategies can be edited; system strategies must be cloned.
    const definition = await prisma.strategyDefinition.findFirst({
      where: { id, userId: request.userId, deletedAt: null },
      include
    });
    if (!definition) throw new NotFoundError("Editable strategy");

    if (body.parameters) {
      const impl = createStrategy(definition.kind as StrategyKind);
      let validated: Record<string, number | boolean | string>;
      try {
        validated = impl.validateParameters(body.parameters);
      } catch (err) {
        throw new ValidationError(`Invalid parameters: ${err instanceof Error ? err.message : "unknown"}`);
      }
      const activeVersion = definition.versions.find((v) => v.isActive);
      if (activeVersion) {
        await prisma.strategyParameterSet.updateMany({
          where: { strategyVersion: { definitionId: id }, isActive: true },
          data: { isActive: false }
        });
        await prisma.strategyParameterSet.create({
          data: {
            strategyVersion: { connect: { definitionId_version: { definitionId: id, version: activeVersion.version } } },
            parameters: validated,
            isActive: true,
            origin: "MANUAL"
          }
        });
      }
    }

    const updated = await prisma.strategyDefinition.update({
      where: { id },
      data: {
        name: body.name ?? undefined,
        description: body.description ?? undefined
      },
      include
    });
    return { strategy: serialize(updated) };
  });

  async function setEnabled(id: string, userId: string, enabled: boolean) {
    const definition = await prisma.strategyDefinition.findFirst({
      where: { id, deletedAt: null, OR: [{ userId: null }, { userId }] }
    });
    if (!definition) throw new NotFoundError("Strategy");
    // System strategy enable/disable is global in the MVP (single-tenant deployments).
    return prisma.strategyDefinition.update({ where: { id }, data: { enabled }, include });
  }

  app.post("/strategies/:id/enable", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    return { strategy: serialize(await setEnabled(id, request.userId, true)) };
  });

  app.post("/strategies/:id/disable", { preHandler: auth }, async (request) => {
    const { id } = request.params as { id: string };
    return { strategy: serialize(await setEnabled(id, request.userId, false)) };
  });

  app.post("/strategies/:id/clone", { preHandler: auth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const source = await prisma.strategyDefinition.findFirst({
      where: { id, ...visibleWhere(request.userId) },
      include
    });
    if (!source) throw new NotFoundError("Strategy");
    const activeVersion = source.versions.find((v) => v.isActive);
    const activeParams = activeVersion?.parameterSets.find((p) => p.isActive);

    const clone = await prisma.strategyDefinition.create({
      data: {
        userId: request.userId,
        kind: source.kind,
        name: `${source.name} (copy)`,
        description: source.description,
        versions: {
          create: {
            version: "1",
            isActive: true,
            parameterSets: {
              create: {
                parameters: activeParams?.parameters ?? {},
                isActive: true,
                origin: "MANUAL"
              }
            }
          }
        }
      },
      include
    });
    return reply.status(201).send({ strategy: serialize(clone) });
  });
}
