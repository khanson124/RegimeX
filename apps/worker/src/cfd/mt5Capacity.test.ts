import { describe, expect, it, vi } from "vitest";
import {
  MT5_CAPACITY_BLOCKED,
  decideCapacityReservation,
  positionStatusConsumesCapacity
} from "@regimex/trading-engine";
import {
  closeLocalPositionIfCloseable,
  countMt5ConsumedCapacitySlots,
  createPendingPositionWithExecutionIntent,
  failClosedPendingExecution,
  markExecutionIntentAmbiguous,
  markExecutionIntentSubmitted
} from "./mt5ExecutionIntegrity.js";

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => mockLogger() } as never;
}

function baseInput(signalId: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    signalId,
    correlationId: "corr-1",
    internalSymbol: "R_10",
    brokerSymbol: "Volatility 10 Index",
    strategyId: "ema-pullback-v1",
    strategyVersion: "1",
    regime: "ALL",
    interval: "5m",
    direction: "SELL",
    volume: 0.5,
    stopLoss: 4772,
    takeProfit: 4769,
    riskAmount: 10,
    riskPercent: 1,
    initialRiskReward: 2,
    reasoning: {},
    metadata: {},
    maxConcurrentPositions: 5,
    ...overrides
  };
}

function buildCapacityPrisma() {
  const positions = new Map<string, Record<string, unknown>>();
  const intents = new Map<string, Record<string, unknown>>();
  let posSeq = 0;
  let intentSeq = 0;
  let lockChain: Promise<void> = Promise.resolve();

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prev = lockChain;
    lockChain = prev.then(() => gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function countConsuming(userId: string) {
    return [...positions.values()].filter(
      (p) =>
        p.userId === userId &&
        p.origin === "ENGINE" &&
        ["PENDING", "OPEN", "OPEN_REQUESTED", "CLOSE_REQUESTED"].includes(String(p.status))
    ).length;
  }

  const positionApi = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
      if (where.id) return positions.get(where.id) ?? null;
      if (where.idempotencyKey) {
        return [...positions.values()].find((p) => p.idempotencyKey === where.idempotencyKey) ?? null;
      }
      return null;
    }),
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
  };

  const intentApi = {
    findUnique: vi.fn(async ({ where }: { where: { signalId?: string; id?: string } }) => {
      if (where.signalId) return intents.get(where.signalId) ?? null;
      if (where.id) return [...intents.values()].find((i) => i.id === where.id) ?? null;
      return null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = [...intents.values()].find((i) => i.id === where.id);
      if (!row) throw new Error("missing");
      Object.assign(row, data);
      return row;
    })
  };

  return {
    positions,
    intents,
    $executeRaw: vi.fn(async () => undefined),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      withLock(async () =>
        fn({
          $executeRaw: vi.fn(async () => undefined),
          position: {
            findUnique: positionApi.findUnique,
            count: vi.fn(async ({ where }: { where: { userId: string } }) => countConsuming(where.userId)),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
              if ([...positions.values()].some((p) => p.idempotencyKey === data.idempotencyKey)) {
                throw Object.assign(new Error("Unique"), { code: "P2002" });
              }
              const id = `pos-${++posSeq}`;
              const row = { id, ...data };
              positions.set(id, row);
              return row;
            })
          },
          executionIntent: {
            findUnique: intentApi.findUnique,
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
              const id = `intent-${++intentSeq}`;
              const row = { id, ...data };
              intents.set(String(data.signalId), row);
              return row;
            })
          }
        })
      )
    ),
    position: positionApi,
    executionIntent: intentApi,
    seedOpen(n: number) {
      for (let i = 0; i < n; i++) {
        const id = `seed-open-${i}`;
        positions.set(id, {
          id,
          userId: "u1",
          origin: "ENGINE",
          status: "OPEN",
          idempotencyKey: `signal:seed-open-${i}`,
          symbol: "R_10"
        });
      }
    }
  };
}

