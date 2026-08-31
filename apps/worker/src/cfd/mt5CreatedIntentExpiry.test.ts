import { describe, expect, it, vi } from "vitest";
import {
  CREATED_INTENT_RESUME_TTL_MS,
  EXECUTION_INTENT_EXPIRED,
  regimeXOrderComment
} from "@regimex/trading-engine";
import { type OpenMarketPositionResult } from "@regimex/shared";
import {
  expireStaleCreatedExecutionIntents,
  shouldRunCreatedIntentExpirySweep,
  CREATED_INTENT_EXPIRY_SWEEP_INTERVAL_MS
} from "./mt5CreatedIntentExpiry.js";
import { countMt5ConsumedCapacitySlots } from "./mt5ExecutionIntegrity.js";

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => mockLogger() } as never;
}

function brokerOpen(idempotencyKey: string): OpenMarketPositionResult {
  return {
    accepted: true,
    brokerPositionId: "5760099999",
    entryPrice: 4771.2,
    appliedSpreadBps: 0,
    appliedSlippageBps: 0,
    rejectionReasons: [],
    position: {
      brokerPositionId: "5760099999",
      idempotencyKey,
      symbol: "Volatility 10 Index",
      direction: "SELL",
      volume: 0.5,
      entryPrice: 4771.2,
      currentPrice: 4771.2,
      stopLoss: 4772,
      takeProfit: 4769,
      status: "OPEN",
      floatingPnl: 0,
      riskAmount: 10,
      riskPercent: 1,
      initialRiskReward: 2,
      appliedSpreadBps: 0,
      appliedSlippageBps: 0,
      marginUsed: 0,
      openedAt: Date.now(),
      metadata: { comment: regimeXOrderComment(idempotencyKey), magic: 26082301 }
    }
  };
}

function buildPrisma() {
  const intents = new Map<string, Record<string, unknown>>();
  const positions = new Map<string, Record<string, unknown>>();

  return {
    intents,
    positions,
    executionIntent: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; state: string; submittedAt: null; createdAt: { lt: Date } } }) =>
        [...intents.values()].filter(
          (r) =>
            r.userId === where.userId &&
            r.state === where.state &&
            r.submittedAt == null &&
            r.createdAt instanceof Date &&
            r.createdAt < where.createdAt.lt
        )
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; signalId?: string } }) => {
        if (where.id) return [...intents.values()].find((i) => i.id === where.id) ?? null;
        if (where.signalId) return intents.get(where.signalId) ?? null;
        return null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = [...intents.values()].find((i) => i.id === where.id);
        if (!row) throw new Error("missing");
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data
        }: {
          where: { id: string; state?: string; submittedAt?: null };
          data: Record<string, unknown>;
        }) => {
          const row = [...intents.values()].find((i) => i.id === where.id);
          if (!row) return { count: 0 };
          if (where.state && row.state !== where.state) return { count: 0 };
          if (where.submittedAt === null && row.submittedAt != null) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
      )
    },
    position: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => positions.get(where.id) ?? null),
      count: vi.fn(async ({ where }: { where: { userId: string; origin: string; status: { in: string[] } } }) =>
        [...positions.values()].filter(
          (p) =>
            p.userId === where.userId &&
            p.origin === where.origin &&
            where.status.in.includes(String(p.status))
        ).length
      ),
      updateMany: vi.fn(
        async ({
          where,
          data
        }: {
          where: { id: string; status?: { in: string[] } };
          data: Record<string, unknown>;
        }) => {
          const row = positions.get(where.id);
          if (!row) return { count: 0 };
          if (where.status && !where.status.in.includes(String(row.status))) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
      )
    },
    signal: { update: vi.fn(async () => ({})) },
    positionEvent: { create: vi.fn(async () => ({})) },
    seedCreated(opts: {
      signalId: string;
      createdAt: Date;
      submittedAt?: Date | null;
      state?: string;
      status?: string;
    }) {
      const posId = `pos-${opts.signalId}`;
      positions.set(posId, {
        id: posId,
        userId: "u1",
        origin: "ENGINE",
        status: opts.status ?? "PENDING",
        symbol: "R_10",
        signalId: opts.signalId
      });
      intents.set(opts.signalId, {
        id: `intent-${opts.signalId}`,
        userId: "u1",
        signalId: opts.signalId,
        positionId: posId,
        idempotencyKey: `signal:${opts.signalId}`,
        brokerSymbol: "Volatility 10 Index",
        internalSymbol: "R_10",
        direction: "SELL",
        requestedVolume: 0.5,
        requestedStopLoss: 4772,
        requestedTakeProfit: 4769,
        strategyId: "ema-pullback-v1",
        state: opts.state ?? "CREATED",
        submittedAt: opts.submittedAt === undefined ? null : opts.submittedAt,
        createdAt: opts.createdAt
      });
    }
  };
}

function adapterBase(overrides: Record<string, unknown> = {}) {
  return {
    getQuote: vi.fn(async () => ({
      symbol: "Volatility 10 Index",
      bid: 4771,
      ask: 4771.2,
      mid: 4771.1,
      timestamp: Date.now()
    })),
    getInstrumentMetadata: vi.fn(async () => ({
      symbol: "Volatility 10 Index",
      enabled: true,
      verified: true,
      tickSize: 0.001,
      pricePrecision: 3
    })),
    tryAdoptOpenByIdempotency: vi.fn(async () => null),
    openMarketPosition: vi.fn(),
    ...overrides
  };
}

