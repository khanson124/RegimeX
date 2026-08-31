import { describe, expect, it, vi } from "vitest";
import {
  CREATED_INTENT_RESUME_TTL_MS,
  EXECUTION_INTENT_EXPIRED,
  regimeXOrderComment
} from "@regimex/trading-engine";
import { type OpenMarketPositionResult } from "@regimex/shared";
import { recoverUnresolvedMt5ExecutionIntents } from "./mt5ExecutionRecovery.js";

function brokerOpen(idempotencyKey: string): OpenMarketPositionResult {
  return {
    accepted: true,
    brokerPositionId: "5760025203",
    entryPrice: 4771.2,
    appliedSpreadBps: 0,
    appliedSlippageBps: 0,
    rejectionReasons: [],
    position: {
      brokerPositionId: "5760025203",
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

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => mockLogger() } as never;
}

function buildRecoveryPrisma() {
  const intents = new Map<string, Record<string, unknown>>();
  const positions = new Map<string, Record<string, unknown>>();
  let intentSeq = 0;

  return {
    intents,
    positions,
    executionIntent: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; state: { in: string[] } } }) =>
        [...intents.values()].filter(
          (r) => r.userId === where.userId && where.state.in.includes(String(r.state))
        )
      ),
      findUnique: vi.fn(async ({ where }: { where: { signalId?: string; id?: string } }) => {
        if (where.signalId) return intents.get(where.signalId) ?? null;
        if (where.id) return [...intents.values()].find((r) => r.id === where.id) ?? null;
        return null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = [...intents.values()].find((r) => r.id === where.id);
        if (!row) throw new Error("intent not found");
        Object.assign(row, data);
        return row;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `intent-${++intentSeq}`, ...data };
        intents.set(String(data.signalId), row);
        return row;
      })
    },
    position: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => positions.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { userId: string; status: string; origin?: string } }) =>
        [...positions.values()].filter(
          (r) =>
            r.userId === where.userId &&
            r.status === where.status &&
            (where.origin == null || r.origin === where.origin)
        )
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = positions.get(where.id);
        if (!row) throw new Error("position not found");
        Object.assign(row, data);
        return row;
      })
    },
    brokerSymbolMapping: {
      findFirst: vi.fn(async () => ({
        brokerSymbol: "Volatility 10 Index"
      }))
    },
    signal: {
      update: vi.fn(async () => ({}))
    },
    positionEvent: {
      create: vi.fn(async () => ({}))
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
    getLiveSymbol: vi.fn(async () => ({
      point: 0.001,
      tickSize: 0.001,
      digits: 3,
      stopsLevel: 0,
      freezeLevel: 0
    })),
    tryAdoptOpenByIdempotency: vi.fn(async () => null),
    openMarketPosition: vi.fn(),
    ...overrides
  };
}

const recoveryConfig = { MAX_EXECUTION_QUOTE_AGE_MS: 30_000 };

