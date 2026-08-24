import { type Mt5FillingMode } from "./types.js";

/** Native SYMBOL_FILLING_MODE bits (MQL5). */
export const SYMBOL_FILLING_FOK = 1;
export const SYMBOL_FILLING_IOC = 2;

export const FILLING_MODE_UNSUPPORTED = "MT5_FILLING_MODE_UNSUPPORTED";

/**
 * Deterministic preference when multiple modes are supported:
 * FOK (complete fill or nothing) → IOC → RETURN.
 * Never rotate through modes after a broker rejection.
 */
export const FILLING_MODE_PREFERENCE: Mt5FillingMode[] = ["FOK", "IOC", "RETURN"];

export function parseSupportedFillingModes(input: {
  fillingModeMask?: number | null;
  fillingModes?: unknown;
  fillingMode?: string | null;
}): Mt5FillingMode[] {
  if (Array.isArray(input.fillingModes)) {
    const parsed = input.fillingModes
      .map((m) => String(m).toUpperCase())
      .filter((m): m is Mt5FillingMode => m === "FOK" || m === "IOC" || m === "RETURN");
    if (parsed.length) return unique(parsed);
  }

  if (typeof input.fillingModeMask === "number" && Number.isFinite(input.fillingModeMask) && input.fillingModeMask >= 0) {
    const modes: Mt5FillingMode[] = [];
    if ((input.fillingModeMask & SYMBOL_FILLING_FOK) === SYMBOL_FILLING_FOK) modes.push("FOK");
    if ((input.fillingModeMask & SYMBOL_FILLING_IOC) === SYMBOL_FILLING_IOC) modes.push("IOC");
    // Mask 0 means MT5 ORDER_FILLING_RETURN (neither FOK nor IOC required).
    if (modes.length === 0) modes.push("RETURN");
    return modes;
  }

  const named = String(input.fillingMode ?? "").toUpperCase();
  if (named === "FOK" || named === "IOC" || named === "RETURN") return [named];
  return [];
}

export function selectFillingMode(supported: Mt5FillingMode[]): Mt5FillingMode | null {
  for (const mode of FILLING_MODE_PREFERENCE) {
    if (supported.includes(mode)) return mode;
  }
  return null;
}

export function assertFillingModeSupported(
  requested: Mt5FillingMode | string | null | undefined,
  supported: Mt5FillingMode[]
): asserts requested is Mt5FillingMode {
  const mode = String(requested ?? "").toUpperCase();
  if (!supported.includes(mode as Mt5FillingMode)) {
    throw new Error(FILLING_MODE_UNSUPPORTED);
  }
}

function unique(modes: Mt5FillingMode[]): Mt5FillingMode[] {
  return FILLING_MODE_PREFERENCE.filter((m) => modes.includes(m));
}
