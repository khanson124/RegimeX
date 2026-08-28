/**
 * Merges CFD strategy defaults with partial overrides.
 * Undefined override values are ignored so they never clobber defaults.
 * Explicit 0 values are preserved when validation permits them.
 */
export function mergeCfdParams<T extends object>(defaults: T, overrides?: Partial<T>): T {
  const merged = { ...defaults };
  if (!overrides) return merged;
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    if (overrides[key] !== undefined) {
      merged[key] = overrides[key]!;
    }
  }
  return merged;
}