describe("expireStaleCreatedExecutionIntents", () => {
  it("A. expired never-submitted CREATED releases capacity", async () => {
    const prisma = buildPrisma();
    prisma.seedCreated({
      signalId: "sig-old",
      createdAt: new Date(Date.now() - CREATED_INTENT_RESUME_TTL_MS - 60_000)
    });
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(1);

    const result = await expireStaleCreatedExecutionIntents({
      prisma: prisma as never,
      adapter: adapterBase() as never,
      userId: "u1",
      logger: mockLogger()
    });

    expect(result.expired).toBe(1);
    expect(prisma.intents.get("sig-old")?.state).toBe("REJECTED");
    expect(prisma.intents.get("sig-old")?.lastErrorCode).toBe(EXECUTION_INTENT_EXPIRED);
    expect(prisma.positions.get("pos-sig-old")?.status).toBe("REJECTED");
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(0);
  });

  it("B. fresh CREATED remains reserved", async () => {
    const prisma = buildPrisma();
    prisma.seedCreated({ signalId: "sig-fresh", createdAt: new Date() });
    const result = await expireStaleCreatedExecutionIntents({
      prisma: prisma as never,
      adapter: adapterBase() as never,
      userId: "u1",
      logger: mockLogger()
    });
    expect(result.examined).toBe(0);
    expect(result.expired).toBe(0);
    expect(prisma.intents.get("sig-fresh")?.state).toBe("CREATED");
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(1);
  });

  it("C. SUBMITTED is never TTL-expired", async () => {
    const prisma = buildPrisma();
    prisma.seedCreated({
      signalId: "sig-sub",
      createdAt: new Date(Date.now() - CREATED_INTENT_RESUME_TTL_MS - 60_000),
      state: "SUBMITTED",
      submittedAt: new Date()
    });
    // findMany filters state=CREATED only — SUBMITTED never returned
    const result = await expireStaleCreatedExecutionIntents({
      prisma: prisma as never,
      adapter: adapterBase() as never,
      userId: "u1",
      logger: mockLogger()
    });
    expect(result.examined).toBe(0);
    expect(prisma.intents.get("sig-sub")?.state).toBe("SUBMITTED");
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(1);
  });

  it("D. AMBIGUOUS is never TTL-expired", async () => {
    const prisma = buildPrisma();
    prisma.seedCreated({
      signalId: "sig-amb",
      createdAt: new Date(Date.now() - CREATED_INTENT_RESUME_TTL_MS - 60_000),
      state: "AMBIGUOUS",
      submittedAt: new Date()
    });
    const result = await expireStaleCreatedExecutionIntents({
      prisma: prisma as never,
      adapter: adapterBase() as never,
      userId: "u1",
      logger: mockLogger()
    });
    expect(result.examined).toBe(0);
    expect(prisma.intents.get("sig-amb")?.state).toBe("AMBIGUOUS");
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(1);
  });

  it("E. broker match before expiry is adopted instead of rejected", async () => {
    const prisma = buildPrisma();
    prisma.seedCreated({
      signalId: "sig-adopt",
      createdAt: new Date(Date.now() - CREATED_INTENT_RESUME_TTL_MS - 60_000)
    });
    const adapter = adapterBase({
      tryAdoptOpenByIdempotency: vi.fn(async () => brokerOpen("signal:sig-adopt"))
    });
    const result = await expireStaleCreatedExecutionIntents({
      prisma: prisma as never,
      adapter: adapter as never,
      userId: "u1",
      logger: mockLogger()
    });
    expect(result.recovered).toBe(1);
    expect(result.expired).toBe(0);
    expect(adapter.openMarketPosition).not.toHaveBeenCalled();
    expect(prisma.positions.get("pos-sig-adopt")?.status).toBe("OPEN");
  });

  it("F. repeated cleanup is idempotent", async () => {
    const prisma = buildPrisma();
    prisma.seedCreated({
      signalId: "sig-idem",
      createdAt: new Date(Date.now() - CREATED_INTENT_RESUME_TTL_MS - 60_000)
    });
    const adapter = adapterBase();
    const first = await expireStaleCreatedExecutionIntents({
      prisma: prisma as never,
      adapter: adapter as never,
      userId: "u1",
      logger: mockLogger()
    });
    const second = await expireStaleCreatedExecutionIntents({
      prisma: prisma as never,
      adapter: adapter as never,
      userId: "u1",
      logger: mockLogger()
    });
    expect(first.expired).toBe(1);
    expect(second.examined).toBe(0);
    expect(second.expired).toBe(0);
  });

  it("G. capacity becomes available after safe expiration", async () => {
    const prisma = buildPrisma();
    prisma.seedCreated({
      signalId: "sig-cap",
      createdAt: new Date(Date.now() - CREATED_INTENT_RESUME_TTL_MS - 60_000)
    });
    prisma.positions.set("open-1", {
      id: "open-1",
      userId: "u1",
      origin: "ENGINE",
      status: "OPEN"
    });
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(2);
    await expireStaleCreatedExecutionIntents({
      prisma: prisma as never,
      adapter: adapterBase() as never,
      userId: "u1",
      logger: mockLogger()
    });
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(1);
  });

  it("sweep cadence helper respects interval", () => {
    expect(shouldRunCreatedIntentExpirySweep(null)).toBe(true);
    const now = Date.now();
    expect(shouldRunCreatedIntentExpirySweep(now, now + 1000)).toBe(false);
    expect(
      shouldRunCreatedIntentExpirySweep(now, now + CREATED_INTENT_EXPIRY_SWEEP_INTERVAL_MS + 1)
    ).toBe(true);
  });
});
