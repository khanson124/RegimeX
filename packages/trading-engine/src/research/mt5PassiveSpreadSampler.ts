import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  quotedSpreadSampleFromPassive,
  type Mt5CostQualityFlag
} from "./mt5CostTelemetry.js";

export interface PassiveSpreadSampleRecord {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spreadPrice: number;
  spreadBps: number;
  spreadPoints: number | null;
  brokerQuoteTimestampMs: number | null;
  localReceivedAtMs: number;
  qualityFlags: Mt5CostQualityFlag[];
  source: "MT5_PASSIVE_QUOTE_POLL" | "MT5_OBSERVATION_CLI";
}

export interface Mt5PassiveSpreadSamplerOptions {
  symbol: string;
  /** Minimum ms between persisted samples (default 60_000). */
  intervalMs?: number;
  /** JSONL path for research-only persistence. */
  outPath?: string;
  tickSize?: number;
  source?: PassiveSpreadSampleRecord["source"];
}

/**
 * Throttled in-process spread sampler. Safe to call from the MT5 quote poll loop.
 * Does not affect trading decisions.
 */
export class Mt5PassiveSpreadSampler {
  private lastSampleAt = 0;
  private readonly intervalMs: number;
  private readonly outPath: string;
  private readonly symbol: string;
  private readonly tickSize: number;
  private readonly source: PassiveSpreadSampleRecord["source"];
  private sampleCount = 0;

  constructor(opts: Mt5PassiveSpreadSamplerOptions) {
    this.symbol = opts.symbol;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.outPath =
      opts.outPath ??
      `${process.cwd()}/research-datasets/${opts.symbol}_mt5_passive_spread_samples.jsonl`;
    this.tickSize = opts.tickSize ?? 0.001;
    this.source = opts.source ?? "MT5_PASSIVE_QUOTE_POLL";
  }

  get persistedCount(): number {
    return this.sampleCount;
  }

  /** Returns the sample when one was persisted; otherwise null (throttled/invalid). */
  maybeSample(input: {
    bid: number;
    ask: number;
    brokerQuoteTimestampMs?: number | null;
    localReceivedAtMs?: number;
    nowMs?: number;
  }): PassiveSpreadSampleRecord | null {
    if (this.intervalMs <= 0) return null;
    const now = input.nowMs ?? Date.now();
    if (this.lastSampleAt > 0 && now - this.lastSampleAt < this.intervalMs) return null;

    const localReceivedAtMs = input.localReceivedAtMs ?? now;
    const measured = quotedSpreadSampleFromPassive({
      bid: input.bid,
      ask: input.ask,
      brokerQuoteTimestampMs: input.brokerQuoteTimestampMs ?? null,
      localReceivedAtMs,
      tickSize: this.tickSize
    });
    if (measured.quality !== "OK") return null;

    const record: PassiveSpreadSampleRecord = {
      symbol: this.symbol,
      bid: measured.bid,
      ask: measured.ask,
      mid: measured.mid,
      spreadPrice: measured.spreadPrice,
      spreadBps: measured.spreadBps,
      spreadPoints: measured.spreadPoints,
      brokerQuoteTimestampMs: input.brokerQuoteTimestampMs ?? null,
      localReceivedAtMs,
      qualityFlags: measured.qualityFlags,
      source: this.source
    };

    this.lastSampleAt = now;
    this.persist(record);
    this.sampleCount++;
    return record;
  }

  private persist(record: PassiveSpreadSampleRecord): void {
    try {
      mkdirSync(dirname(this.outPath), { recursive: true });
      appendFileSync(this.outPath, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // Research-only path — never throw into the live quote loop.
    }
  }
}

export function loadPassiveSpreadSamples(path: string): PassiveSpreadSampleRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const out: PassiveSpreadSampleRecord[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as PassiveSpreadSampleRecord);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function writePassiveSpreadSummary(path: string, summary: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
