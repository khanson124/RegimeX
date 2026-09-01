import { describe, expect, it, vi } from "vitest";
import {
  AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT,
  adaptMt5BrokerStops,
  classifyOpenMarketFailure,
  compareProposedToFrozenExecutionParams,
  CREATED_INTENT_RESUME_TTL_MS,
  EXECUTION_INTENT_EXPIRED,
  EXECUTION_INTENT_PARAMETER_MISMATCH,
  EXECUTION_INTENT_STALE,
  regimeXOrderComment,
  type DerivMT5BrokerAdapter
} from "@regimex/trading-engine";
import { type OpenMarketPositionResult } from "@regimex/shared";
import {
  createPendingPositionWithExecutionIntent,
  extractFrozenExecutionParams,
  markExecutionIntentRejected,
  markExecutionIntentSubmitted,
  persistPositionOpenFromBrokerResult,
  resolveCreatedExecutionIntentOnStartup,
  shouldBlockDuplicateExecution,
  tryRecoverExecutionIntentFromBroker,
  validateFrozenIntentSubmitSafety
} from "./mt5ExecutionIntegrity.js";

const basePositionInput = {
  userId: "u1",
  signalId: "sig-1",
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
  maxConcurrentPositions: 5
};

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => mockLogger()
  } as never;
}

function frozenParams() {
  return {
    internalSymbol: "R_10",
    brokerSymbol: "Volatility 10 Index",
    direction: "SELL" as const,
    volume: 0.5,
    stopLoss: 4772,
    takeProfit: 4769,
    strategyId: "ema-pullback-v1",
    riskAmount: 10,
    riskPercent: 1,
    initialRiskReward: 2
  };
}

function validAdaptation(frozen: ReturnType<typeof frozenParams>) {
  return adaptMt5BrokerStops({
    direction: frozen.direction,
    stopLoss: frozen.stopLoss,
    takeProfit: frozen.takeProfit,
    entryPrice: 4771.2,
    targetRMultiple: frozen.initialRiskReward ?? 2,
    bid: 4771,
    ask: 4771.2,
    point: 0.001,
    tickSize: 0.001,
    digits: 3,
    stopsLevel: 0,
    freezeLevel: 0
  });
}

