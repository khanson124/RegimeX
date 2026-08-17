/**
 * Seed data: synthetic symbols, default strategies + parameters,
 * regime configuration, conservative risk profile, local dev user,
 * and deterministic mock candle history for offline development.
 */
import argon2 from "argon2";
import { getPrisma, disconnectPrisma } from "./index.js";
import {
  DEFAULT_STRATEGY_PARAMETERS,
  DEFAULT_REGIME_THRESHOLDS,
  REGIME_CLASSIFIER_VERSION,
  STRATEGY_CATALOGUE
} from "@regimex/trading-engine";

const prisma = getPrisma();

const SYMBOLS = [
  { derivSymbol: "R_10", displayName: "Volatility 10 Index", pricePrecision: 3 },
  { derivSymbol: "R_25", displayName: "Volatility 25 Index", pricePrecision: 3 },
  { derivSymbol: "R_50", displayName: "Volatility 50 Index", pricePrecision: 4 },
  { derivSymbol: "R_75", displayName: "Volatility 75 Index", pricePrecision: 4 },
  { derivSymbol: "R_100", displayName: "Volatility 100 Index", pricePrecision: 2 }
];

/** Deterministic PRNG (mulberry32) so seeded candles are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedSymbols(): Promise<void> {
  for (const s of SYMBOLS) {
    await prisma.symbol.upsert({
      where: { derivSymbol: s.derivSymbol },
      create: { ...s, enabled: true, candleIntervals: ["1m", "5m"] },
      update: { displayName: s.displayName, pricePrecision: s.pricePrecision }
    });
  }
  console.warn(`Seeded ${SYMBOLS.length} symbols`);
}

async function seedStrategies(): Promise<void> {
  for (const meta of STRATEGY_CATALOGUE) {
    const existing = await prisma.strategyDefinition.findFirst({
      where: { kind: meta.kind, userId: null }
    });
    if (existing) continue;
    await prisma.strategyDefinition.create({
      data: {
        kind: meta.kind,
        name: meta.name,
        description: meta.description,
        enabled: true,
        versions: {
          create: {
            version: meta.version,
            isActive: true,
            parameterSets: {
              create: {
                parameters: DEFAULT_STRATEGY_PARAMETERS[meta.kind],
                isActive: true,
                origin: "SEED"
              }
            }
          }
        }
      }
    });
  }
  console.warn("Seeded default strategies");
}

async function seedRegimeConfiguration(): Promise<void> {
  await prisma.regimeConfiguration.upsert({
    where: { name: "default" },
    create: {
      name: "default",
      classifierVersion: REGIME_CLASSIFIER_VERSION,
      thresholds: DEFAULT_REGIME_THRESHOLDS as object,
      isActive: true
    },
    update: {
      classifierVersion: REGIME_CLASSIFIER_VERSION,
      thresholds: DEFAULT_REGIME_THRESHOLDS as object
    }
  });
  console.warn("Seeded regime configuration");
}

async function seedDevUserAccount(): Promise<string> {
  const email = "dev@regimex.local";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing.id;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await argon2.hash("Passw0rd!?")
    }
  });
  console.warn(`Seeded dev user ${email} (password: Passw0rd!?)`);
  return user.id;
}

async function seedRiskProfile(userId: string): Promise<void> {
  await prisma.riskProfile.upsert({
    where: { userId_name: { userId, name: "Conservative" } },
    create: {
      userId,
      name: "Conservative",
      isActive: true,
      demoOnly: true,
      fixedStake: 0.5,
      maxStakePerTrade: 1,
      maxDailyLoss: 5,
      maxDailyTrades: 10,
      maxConsecutiveLosses: 3,
      maxSimultaneousContracts: 1,
      minCooldownSeconds: 120,
      maxDrawdownPercent: 10,
      minBalance: 100,
      maxDataAgeSeconds: 30,
      maxSignalAgeSeconds: 30
    },
    update: {}
  });
  console.warn("Seeded conservative risk profile");
}

async function seedMockCandlesData(): Promise<void> {
  const symbol = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
  if (!symbol) return;
  const count = await prisma.candle.count({
    where: { symbolId: symbol.id, interval: "1m", source: "SEED" }
  });
  if (count > 0) {
    console.warn("Mock candles already present, skipping");
    return;
  }

  const rand = mulberry32(42);
  const candles: Array<{
    symbolId: string;
    interval: string;
    openTime: Date;
    closeTime: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    tickCount: number;
    isComplete: boolean;
    source: string;
  }> = [];

  const total = 4320; // 3 days of 1m candles
  const end = Date.now() - (Date.now() % 60_000);
  let price = 6300;
  for (let i = total; i > 0; i--) {
    const openTime = end - i * 60_000;
    const open = price;
    // Random walk with mild regime cycling for realistic variety.
    const phase = Math.floor(i / 480) % 3;
    const drift = phase === 0 ? 0.3 : phase === 1 ? -0.3 : 0;
    const vol = phase === 2 ? 1.2 : 2.4;
    const c1 = open + (rand() - 0.5) * vol + drift;
    const c2 = open + (rand() - 0.5) * vol + drift;
    const close = open + (rand() - 0.5) * vol + drift;
    const high = Math.max(open, c1, c2, close) + rand() * 0.4;
    const low = Math.min(open, c1, c2, close) - rand() * 0.4;
    price = close;
    candles.push({
      symbolId: symbol.id,
      interval: "1m",
      openTime: new Date(openTime),
      closeTime: new Date(openTime + 60_000),
      open: Number(open.toFixed(3)),
      high: Number(high.toFixed(3)),
      low: Number(low.toFixed(3)),
      close: Number(close.toFixed(3)),
      tickCount: 30,
      isComplete: true,
      source: "SEED"
    });
  }

  // createMany in chunks
  for (let i = 0; i < candles.length; i += 500) {
    await prisma.candle.createMany({
      data: candles.slice(i, i + 500),
      skipDuplicates: true
    });
  }
  console.warn(`Seeded ${candles.length} mock 1m candles for R_10`);
}

async function main(): Promise<void> {
  await seedSymbols();
  await seedStrategies();
  await seedRegimeConfiguration();

  const seedDevUser = process.env.SEED_DEV_USER !== "false";
  if (seedDevUser) {
    const userId = await seedDevUserAccount();
    await seedRiskProfile(userId);
  } else {
    console.warn("Skipping dev user (SEED_DEV_USER=false)");
  }

  const seedMockCandles = process.env.SEED_MOCK_CANDLES === "true";
  if (seedMockCandles) {
    await seedMockCandlesData();
  } else {
    console.warn("Skipping mock candles (SEED_MOCK_CANDLES is not true)");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
