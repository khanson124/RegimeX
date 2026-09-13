import { type StrategyKind } from "@regimex/shared";
import { BreakoutMomentumStrategy, BREAKOUT_MOMENTUM_DEFAULTS } from "./breakoutMomentum.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "./emaPullback.js";
import { BollingerReversionStrategy, BOLLINGER_REVERSION_DEFAULTS } from "./bollingerReversion.js";
import { SqueezeBreakoutStrategy, SQUEEZE_BREAKOUT_DEFAULTS } from "./squeezeBreakout.js";
import {
  TrendStructurePullbackStrategy,
  TREND_STRUCTURE_PULLBACK_DEFAULTS
} from "./trendStructurePullback.js";
import {
  XauMtfStructureMomentumStrategy,
  XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS
} from "./xauMtfStructureMomentum.js";
import {
  XauVolatilityExpansionRetestStrategy,
  XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS
} from "./xauVolatilityExpansionRetest.js";
import {
  XauTrendPullbackStrategy,
  XAU_TREND_PULLBACK_DEFAULTS
} from "./xauTrendPullback.js";
import {
  XauTrendBreakoutV2Strategy,
  XAU_TREND_BREAKOUT_V2_DEFAULTS
} from "./xauTrendBreakoutV2.js";
import { type StrategyCatalogueEntry, type TradingStrategy } from "./types.js";

/** Instantiate a strategy implementation by kind. Strategies are stateless. */
export function createStrategy(kind: StrategyKind): TradingStrategy {
  switch (kind) {
    case "breakout-momentum":
      return new BreakoutMomentumStrategy();
    case "ema-pullback":
      return new EmaPullbackStrategy();
    case "bollinger-reversion":
      return new BollingerReversionStrategy();
    case "squeeze-breakout":
      return new SqueezeBreakoutStrategy();
    case "trend-structure-pullback":
      return new TrendStructurePullbackStrategy();
    case "xau-mtf-structure-momentum":
      // Research-only candidate — createStrategy does not enable MT5/live.
      return new XauMtfStructureMomentumStrategy();
    case "xau-volatility-expansion-retest":
      return new XauVolatilityExpansionRetestStrategy();
    case "xau-trend-pullback":
      return new XauTrendPullbackStrategy();
    case "xau-trend-breakout":
      return new XauTrendBreakoutV2Strategy();
  }
}

export const DEFAULT_STRATEGY_PARAMETERS: Record<StrategyKind, Record<string, number | boolean | string>> = {
  "breakout-momentum": BREAKOUT_MOMENTUM_DEFAULTS,
  "ema-pullback": EMA_PULLBACK_DEFAULTS,
  "bollinger-reversion": BOLLINGER_REVERSION_DEFAULTS,
  "squeeze-breakout": SQUEEZE_BREAKOUT_DEFAULTS,
  "trend-structure-pullback": TREND_STRUCTURE_PULLBACK_DEFAULTS,
  "xau-mtf-structure-momentum": XAU_MTF_STRUCTURE_MOMENTUM_DEFAULTS,
  "xau-volatility-expansion-retest": XAU_VOLATILITY_EXPANSION_RETEST_DEFAULTS,
  "xau-trend-pullback": XAU_TREND_PULLBACK_DEFAULTS,
  "xau-trend-breakout": XAU_TREND_BREAKOUT_V2_DEFAULTS
};