describe("mt5ExecutionIntegrity worker helpers", () => {
  function txWithCapacity(opts: {
    positions?: Map<string, Record<string, unknown>>;
    intents?: Map<string, Record<string, unknown>>;
    failIntent?: boolean;
  }) {
    const positions = opts.positions ?? new Map<string, Record<string, unknown>>();
    const intents = opts.intents ?? new Map<string, Record<string, unknown>>();
    return {
      $executeRaw: vi.fn(async () => undefined),
      position: {
        findUnique: vi.fn(async ({ where }: { where: { idempotencyKey?: string; id?: string } }) => {
          if (where.idempotencyKey) {
            return [...positions.values()].find((p) => p.idempotencyKey === where.idempotencyKey) ?? null;
          }
          if (where.id) return positions.get(where.id) ?? null;
          return null;
        }),
        count: vi.fn(async () =>
          [...positions.values()].filter((p) => p.status === "PENDING" || p.status === "OPEN").length
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: "pos-1", status: "PENDING", ...data };
          positions.set("pos-1", row);
          return row;
        })
      },
      executionIntent: {
        findUnique: vi.fn(async ({ where }: { where: { signalId?: string } }) =>
          where.signalId ? intents.get(where.signalId) ?? null : null
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (opts.failIntent) throw new Error("intent create failed");
          const row = { id: "intent-1", state: "CREATED", ...data };
          intents.set(String(data.signalId), row);
          return row;
        })
      },
      positions,
      intents
    };
  }

  it("A. atomic create rolls back position when intent create fails — no orphan PENDING", async () => {
    const positions = new Map<string, Record<string, unknown>>();
    const intents = new Map<string, Record<string, unknown>>();
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = txWithCapacity({ positions, intents, failIntent: true });
        try {
          return await fn(tx);
        } catch (err) {
          positions.clear();
          intents.clear();
          throw err;
        }
      }),
      position: { findUnique: vi.fn(async () => null) },
      executionIntent: { findUnique: vi.fn(async () => null) }
    };

    await expect(
      createPendingPositionWithExecutionIntent(prisma as never, basePositionInput, mockLogger())
    ).rejects.toThrow("intent create failed");
    expect(positions.size).toBe(0);
    expect(intents.size).toBe(0);
  });

  it("A. atomic create persists position and intent together", async () => {
    const positions = new Map<string, Record<string, unknown>>();
    const intents = new Map<string, Record<string, unknown>>();
    const prisma = {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txWithCapacity({ positions, intents }))),
      position: { findUnique: vi.fn(async () => null) },
      executionIntent: { findUnique: vi.fn(async () => null) }
    };

    const result = await createPendingPositionWithExecutionIntent(prisma as never, basePositionInput, mockLogger());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.position.status).toBe("PENDING");
    expect(result.intent.state).toBe("CREATED");
    expect(result.intent.idempotencyKey).toBe("signal:sig-1");
    expect(result.intent.brokerComment).toBe(regimeXOrderComment("signal:sig-1"));
  });

  it("B. explicit broker rejection marks intent REJECTED", async () => {
    const intents = new Map<string, Record<string, unknown>>();
    intents.set("intent-1", {
      id: "intent-1",
      state: "SUBMITTED",
      idempotencyKey: "signal:sig-reject",
      signalId: "sig-reject"
    });
    const prisma = {
      executionIntent: {
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = intents.get(where.id);
          if (!row) throw new Error("missing");
          Object.assign(row, data);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: { where: { signalId?: string; id?: string } }) => {
          if (where.id) return intents.get(where.id) ?? null;
          if (where.signalId) {
            return [...intents.values()].find((i) => i.signalId === where.signalId) ?? null;
          }
          return null;
        })
      }
    };
    await markExecutionIntentRejected(
      prisma as never,
      "intent-1",
      { code: "ORDER_REJECTED", message: "10016 invalid stops" },
      mockLogger()
    );
    const row = await prisma.executionIntent.findUnique({ where: { signalId: "sig-reject" } });
    expect(row?.state).toBe("REJECTED");
    expect(shouldBlockDuplicateExecution({ state: "REJECTED" }, { status: "REJECTED" }).block).toBe(true);
  });

  it("C. attempted parameter mutation under same idempotency key is detected", () => {
    const frozen = frozenParams();
    const mismatch = compareProposedToFrozenExecutionParams(frozen, { ...frozen, stopLoss: 4773 });
    expect(mismatch.match).toBe(false);
    expect(mismatch.diffs).toContain("stopLoss");
  });

  it("B/C. frozen extraction round-trips intent + position fields", () => {
    const extracted = extractFrozenExecutionParams(
      {
        internalSymbol: "R_10",
        brokerSymbol: "Volatility 10 Index",
        direction: "SELL",
        requestedVolume: 0.5,
        requestedStopLoss: 4772,
        requestedTakeProfit: 4769,
        strategyId: "ema-pullback-v1"
      },
      { riskAmount: 10, riskPercent: 1, initialRiskReward: 2 }
    );
    expect(extracted.volume).toBe(0.5);
    expect(extracted.takeProfit).toBe(4769);
  });

  it("D. ambiguous timeout recovers broker position without second OrderSend", async () => {
    const intents = new Map<string, Record<string, unknown>>();
    let id = 0;
    const prisma = {
      intents,
      executionIntent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `intent-${++id}`, ...data };
          intents.set(String(data.signalId), row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = [...intents.values()].find((r) => r.id === where.id);
          if (!row) throw new Error("not found");
          Object.assign(row, data);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: { where: { signalId?: string; id?: string } }) => {
          if (where.signalId) return intents.get(where.signalId) ?? null;
          if (where.id) return [...intents.values()].find((r) => r.id === where.id) ?? null;
          return null;
        })
      },
      position: {
        findUnique: vi.fn(async () => ({
          metadata: {},
          stopLoss: 4772,
          takeProfit: 4769,
          direction: "SELL"
        })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      signal: { update: vi.fn(async () => ({})) }
    };

    const created = await createPendingPositionWithExecutionIntent(
      {
        $transaction: vi.fn(async (fn) =>
          fn({
            $executeRaw: vi.fn(async () => undefined),
            position: {
              findUnique: vi.fn(async () => null),
              count: vi.fn(async () => 0),
              create: vi.fn(async ({ data }) => ({ id: "pos-1", status: "PENDING", ...data }))
            },
            executionIntent: {
              findUnique: vi.fn(async () => null),
              create: vi.fn(async ({ data }) => {
                const row = { id: "intent-1", state: "CREATED", ...data };
                intents.set("sig-timeout", row);
                return row;
              })
            }
          })
        ),
        position: { findUnique: vi.fn() },
        executionIntent: { findUnique: prisma.executionIntent.findUnique }
      } as never,
      { ...basePositionInput, signalId: "sig-timeout" },
      mockLogger()
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await markExecutionIntentSubmitted(prisma as never, created.intent.id as string, mockLogger());

    const adopted: OpenMarketPositionResult = {
      accepted: true,
      brokerPositionId: "5760025203",
      entryPrice: 4771.2,
      appliedSpreadBps: 0,
      appliedSlippageBps: 0,
      rejectionReasons: [],
      position: {
        brokerPositionId: "5760025203",
        idempotencyKey: "signal:sig-timeout",
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
        metadata: { comment: regimeXOrderComment("signal:sig-timeout"), magic: 26082301 }
      }
    };

    const adapter = {
      tryAdoptOpenByIdempotency: vi.fn(async () => adopted),
      openMarketPosition: vi.fn()
    } as unknown as DerivMT5BrokerAdapter;

    const result = await tryRecoverExecutionIntentFromBroker({
      prisma: prisma as never,
      adapter,
      intent: created.intent as never,
      positionId: "pos-1",
      instrument: {
        symbol: "Volatility 10 Index",
        enabled: true,
        verified: true,
        contractSize: 1,
        volumeStep: 0.01,
        minVolume: 0.5,
        maxVolume: 100,
        tickSize: 0.001,
        tickValue: 0.001,
        marginRate: 0.01,
        spreadBps: 0,
        slippageBps: 0,
        pricePrecision: 3,
        currency: "USD"
      },
      quote: { symbol: "Volatility 10 Index", bid: 4771, ask: 4771.2, mid: 4771.1, timestamp: Date.now() },
      logger: mockLogger()
    });

    expect(result?.accepted).toBe(true);
    expect(adapter.openMarketPosition).not.toHaveBeenCalled();
    expect(classifyOpenMarketFailure([AMBIGUOUS_TIMEOUT_QUERY_BEFORE_RESUBMIT])).toBe("AMBIGUOUS");
  });

  it("D. stale CREATED intent fails closed on startup", async () => {
    const frozen = frozenParams();
    const prisma = {
      position: {
        findUnique: vi.fn(async () => ({
          id: "pos-1",
          userId: "u1",
          symbol: "R_10",
          status: "PENDING"
        })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      executionIntent: {
        findUnique: vi.fn(async () => ({
          id: "intent-1",
          state: "CREATED",
          idempotencyKey: "signal:sig-stale",
          signalId: "sig-stale"
        })),
        update: vi.fn(async ({ data }) => ({ id: "intent-1", ...data }))
      }
    };
    const resolution = await resolveCreatedExecutionIntentOnStartup({
      prisma: prisma as never,
      intent: {
        id: "intent-1",
        signalId: "sig-stale",
        createdAt: new Date(),
        brokerSymbol: frozen.brokerSymbol,
        direction: frozen.direction,
        requestedVolume: frozen.volume,
        requestedStopLoss: frozen.stopLoss,
        requestedTakeProfit: frozen.takeProfit,
        internalSymbol: frozen.internalSymbol,
        strategyId: frozen.strategyId
      },
      position: { id: "pos-1", riskAmount: 10, riskPercent: 1, initialRiskReward: 2 },
      quote: {
        symbol: frozen.brokerSymbol,
        bid: 4771,
        ask: 4771.2,
        mid: 4771.1,
        timestamp: Date.now() - 120_000
      },
      instrument: {} as never,
      adaptation: validAdaptation(frozen),
      maxQuoteAgeMs: 30_000,
      logger: mockLogger()
    });
    expect(resolution).toBe("stale");
    expect(prisma.position.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) })
    );
  });

  it("D. expired CREATED intent fails closed on startup", async () => {
    const frozen = frozenParams();
    const prisma = {
      position: {
        findUnique: vi.fn(async () => ({
          id: "pos-1",
          userId: "u1",
          symbol: "R_10",
          status: "PENDING"
        })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 }))
      },
      executionIntent: {
        findUnique: vi.fn(async () => ({
          id: "intent-1",
          state: "CREATED",
          idempotencyKey: "signal:sig-expired",
          signalId: "sig-expired"
        })),
        update: vi.fn(async ({ data }) => ({ id: "intent-1", ...data }))
      }
    };
    const resolution = await resolveCreatedExecutionIntentOnStartup({
      prisma: prisma as never,
      intent: {
        id: "intent-1",
        signalId: "sig-expired",
        createdAt: new Date(Date.now() - CREATED_INTENT_RESUME_TTL_MS - 60_000),
        brokerSymbol: frozen.brokerSymbol,
        direction: frozen.direction,
        requestedVolume: frozen.volume,
        requestedStopLoss: frozen.stopLoss,
        requestedTakeProfit: frozen.takeProfit,
        internalSymbol: frozen.internalSymbol,
        strategyId: frozen.strategyId
      },
      position: { id: "pos-1", riskAmount: 10, riskPercent: 1, initialRiskReward: 2 },
      quote: { symbol: frozen.brokerSymbol, bid: 4771, ask: 4771.2, mid: 4771.1, timestamp: Date.now() },
      instrument: {} as never,
      adaptation: validAdaptation(frozen),
      maxQuoteAgeMs: 30_000,
      logger: mockLogger(),
      now: Date.now()
    });
    expect(resolution).toBe("expired");
  });

  it("B. CREATED resume with identical frozen parameters passes safety validation", async () => {
    const frozen = frozenParams();
    const safety = await validateFrozenIntentSubmitSafety({
      frozen,
      quote: { symbol: frozen.brokerSymbol, bid: 4771, ask: 4771.2, mid: 4771.1, timestamp: Date.now() },
      maxQuoteAgeMs: 30_000,
      adaptation: validAdaptation(frozen)
    });
    expect(safety.ok).toBe(true);
  });

  it("C. parameter mismatch codes are stable", () => {
    expect(EXECUTION_INTENT_PARAMETER_MISMATCH).toBe("EXECUTION_INTENT_PARAMETER_MISMATCH");
    expect(EXECUTION_INTENT_STALE).toBe("EXECUTION_INTENT_STALE");
    expect(EXECUTION_INTENT_EXPIRED).toBe("EXECUTION_INTENT_EXPIRED");
  });

  it("F. CREATED intent with PENDING position allows safe resume before submit", () => {
    const resume = shouldBlockDuplicateExecution({ state: "CREATED", submittedAt: null }, { status: "PENDING" });
    expect(resume.block).toBe(false);
    expect(resume.resumeBeforeSubmit).toBe(true);
  });

  it("blocks duplicate when intent already SUBMITTED", () => {
    expect(shouldBlockDuplicateExecution({ state: "SUBMITTED" }, { status: "PENDING" }).block).toBe(true);
  });

  it("G. duplicate invocation prevented by intent terminal state", () => {
    expect(shouldBlockDuplicateExecution({ state: "PERSISTED" }, { status: "OPEN" }).block).toBe(true);
    expect(shouldBlockDuplicateExecution({ state: "REJECTED" }, null).block).toBe(true);
  });

  it("A. normal accepted order persists intent through BROKER_CONFIRMED to PERSISTED", async () => {
    const intents = new Map<string, Record<string, unknown>>();
    let persistedMetadata: Record<string, unknown> | undefined;
    const prisma = {
      executionIntent: {
        findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
          where.id ? intents.get(where.id) ?? null : null
        ),
        update: vi.fn(async ({ where, data }) => {
          const row = intents.get(where.id) ?? { id: where.id };
          Object.assign(row, data);
          intents.set(where.id, row);
          return row;
        })
      },
      position: {
        findUnique: vi.fn(async () => ({
          metadata: {
            volumePreflight: { allowedRiskAmount: 10 },
            executionTelemetry: {
              telemetryVersion: 1,
              strategyRequestedRiskReward: 2,
              brokerRequestedRiskReward: 2,
              allowedRiskAmount: 10,
              requestedRiskAmount: 10,
              preflightEntry: 4771.5,
              adaptedStopLoss: 4772,
              adaptedTakeProfit: 4769,
              targetRMultiple: 2,
              finalVolume: 0.5,
              requestedVolume: 0.5,
              tickSize: 0.001,
              tickValue: 0.001
            }
          },
          stopLoss: 4772,
          takeProfit: 4769,
          direction: "SELL"
        })),
        updateMany: vi.fn(async ({ data }: { data: { metadata?: Record<string, unknown> } }) => {
          persistedMetadata = data.metadata;
          return { count: 1 };
        })
      },
      signal: { update: vi.fn(async () => ({})) }
    };
    intents.set("intent-1", { id: "intent-1", state: "SUBMITTED", idempotencyKey: "signal:sig-ok", signalId: "sig-ok" });

    await persistPositionOpenFromBrokerResult({
      prisma: prisma as never,
      positionId: "pos-1",
      signalId: "sig-ok",
      executionIntentId: "intent-1",
      result: {
        accepted: true,
        brokerPositionId: "5760025199",
        entryPrice: 4771.2,
        appliedSpreadBps: 0,
        appliedSlippageBps: 0,
        rejectionReasons: [],
        position: {
          brokerPositionId: "5760025199",
          idempotencyKey: "signal:sig-ok",
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
          metadata: {}
        }
      },
      symbolAudit: { internalSymbol: "R_10", brokerSymbol: "Volatility 10 Index" },
      instrument: {
        symbol: "R_10",
        enabled: true,
        verified: true,
        contractSize: 1,
        volumeStep: 0.01,
        minVolume: 0.01,
        maxVolume: 10,
        tickSize: 0.001,
        tickValue: 0.001,
        marginRate: 0.01,
        spreadBps: 10,
        slippageBps: 5,
        pricePrecision: 3,
        currency: "USD"
      },
      logger: mockLogger()
    });

    expect(intents.get("intent-1")?.state).toBe("PERSISTED");
    expect(persistedMetadata?.volumePreflight).toEqual({ allowedRiskAmount: 10 });
    expect(persistedMetadata?.executionTelemetry).toMatchObject({
      executedRiskReward: expect.any(Number),
      actualFillPrice: 4771.2,
      actualFillVolume: 0.5,
      strategyRequestedRiskReward: 2
    });
  });
});