describe("recoverUnresolvedMt5ExecutionIntents", () => {
  it("E. recovers SUBMITTED intent with PENDING position from broker on startup", async () => {
    const prisma = buildRecoveryPrisma();
    const idempotencyKey = "signal:sig-crash";
    prisma.positions.set("pos-1", {
      id: "pos-1",
      userId: "u1",
      signalId: "sig-crash",
      status: "PENDING",
      origin: "ENGINE",
      symbol: "R_10",
      direction: "SELL",
      volume: 0.5,
      stopLoss: 4772,
      takeProfit: 4769,
      idempotencyKey,
      riskAmount: 10,
      riskPercent: 1,
      initialRiskReward: 2,
      metadata: { engineSymbol: "R_10" }
    });
    prisma.intents.set("sig-crash", {
      id: "intent-1",
      userId: "u1",
      signalId: "sig-crash",
      positionId: "pos-1",
      idempotencyKey,
      brokerSymbol: "Volatility 10 Index",
      internalSymbol: "R_10",
      direction: "SELL",
      requestedVolume: 0.5,
      requestedStopLoss: 4772,
      requestedTakeProfit: 4769,
      state: "SUBMITTED",
      submittedAt: new Date()
    });

    const adapter = adapterBase({
      tryAdoptOpenByIdempotency: vi.fn(async () => brokerOpen(idempotencyKey))
    });

    const result = await recoverUnresolvedMt5ExecutionIntents({
      prisma: prisma as never,
      adapter: adapter as never,
      userId: "u1",
      config: recoveryConfig,
      logger: mockLogger()
    });

    expect(result.recovered).toBe(1);
    expect(adapter.openMarketPosition).not.toHaveBeenCalled();
    expect(prisma.positions.get("pos-1")?.status).toBe("OPEN");
    expect(prisma.intents.get("sig-crash")?.state).toBe("PERSISTED");
  });

  it("B. fresh CREATED intent awaits executeCfdSignal resume — no startup auto-submit", async () => {
    const prisma = buildRecoveryPrisma();
    prisma.positions.set("pos-1", {
      id: "pos-1",
      userId: "u1",
      signalId: "sig-created",
      status: "PENDING",
      origin: "ENGINE",
      riskAmount: 10,
      riskPercent: 1,
      initialRiskReward: 2
    });
    prisma.intents.set("sig-created", {
      id: "intent-1",
      userId: "u1",
      signalId: "sig-created",
      positionId: "pos-1",
      idempotencyKey: "signal:sig-created",
      brokerSymbol: "Volatility 10 Index",
      internalSymbol: "R_10",
      direction: "SELL",
      requestedVolume: 0.5,
      requestedStopLoss: 4772,
      requestedTakeProfit: 4769,
      strategyId: "ema-pullback-v1",
      state: "CREATED",
      createdAt: new Date(),
      submittedAt: null
    });

    const adapter = adapterBase();
    const result = await recoverUnresolvedMt5ExecutionIntents({
      prisma: prisma as never,
      adapter: adapter as never,
      userId: "u1",
      config: recoveryConfig,
      logger: mockLogger()
    });

    expect(result.awaitingResume).toBe(1);
    expect(result.failedClosed).toBe(0);
    expect(adapter.openMarketPosition).not.toHaveBeenCalled();
    expect(prisma.intents.get("sig-created")?.state).toBe("CREATED");
  });

  it("D. expired CREATED intent is rejected on startup", async () => {
    const prisma = buildRecoveryPrisma();
    prisma.positions.set("pos-1", {
      id: "pos-1",
      userId: "u1",
      signalId: "sig-expired",
      status: "PENDING",
      origin: "ENGINE",
      riskAmount: 10,
      riskPercent: 1,
      initialRiskReward: 2
    });
    prisma.intents.set("sig-expired", {
      id: "intent-1",
      userId: "u1",
      signalId: "sig-expired",
      positionId: "pos-1",
      idempotencyKey: "signal:sig-expired",
      brokerSymbol: "Volatility 10 Index",
      internalSymbol: "R_10",
      direction: "SELL",
      requestedVolume: 0.5,
      requestedStopLoss: 4772,
      requestedTakeProfit: 4769,
      strategyId: "ema-pullback-v1",
      state: "CREATED",
      createdAt: new Date(Date.now() - CREATED_INTENT_RESUME_TTL_MS - 60_000),
      submittedAt: null
    });

    const adapter = adapterBase();
    const result = await recoverUnresolvedMt5ExecutionIntents({
      prisma: prisma as never,
      adapter: adapter as never,
      userId: "u1",
      config: recoveryConfig,
      logger: mockLogger()
    });

    expect(result.failedClosed).toBe(1);
    expect(prisma.intents.get("sig-expired")?.state).toBe("REJECTED");
    expect(prisma.intents.get("sig-expired")?.lastErrorCode).toBe(EXECUTION_INTENT_EXPIRED);
    expect(prisma.positions.get("pos-1")?.status).toBe("REJECTED");
  });

  it("E. repeated startup recovery remains idempotent", async () => {
    const prisma = buildRecoveryPrisma();
    const idempotencyKey = "signal:sig-repeat";
    prisma.positions.set("pos-1", {
      id: "pos-1",
      userId: "u1",
      signalId: "sig-repeat",
      status: "PENDING",
      origin: "ENGINE",
      symbol: "R_10",
      direction: "SELL",
      volume: 0.5,
      stopLoss: 4772,
      takeProfit: 4769,
      idempotencyKey,
      riskAmount: 10,
      riskPercent: 1,
      initialRiskReward: 2,
      metadata: {}
    });
    prisma.intents.set("sig-repeat", {
      id: "intent-1",
      userId: "u1",
      signalId: "sig-repeat",
      positionId: "pos-1",
      idempotencyKey,
      brokerSymbol: "Volatility 10 Index",
      internalSymbol: "R_10",
      direction: "SELL",
      requestedVolume: 0.5,
      requestedStopLoss: 4772,
      requestedTakeProfit: 4769,
      state: "AMBIGUOUS",
      submittedAt: new Date()
    });

    const adapter = adapterBase({
      tryAdoptOpenByIdempotency: vi.fn(async () => brokerOpen(idempotencyKey))
    });

    const first = await recoverUnresolvedMt5ExecutionIntents({
      prisma: prisma as never,
      adapter: adapter as never,
      userId: "u1",
      config: recoveryConfig,
      logger: mockLogger()
    });
    const second = await recoverUnresolvedMt5ExecutionIntents({
      prisma: prisma as never,
      adapter: adapter as never,
      userId: "u1",
      config: recoveryConfig,
      logger: mockLogger()
    });

    expect(first.recovered).toBe(1);
    expect(second.recovered).toBe(0);
    expect(adapter.tryAdoptOpenByIdempotency).toHaveBeenCalledTimes(1);
    expect(prisma.intents.get("sig-repeat")?.state).toBe("PERSISTED");
  });

  it("J. AMBIGUOUS intent with no broker match fails closed without resubmit", async () => {
    const prisma = buildRecoveryPrisma();
    prisma.positions.set("pos-1", {
      id: "pos-1",
      userId: "u1",
      signalId: "sig-ambig",
      status: "PENDING",
      origin: "ENGINE"
    });
    prisma.intents.set("sig-ambig", {
      id: "intent-1",
      userId: "u1",
      signalId: "sig-ambig",
      positionId: "pos-1",
      idempotencyKey: "signal:sig-ambig",
      brokerSymbol: "Volatility 10 Index",
      internalSymbol: "R_10",
      direction: "SELL",
      requestedVolume: 0.5,
      requestedStopLoss: 4772,
      requestedTakeProfit: 4769,
      state: "AMBIGUOUS",
      submittedAt: new Date()
    });

    const adapter = adapterBase();
    const result = await recoverUnresolvedMt5ExecutionIntents({
      prisma: prisma as never,
      adapter: adapter as never,
      userId: "u1",
      config: recoveryConfig,
      logger: mockLogger()
    });

    expect(result.failedClosed).toBe(1);
    expect(adapter.openMarketPosition).not.toHaveBeenCalled();
    expect(prisma.positions.get("pos-1")?.status).toBe("PENDING");
  });
});
