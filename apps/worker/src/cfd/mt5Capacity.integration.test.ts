/**
 * Real Postgres advisory-lock integration test for Stage 2 capacity reservation.
 *
 * Not run by default `pnpm test` (excluded). Run explicitly:
 *   pnpm --filter @regimex/worker test:integration
 *
 * Requires DATABASE_URL (loaded from repo .env if unset) and a reachable Postgres.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@regimex/database";
import { MT5_CAPACITY_BLOCKED, mt5CapacityAdvisoryLockKey } from "@regimex/trading-engine";
import {
  countMt5ConsumedCapacitySlots,
  createPendingPositionWithExecutionIntent
} from "./mt5ExecutionIntegrity.js";

function loadDatabaseUrlFromEnvFile(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const candidates = [
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../../.env")
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const line = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.startsWith("DATABASE_URL="));
    if (!line) continue;
    return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

const databaseUrl = loadDatabaseUrlFromEnvFile();
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

const runIntegration = process.env.RUN_INTEGRATION === "1" || process.env.RUN_MT5_CAPACITY_INTEGRATION === "1";

function mockLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => mockLogger()
  } as never;
}

function reserveInput(userId: string, signalId: string, max = 5) {
  return {
    userId,
    signalId,
    correlationId: `corr-${signalId}`,
    internalSymbol: "R_10",
    brokerSymbol: "Volatility 10 Index",
    strategyId: "ema-pullback-v1",
    strategyVersion: "1",
    regime: "ALL",
    interval: "5m",
    direction: "SELL" as const,
    volume: 0.5,
    stopLoss: 4772,
    takeProfit: 4769,
    riskAmount: 10,
    riskPercent: 1,
    initialRiskReward: 2,
    reasoning: { integration: true },
    metadata: { integration: true },
    maxConcurrentPositions: max
  };
}

describe.skipIf(!runIntegration || !databaseUrl)("mt5 capacity Postgres advisory lock integration", () => {
  const prisma = new PrismaClient();
  const suffix = `capint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let userA = "";
  let userB = "";
  const signalIds: string[] = [];
  const positionIds: string[] = [];

  async function createUser(tag: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `${tag}_${suffix}@example.test`,
        passwordHash: "integration-test-hash"
      }
    });
    return user.id;
  }

  async function createSignal(userId: string, tag: string): Promise<string> {
    const signal = await prisma.signal.create({
      data: {
        userId,
        symbol: "R_10",
        interval: "5m",
        strategyId: "ema-pullback-v1",
        strategyVersion: "1",
        regime: "ALL",
        regimeConfidence: 0.5,
        action: "SELL",
        confidence: 0.5,
        entryReason: { integration: true },
        signalTime: new Date(),
        correlationId: `corr-${tag}-${suffix}`
      }
    });
    signalIds.push(signal.id);
    return signal.id;
  }

  async function seedOpenSlots(userId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const signalId = await createSignal(userId, `seed_${i}`);
      const pos = await prisma.position.create({
        data: {
          userId,
          signalId,
          symbol: "R_10",
          strategyId: "ema-pullback-v1",
          direction: "SELL",
          volume: 0.5,
          origin: "ENGINE",
          interval: "5m",
          initialStopLoss: 4772,
          stopLoss: 4772,
          takeProfit: 4769,
          status: "OPEN",
          riskAmount: 10,
          riskPercent: 1,
          idempotencyKey: `signal:${signalId}`,
          correlationId: `corr-seed-${i}-${suffix}`,
          openedAt: new Date()
        }
      });
      positionIds.push(pos.id);
    }
  }

  beforeAll(async () => {
    await prisma.$connect();
    userA = await createUser("usera");
    userB = await createUser("userb");
  }, 60_000);

  afterAll(async () => {
    // Cascade deletes via user
    if (userA) await prisma.user.deleteMany({ where: { id: userA } });
    if (userB) await prisma.user.deleteMany({ where: { id: userB } });
    await prisma.$disconnect();
  }, 60_000);

  it("at 4/5 two concurrent reservations: one wins, one MAX_CONCURRENT_POSITIONS", async () => {
    await seedOpenSlots(userA, 4);
    expect(await countMt5ConsumedCapacitySlots(prisma, userA)).toBe(4);

    const sigA = await createSignal(userA, "race_a");
    const sigB = await createSignal(userA, "race_b");

    const [r1, r2] = await Promise.all([
      createPendingPositionWithExecutionIntent(prisma, reserveInput(userA, sigA), mockLogger()),
      createPendingPositionWithExecutionIntent(prisma, reserveInput(userA, sigB), mockLogger())
    ]);

    const wins = [r1, r2].filter((r) => r.ok);
    const losses = [r1, r2].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]?.capacityBlocked).toBe(true);
    expect(losses[0]?.reason).toBe(MT5_CAPACITY_BLOCKED);
    expect(losses[0]?.consumedSlotsBefore).toBe(5);

    expect(await countMt5ConsumedCapacitySlots(prisma, userA)).toBe(5);

    const pending = await prisma.position.findMany({
      where: { userId: userA, status: "PENDING", origin: "ENGINE" }
    });
    expect(pending).toHaveLength(1);
    if (wins[0]?.ok) {
      positionIds.push(wins[0].position.id);
      const intents = await prisma.executionIntent.findMany({
        where: { userId: userA, positionId: wins[0].position.id }
      });
      expect(intents).toHaveLength(1);
      expect(intents[0]?.state).toBe("CREATED");
    }

    // Losing signal must not have created an intent/position
    const loserSignalId = losses[0] === r1 ? sigA : sigB;
    expect(await prisma.executionIntent.findUnique({ where: { signalId: loserSignalId } })).toBeNull();
    expect(await prisma.position.findUnique({ where: { idempotencyKey: `signal:${loserSignalId}` } })).toBeNull();
  }, 60_000);

  it("different userIds do not block each other on advisory locks", async () => {
    const lockKeyA = mt5CapacityAdvisoryLockKey(userA);
    let userBDoneAt = 0;
    let userAReleasedAt = 0;

    const holdA = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKeyA}))`;
        // Hold lock while B reserves
        await new Promise((r) => setTimeout(r, 800));
        userAReleasedAt = Date.now();
      },
      { timeout: 15_000 }
    );

    await new Promise((r) => setTimeout(r, 50)); // ensure A acquired lock first

    const sigB = await createSignal(userB, "noblock");
    const started = Date.now();
    const resultB = await createPendingPositionWithExecutionIntent(
      prisma,
      reserveInput(userB, sigB, 5),
      mockLogger()
    );
    userBDoneAt = Date.now();
    await holdA;

    expect(resultB.ok).toBe(true);
    if (resultB.ok) positionIds.push(resultB.position.id);
    // B should finish while A still held its lock (not waiting for A)
    expect(userBDoneAt).toBeLessThan(userAReleasedAt);
    expect(userBDoneAt - started).toBeLessThan(700);
  }, 60_000);

  it("transaction rollback releases advisory lock so next reserve succeeds", async () => {
    const userC = await createUser("userc");
    try {
      const lockKey = mt5CapacityAdvisoryLockKey(userC);
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
          throw new Error("force_rollback");
        })
      ).rejects.toThrow("force_rollback");

      const sig = await createSignal(userC, "after_rollback");
      const result = await createPendingPositionWithExecutionIntent(
        prisma,
        reserveInput(userC, sig, 5),
        mockLogger()
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.consumedSlotsAfter).toBe(1);
      }
    } finally {
      await prisma.user.deleteMany({ where: { id: userC } });
    }
  }, 60_000);
});
