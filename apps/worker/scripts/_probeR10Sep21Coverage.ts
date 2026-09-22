#!/usr/bin/env tsx
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): void {
  for (const p of [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let val = m[2]!.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
    }
    break;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const { PrismaClient } = await import("@regimex/database");
  const prisma = new PrismaClient();
  try {
    const sym = await prisma.symbol.findUnique({ where: { derivSymbol: "R_10" } });
    if (!sym) {
      console.log(JSON.stringify({ error: "NO_SYMBOL" }));
      return;
    }
    const agg = await prisma.candle.aggregate({
      where: { symbolId: sym.id, interval: "1m", isComplete: true },
      _min: { openTime: true },
      _max: { openTime: true },
      _count: true
    });
    const sep21 = await prisma.candle.count({
      where: {
        symbolId: sym.id,
        interval: "1m",
        isComplete: true,
        openTime: { gte: new Date("2026-09-21T00:00:00.000Z"), lt: new Date("2026-09-22T00:00:00.000Z") }
      }
    });
    const near = await prisma.candle.findMany({
      where: {
        symbolId: sym.id,
        interval: "1m",
        isComplete: true,
        openTime: { gte: new Date("2026-09-20T00:00:00.000Z"), lt: new Date("2026-09-22T00:00:00.000Z") },
        high: { gte: 5010, lte: 5030 }
      },
      orderBy: { openTime: "asc" },
      take: 40
    });
    console.log(
      JSON.stringify(
        {
          overall: {
            count: agg._count,
            min: agg._min.openTime?.toISOString() ?? null,
            max: agg._max.openTime?.toISOString() ?? null
          },
          sep21Count: sep21,
          near5021Sample: near.map((c) => ({
            t: c.openTime.toISOString(),
            o: Number(c.open),
            h: Number(c.high),
            l: Number(c.low),
            c: Number(c.close),
            src: c.source
          }))
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
