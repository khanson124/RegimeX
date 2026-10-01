import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type PrismaClient } from "@regimex/database";
import { XAU_BROKER_MIN_VOLUME, XAU_BROKER_VOLUME_STEP } from "@regimex/trading-engine";
import { loadXauRiskCapInputs } from "./xauRiskCapComparisonLoader.js";

const M15 = 15 * 60_000;
const H4 = 4 * 3_600_000;
const START = Date.UTC(2026, 8, 1);

function row(openTime: number, span: number, px: number) {
  return {
    openTime: new Date(openTime),
    closeTime: new Date(openTime + span),
    open: px,
    high: px + 1,
    low: px - 1,
    close: px,
    tickCount: 5,
    source: "MT5_HISTORY",
    isComplete: true
  };
}

/** Prisma double: every model method is recorded; anything but find* throws. */
function readOnlyPrisma(calls: string[]): PrismaClient {
  const m15 = Array.from({ length: 50 }, (_, i) => row(START + i * M15, M15, 2600 + i * 0.1));
  const h4 = Array.from({ length: 10 }, (_, i) => row(START - 10 * H4 + i * H4, H4, 2590 + i));
  const handlers: Record<string, Record<string, (args: any) => unknown>> = {
    symbol: { findUnique: () => ({ id: "sym-xau", derivSymbol: "XAUUSD", pricePrecision: 2 }) },
    candle: {
      findFirst: (a) => ({ openTime: a.orderBy.openTime === "asc" ? m15[0]!.openTime : m15.at(-1)!.openTime }),
      findMany: (a) => (a.where.interval === "4h" ? h4 : m15)
    },
    strategyDefinition: { findMany: () => [] },
    brokerSymbolMapping: {
      findFirst: () => ({ brokerSymbol: "XAUUSD", tickSize: 0.01, tickValue: 1, contractSize: 100, maxVolume: 50, minVolume: 0.1, volumeStep: 0.1 })
    },
    instrumentMetadata: { findUnique: () => null }
  };
  return new Proxy({} as PrismaClient, {
    get(_t, model: string) {
      return new Proxy(
        {},
        {
          get(_m, method: string) {
            return async (args: unknown) => {
              calls.push(`${model}.${method}`);
              if (!method.startsWith("find")) throw new Error(`DB write attempted: ${model}.${method}`);
              const h = handlers[model]?.[method];
              if (!h) throw new Error(`Unexpected ${model}.${method}`);
              return h(args);
            };
          }
        }
      );
    }
  });
}

const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

describe("XAU risk-cap comparison loader (read-only)", () => {
  it("performs only find* queries and forces the 0.01 broker lot", async () => {
    const calls: string[] = [];
    const loaded = await loadXauRiskCapInputs(readOnlyPrisma(calls), { symbol: "XAUUSD" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => /\.find(Unique|First|Many)$/.test(c))).toBe(true);
    expect(loaded.m15).toHaveLength(50);
    expect(loaded.h4).toHaveLength(10);
    expect(loaded.instrument).toMatchObject({
      minVolume: XAU_BROKER_MIN_VOLUME,
      volumeStep: XAU_BROKER_VOLUME_STEP,
      tickSize: 0.01,
      tickValue: 1,
      contractSize: 100,
      spreadBps: 0,
      slippageBps: 0
    });
    expect(loaded.parametersSource).toContain("XAU_TREND_PULLBACK_DEFAULTS");
  });

  it("CLI, loader and research module contain no DB writes or config/env mutation", () => {
    const sources = {
      cli: read("../../scripts/replayXauRiskCapComparison.ts"),
      loader: read("./xauRiskCapComparisonLoader.ts"),
      module: read("../../../../packages/trading-engine/src/research/xauRiskCapComparison.ts")
    };
    const writeCall = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/;
    for (const [name, src] of Object.entries(sources)) {
      expect(writeCall.test(src), name).toBe(false);
      expect(/config\.[A-Z_]+\s*=[^=]/.test(src), name).toBe(false);
    }
    expect(/@regimex\/database|PrismaClient/.test(sources.module)).toBe(false);
    // Only the env-file loader fills unset process.env keys; nothing else assigns env.
    expect(sources.cli.match(/process\.env\[[^\]]+\]\s*=[^=]/g)).toEqual(["process.env[key] = "]);
    expect(sources.loader.includes("process.env")).toBe(false);
    // Every file write targets the research output directory.
    const writes = sources.cli.match(/writeFileSync\(([^,]+),/g) ?? [];
    expect(writes).toHaveLength(4);
    expect(writes.every((w) => w.includes("paths."))).toBe(true);
    expect(sources.cli).toContain('"../../research-datasets/xau-risk-cap-comparison"');
  });

  it("session-hours CLI is read-only and does not mutate DEMO/REAL config", () => {
    const cli = read("../../scripts/replayXauSessionHoursComparison.ts");
    const moduleSrc = read("../../../../packages/trading-engine/src/research/xauSessionHoursComparison.ts");
    const writeCall = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|\$transaction/;
    expect(writeCall.test(cli)).toBe(false);
    expect(writeCall.test(moduleSrc)).toBe(false);
    expect(/config\.[A-Z_]+\s*=[^=]/.test(cli)).toBe(false);
    expect(moduleSrc).not.toContain("resolveMt5EngineRiskCap");
    expect(cli.match(/process\.env\[[^\]]+\]\s*=[^=]/g)).toEqual(["process.env[key] = "]);
    const writes = cli.match(/writeFileSync\(([^,]+),/g) ?? [];
    expect(writes).toHaveLength(4);
    expect(writes.every((w) => w.includes("paths."))).toBe(true);
    expect(cli).toContain('"../../research-datasets/xau-session-hours-comparison"');
    expect(cli).toContain("XAU_SESSION_HOURS_RISK_PERCENT");
  });
});
