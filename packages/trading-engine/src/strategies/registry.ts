import { type StrategyKind } from "@regimex/shared";
import { BreakoutMomentumStrategy, BREAKOUT_MOMENTUM_DEFAULTS } from "./breakoutMomentum.js";
import { EmaPullbackStrategy, EMA_PULLBACK_DEFAULTS } from "./emaPullback.js";
import { BollingerReversionStrategy, BOLLINGER_REVERSION_DEFAULTS } from "./bollingerReversion.js";
import { SqueezeBreakoutStrategy, SQUEEZE_BREAKOUT_DEFAULTS } from "./squeezeBreakout.js";
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
  }
}

export const DEFAULT_STRATEGY_PARAMETERS: Record<StrategyKind, Record<string, number | boolean | string>> = {
  "breakout-momentum": BREAKOUT_MOMENTUM_DEFAULTS,
  "ema-pullback": EMA_PULLBACK_DEFAULTS,
  "bollinger-reversion": BOLLINGER_REVERSION_DEFAULTS,
  "squeeze-breakout": SQUEEZE_BREAKOUT_DEFAULTS
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
  }
];
