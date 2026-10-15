import type { Candle } from "@regimex/shared";
import { assessDemoR10HtfShadow } from "./demoR10HtfShadow.js";

/** Used only by the scoped DEMO R_10 trend gate. Never repairs or overwrites existing candles. */
export class DemoR10EntryTrendHistory {
  private nextAttemptAt = 0;

  async read(fromMs: number, toMs: number, io: {
    read: () => Promise<readonly Candle[]>;
    fetch: () => Promise<readonly Candle[]>;
    insertMissing: (candles: readonly Candle[]) => Promise<void>;
  }): Promise<readonly Candle[]> {
    const existing = await io.read();
    const present = new Set(existing.map(c => c.openTime));
    const missing = new Set<number>();
    for (let time = fromMs; time < toMs; time += 60_000) if (!present.has(time)) missing.add(time);
    if (!missing.size || Date.now() < this.nextAttemptAt) return existing;
    // Limit broker reads during outages/partial history; failures keep the production gate closed.
    this.nextAttemptAt = Date.now() + 5 * 60_000;
    try {
      const fetched = (await io.fetch()).filter(c => missing.has(c.openTime));
      const combined = [...existing, ...fetched];
      const trend = assessDemoR10HtfShadow({ enabled: true, executionBackend: "broker_demo_mt5",
        mode: "DEMO_TRADING", symbol: "R_10", interval: "1m", action: "BUY",
        decisionCloseTimeMs: toMs, strategyId: "", signalId: "", correlationId: "" }, combined)
        ?.comparisons.find(c => c.interval === "15m");
      if (!trend || trend.qualityFlags.length || trend.wouldPassTrendFilter === null) return existing;
      await io.insertMissing(fetched);
      // Re-read actual persisted rows: concurrent inserts/conflicting provenance cannot be hidden.
      return await io.read();
    } catch {
      return existing;
    }
  }
}
