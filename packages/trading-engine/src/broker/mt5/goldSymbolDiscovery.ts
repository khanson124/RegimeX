import { type Mt5SymbolInfo, type Mt5TradePermission } from "./types.js";

/** Internal RegimeX symbol for spot gold CFD research/demo track. */
export const XAUUSD_INTERNAL_SYMBOL = "XAUUSD";

/**
 * Candidate broker names for Deriv/MT5 gold. Never treated as verified until
 * live `discoverSymbols` / `getInstrument` confirms the exact string.
 */
export const MT5_XAUUSD_MAPPING_CANDIDATES = [
  "XAUUSD",
  "Gold",
  "GOLD",
  "XAUUSDm",
  "XAUUSD.",
  "XAUUSD.a",
  "XAUUSD#"
] as const;

const GOLD_NAME_RE = /^(xauusd|gold)\b/i;
const GOLD_DESC_RE = /\b(gold|xau)\b/i;

export interface DiscoveredGoldSymbol {
  brokerSymbol: string;
  description: string;
  tradeAllowed: boolean;
  tradeMode: Mt5TradePermission;
  digits: number;
  point: number;
  tickSize: number;
  tickValue: number;
  contractSize: number;
  volumeMin: number;
  volumeStep: number;
  volumeMax: number;
  stopsLevel: number | null;
  freezeLevel: number | null;
  fillingModes: string[];
  bid: number | null;
  ask: number | null;
  spreadPrice: number | null;
  spreadBps: number | null;
  matchReason: "EXACT_CANDIDATE" | "NAME_PATTERN" | "DESCRIPTION_PATTERN";
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "");
}

function scoreGoldCandidate(info: Mt5SymbolInfo): { score: number; reason: DiscoveredGoldSymbol["matchReason"] } | null {
  const name = info.name.trim();
  const norm = normalizeName(name);
  for (const c of MT5_XAUUSD_MAPPING_CANDIDATES) {
    if (norm === normalizeName(c)) {
      return { score: 100, reason: "EXACT_CANDIDATE" };
    }
  }
  if (GOLD_NAME_RE.test(name)) {
    return { score: 80, reason: "NAME_PATTERN" };
  }
  if (GOLD_DESC_RE.test(info.description ?? "")) {
    return { score: 40, reason: "DESCRIPTION_PATTERN" };
  }
  return null;
}

export function selectBestGoldSymbol(
  symbols: ReadonlyArray<Mt5SymbolInfo>
): DiscoveredGoldSymbol | null {
  let best: { info: Mt5SymbolInfo; score: number; reason: DiscoveredGoldSymbol["matchReason"] } | null =
    null;
  for (const info of symbols) {
    const hit = scoreGoldCandidate(info);
    if (!hit) continue;
    // Prefer tradeAllowed FULL when scores tie.
    const tradeBoost = info.tradeAllowed && info.tradeMode === "FULL" ? 5 : info.tradeAllowed ? 2 : 0;
    const score = hit.score + tradeBoost;
    if (!best || score > best.score) {
      best = { info, score, reason: hit.reason };
    }
  }
  if (!best) return null;
  return toDiscoveredGold(best.info, best.reason);
}

export function toDiscoveredGold(
  info: Mt5SymbolInfo,
  matchReason: DiscoveredGoldSymbol["matchReason"]
): DiscoveredGoldSymbol {
  const bid = info.bid != null && Number.isFinite(info.bid) ? info.bid : null;
  const ask = info.ask != null && Number.isFinite(info.ask) ? info.ask : null;
  const spreadPrice = bid != null && ask != null ? ask - bid : null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const spreadBps =
    spreadPrice != null && mid != null && mid > 0 ? (spreadPrice / mid) * 10_000 : null;
  return {
    brokerSymbol: info.name,
    description: info.description,
    tradeAllowed: info.tradeAllowed,
    tradeMode: info.tradeMode,
    digits: info.digits,
    point: info.point,
    tickSize: info.tickSize,
    tickValue: info.tickValue,
    contractSize: info.contractSize,
    volumeMin: info.volumeMin,
    volumeStep: info.volumeStep,
    volumeMax: info.volumeMax,
    stopsLevel: info.stopsLevel ?? null,
    freezeLevel: info.freezeLevel ?? null,
    fillingModes: info.fillingModes ?? [],
    bid,
    ask,
    spreadPrice,
    spreadBps,
    matchReason
  };
}

export function isTradableGoldDiscovery(d: DiscoveredGoldSymbol): boolean {
  return d.tradeAllowed && (d.tradeMode === "FULL" || d.tradeMode === "LONGONLY" || d.tradeMode === "SHORTONLY");
}
