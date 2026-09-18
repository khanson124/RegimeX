/**
 * RegimeX design tokens — dark fintech product UI.
 * Inspired by modern finance apps (Pailo-like hierarchy), not a literal clone.
 * P/L is never color-only — always pair with labels.
 */
export const colors = {
  bg: "#070B12",
  bgElevated: "#0C121C",
  surface: "#121A26",
  surfaceRaised: "#182233",
  surfaceMuted: "#0F1620",
  border: "#1E2A3A",
  borderStrong: "#2A3A4F",
  text: "#F4F6FA",
  textDim: "#9AA3B5",
  textFaint: "#667085",
  accent: "#4DB8D9",
  accentMuted: "#163644",
  accentSoft: "#122A36",
  up: "#3DDC97",
  upMuted: "#123528",
  down: "#FF6B7A",
  downMuted: "#3A1520",
  warning: "#F5C451",
  warningMuted: "#3A2E12",
  danger: "#E5484D",
  neutral: "#6B7789",
  overlay: "rgba(7, 11, 18, 0.72)"
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  section: 28
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999
} as const;

export const font = {
  hero: 40,
  metricLarge: 28,
  metric: 18,
  title: 17,
  body: 15,
  caption: 12,
  micro: 11
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