export const STRATEGY_CATALOGUE: StrategyCatalogueEntry[] = [
  {
    kind: "breakout-momentum",
    name: "Breakout Momentum",
    version: "1",
    description:
      "Trades confirmed Donchian breakouts in the direction of an established trend with ADX, MACD and volatility confirmation.",
    supportedRegimes: ["STRONG_UPTREND", "STRONG_DOWNTREND", "BREAKOUT_EXPANSION"],
    cfdCapable: true
  },
  {
    kind: "ema-pullback",
    name: "EMA Pullback",
    version: "1",
    description:
      "Buys rejection candles at the fast/slow EMA during pullbacks within an intact trend; mirrored for shorts.",
    supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "STRONG_DOWNTREND", "WEAK_DOWNTREND"],
    cfdCapable: true
  },
  {
    kind: "bollinger-reversion",
    name: "Bollinger Mean Reversion",
    version: "1",
    description:
      "Fades Bollinger band touches with RSI confirmation in ranging markets; blocked during trends and breakouts.",
    supportedRegimes: ["RANGE_LOW_VOLATILITY", "RANGE_HIGH_VOLATILITY"],
    cfdCapable: true
  },
  {
    kind: "squeeze-breakout",
    name: "Volatility Squeeze Breakout",
    version: "1",
    description:
      "Trades range expansions out of Bollinger-width squeezes with momentum and volatility confirmation.",
    supportedRegimes: ["VOLATILITY_COMPRESSION", "BREAKOUT_EXPANSION"],
    cfdCapable: true
  },
  {
    kind: "trend-structure-pullback",
    name: "Trend Structure Pullback",
    version: "1",
    description:
      "Research candidates (v1 hard gates; v2 contextual extension + entryQualityScore). IDs: trend-structure-pullback-v1 / v2. Does not replace ema-pullback-v1.",
    supportedRegimes: ["STRONG_UPTREND", "WEAK_UPTREND", "STRONG_DOWNTREND", "WEAK_DOWNTREND"],
    cfdCapable: true
  },
  {
    kind: "xau-mtf-structure-momentum",
    name: "XAU MTF Structure Momentum",
    version: "1",
    description:
      "Research-only XAUUSD multi-timeframe structure→pullback→continuation candidate (id xau-mtf-structure-momentum-v1). Not auto-enabled for MT5/live.",
    supportedRegimes: [
      "STRONG_UPTREND",
      "WEAK_UPTREND",
      "STRONG_DOWNTREND",
      "WEAK_DOWNTREND",
      "BREAKOUT_EXPANSION"
    ],
    cfdCapable: true
  },
  {
    kind: "xau-volatility-expansion-retest",
    name: "XAU Volatility Expansion Retest",
    version: "1",
    description:
      "Research-only XAUUSD compression→expansion→retest→acceptance candidate (id xau-volatility-expansion-retest-v1). Distinct from squeeze-breakout. Not auto-enabled for MT5/live.",
    supportedRegimes: [
      "VOLATILITY_COMPRESSION",
      "BREAKOUT_EXPANSION",
      "RANGE_LOW_VOLATILITY",
      "RANGE_HIGH_VOLATILITY",
      "TRANSITION"
    ],
    cfdCapable: true
  },
  {
    kind: "xau-trend-pullback",
    name: "XAU Trend Pullback",
    version: "1",
    description:
      "Research-only XAUUSD H4 EMA bias + M15 pullback/breakout candidate (id xau-trend-pullback-v1). Not auto-enabled for MT5/live.",
    supportedRegimes: [
      "STRONG_UPTREND",
      "WEAK_UPTREND",
      "STRONG_DOWNTREND",
      "WEAK_DOWNTREND",
      "BREAKOUT_EXPANSION"
    ],
    cfdCapable: true
  },
  {
    kind: "xau-trend-breakout",
    name: "XAU Trend Breakout",
    version: "2",
    description:
      "Research-only XAUUSD H4 EMA bias + M15 consolidation/structural breakout candidate (id xau-trend-breakout-v2). Not auto-enabled for MT5/live.",
    supportedRegimes: [
      "STRONG_UPTREND",
      "WEAK_UPTREND",
      "STRONG_DOWNTREND",
      "WEAK_DOWNTREND",
      "BREAKOUT_EXPANSION",
      "VOLATILITY_COMPRESSION"
    ],
    cfdCapable: true
  }
];