describe("mt5 capacity reservation", () => {
  it("A. two simultaneous attempts at 4/5 — exactly one reserves", async () => {
    const prisma = buildCapacityPrisma();
    prisma.seedOpen(4);
    const [a, b] = await Promise.all([
      createPendingPositionWithExecutionIntent(prisma as never, baseInput("sig-a"), mockLogger()),
      createPendingPositionWithExecutionIntent(prisma as never, baseInput("sig-b"), mockLogger())
    ]);
    const wins = [a, b].filter((r) => r.ok);
    const losses = [a, b].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.capacityBlocked).toBe(true);
    expect(losses[0]?.reason).toBe(MT5_CAPACITY_BLOCKED);
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(5);
  });

  it("B. two simultaneous attempts at 5/5 — both blocked", async () => {
    const prisma = buildCapacityPrisma();
    prisma.seedOpen(5);
    const [a, b] = await Promise.all([
      createPendingPositionWithExecutionIntent(prisma as never, baseInput("sig-a"), mockLogger()),
      createPendingPositionWithExecutionIntent(prisma as never, baseInput("sig-b"), mockLogger())
    ]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(5);
  });

  it("C. sixth of five blocked after five succeed", async () => {
    const prisma = buildCapacityPrisma();
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await createPendingPositionWithExecutionIntent(prisma as never, baseInput(`sig-${i}`), mockLogger())
      );
    }
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results[5]?.ok).toBe(false);
  });

  it("D. explicit reject releases capacity", async () => {
    const prisma = buildCapacityPrisma();
    prisma.seedOpen(4);
    const created = await createPendingPositionWithExecutionIntent(prisma as never, baseInput("sig-rej"), mockLogger());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await failClosedPendingExecution({
      prisma: prisma as never,
      positionId: created.position.id,
      executionIntentId: created.intent.id,
      code: "ORDER_REJECTED",
      message: "reject",
      logger: mockLogger()
    });
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(4);
    const again = await createPendingPositionWithExecutionIntent(prisma as never, baseInput("sig-new"), mockLogger());
    expect(again.ok).toBe(true);
  });

  it("E. AMBIGUOUS keeps capacity consumed", async () => {
    const prisma = buildCapacityPrisma();
    prisma.seedOpen(4);
    const created = await createPendingPositionWithExecutionIntent(prisma as never, baseInput("sig-amb"), mockLogger());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await markExecutionIntentSubmitted(prisma as never, created.intent.id as string, mockLogger());
    await markExecutionIntentAmbiguous(
      prisma as never,
      created.intent.id as string,
      { code: "AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT" },
      mockLogger()
    );
    expect(prisma.positions.get(created.position.id as string)?.status).toBe("PENDING");
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(5);
    const blocked = await createPendingPositionWithExecutionIntent(prisma as never, baseInput("sig-other"), mockLogger());
    expect(blocked.ok).toBe(false);
  });

  it("F. AMBIGUOUS proven no execution then fail-closed releases once", async () => {
    const prisma = buildCapacityPrisma();
    const created = await createPendingPositionWithExecutionIntent(prisma as never, baseInput("sig-f"), mockLogger());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await markExecutionIntentSubmitted(prisma as never, created.intent.id as string, mockLogger());
    await markExecutionIntentAmbiguous(
      prisma as never,
      created.intent.id as string,
      { code: "AMBIGUOUS" },
      mockLogger()
    );
    const first = await failClosedPendingExecution({
      prisma: prisma as never,
      positionId: created.position.id,
      executionIntentId: created.intent.id,
      code: "PROVEN_NO_EXECUTION",
      message: "broker empty",
      logger: mockLogger()
    });
    const second = await failClosedPendingExecution({
      prisma: prisma as never,
      positionId: created.position.id,
      executionIntentId: created.intent.id,
      code: "PROVEN_NO_EXECUTION",
      message: "broker empty",
      logger: mockLogger()
    });
    expect(first.released).toBe(true);
    expect(second.released).toBe(false);
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(0);
  });

  it("G. OPEN continues to consume capacity", async () => {
    const prisma = buildCapacityPrisma();
    prisma.seedOpen(5);
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(5);
    expect(decideCapacityReservation({ consumedBefore: 5, maxConcurrent: 5 }).allowed).toBe(false);
  });

  it("H. close releases capacity exactly once", async () => {
    const prisma = buildCapacityPrisma();
    prisma.seedOpen(1);
    const id = "seed-open-0";
    const first = await closeLocalPositionIfCloseable({
      prisma: prisma as never,
      positionId: id,
      data: { closePrice: 1, realizedPnl: 1, closeReason: "BROKER_CLOSE", closedAt: new Date() },
      logger: mockLogger()
    });
    const second = await closeLocalPositionIfCloseable({
      prisma: prisma as never,
      positionId: id,
      data: { closePrice: 2, realizedPnl: 99, closeReason: "BROKER_CLOSE", closedAt: new Date() },
      logger: mockLogger()
    });
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(prisma.positions.get(id)?.realizedPnl).toBe(1);
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(0);
  });

  it("I. duplicate reconciliation close — no duplicate P/L", async () => {
    const prisma = buildCapacityPrisma();
    prisma.positions.set("p1", {
      id: "p1",
      userId: "u1",
      origin: "ENGINE",
      status: "OPEN",
      realizedPnl: null
    });
    await closeLocalPositionIfCloseable({
      prisma: prisma as never,
      positionId: "p1",
      data: { closePrice: 10, realizedPnl: 5, closeReason: "BROKER_CLOSE", closedAt: new Date() },
      logger: mockLogger()
    });
    await closeLocalPositionIfCloseable({
      prisma: prisma as never,
      positionId: "p1",
      data: { closePrice: 99, realizedPnl: 999, closeReason: "BROKER_CLOSE", closedAt: new Date() },
      logger: mockLogger()
    });
    expect(prisma.positions.get("p1")?.realizedPnl).toBe(5);
    expect(prisma.positions.get("p1")?.status).toBe("CLOSED");
  });

  it("J. stale close cannot regress REJECTED", async () => {
    const prisma = buildCapacityPrisma();
    prisma.positions.set("p1", {
      id: "p1",
      userId: "u1",
      origin: "ENGINE",
      status: "REJECTED"
    });
    const result = await closeLocalPositionIfCloseable({
      prisma: prisma as never,
      positionId: "p1",
      data: { closePrice: 1, realizedPnl: 1, closeReason: "X", closedAt: new Date() },
      logger: mockLogger()
    });
    expect(result.applied).toBe(false);
    expect(prisma.positions.get("p1")?.status).toBe("REJECTED");
  });

  it("K. restart capacity reconstructs from OPEN+PENDING; REJECTED/CLOSED excluded", async () => {
    const prisma = buildCapacityPrisma();
    prisma.positions.set("open", { id: "open", userId: "u1", origin: "ENGINE", status: "OPEN" });
    prisma.positions.set("sub", { id: "sub", userId: "u1", origin: "ENGINE", status: "PENDING" });
    prisma.positions.set("amb", { id: "amb", userId: "u1", origin: "ENGINE", status: "PENDING" });
    prisma.positions.set("created", { id: "created", userId: "u1", origin: "ENGINE", status: "PENDING" });
    prisma.positions.set("rej", { id: "rej", userId: "u1", origin: "ENGINE", status: "REJECTED" });
    prisma.positions.set("closed", { id: "closed", userId: "u1", origin: "ENGINE", status: "CLOSED" });
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(4);
  });

  it("L. two workers racing — serialized lock enforces max", async () => {
    const prisma = buildCapacityPrisma();
    prisma.seedOpen(4);
    const raced = await Promise.all(
      ["w1", "w2", "w3"].map((s) =>
        createPendingPositionWithExecutionIntent(prisma as never, baseInput(s), mockLogger())
      )
    );
    expect(raced.filter((r) => r.ok)).toHaveLength(1);
    expect(raced.filter((r) => !r.ok)).toHaveLength(2);
  });

  it("M. PENDING counts toward capacity", () => {
    expect(positionStatusConsumesCapacity("PENDING")).toBe(true);
    expect(decideCapacityReservation({ consumedBefore: 4, maxConcurrent: 5 }).allowed).toBe(true);
    expect(decideCapacityReservation({ consumedBefore: 5, maxConcurrent: 5 }).allowed).toBe(false);
  });

  it("N. REJECTED/CLOSED do not consume", async () => {
    const prisma = buildCapacityPrisma();
    prisma.positions.set("r", { id: "r", userId: "u1", origin: "ENGINE", status: "REJECTED" });
    prisma.positions.set("c", { id: "c", userId: "u1", origin: "ENGINE", status: "CLOSED" });
    expect(await countMt5ConsumedCapacitySlots(prisma as never, "u1")).toBe(0);
  });
});
