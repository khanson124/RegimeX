/** Dark trading-dashboard theme tokens. */
export const colors = {
  bg: "#0B0F14",
  surface: "#121820",
  surfaceRaised: "#1A222C",
  border: "#232E3A",
  text: "#E8EEF4",
  textDim: "#8B98A5",
  textFaint: "#5C6873",
  accent: "#4C9AFF",
  // Profit/loss are never conveyed by color alone — always pair with labels/icons.
  up: "#22C55E",
  down: "#EF4444",
  warning: "#F59E0B",
  danger: "#DC2626",
  neutral: "#64748B"
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16
} as const;

export const font = {
  metricLarge: 28,
  metric: 20,
  title: 18,
  body: 15,
  caption: 12
} as const;

export const REGIME_LABELS: Record<string, string> = {
  STRONG_UPTREND: "Strong Uptrend",
  WEAK_UPTREND: "Weak Uptrend",
  STRONG_DOWNTREND: "Strong Downtrend",
  WEAK_DOWNTREND: "Weak Downtrend",
  RANGE_LOW_VOLATILITY: "Range (Low Vol)",
  RANGE_HIGH_VOLATILITY: "Range (High Vol)",
  BREAKOUT_EXPANSION: "Breakout",
  VOLATILITY_COMPRESSION: "Compression",
  TRANSITION: "Transition",
  UNKNOWN: "Unknown"
};
