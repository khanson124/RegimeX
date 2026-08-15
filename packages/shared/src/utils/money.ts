/**
 * Decimal-safe money helpers. Account currency amounts are handled as
 * integer cents internally to avoid binary floating point drift
 * (e.g. 0.1 + 0.2). All public functions accept/return plain numbers
 * that are guaranteed to be exact at 2 decimal places.
 */

const CENTS = 100;

export function toCents(amount: number): number {
  return Math.round(amount * CENTS);
}

export function fromCents(cents: number): number {
  return cents / CENTS;
}

export function addMoney(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b));
}

export function subtractMoney(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}

/** Multiply an amount by a factor (e.g. payout ratio), rounding to cents. */
export function multiplyMoney(amount: number, factor: number): number {
  return fromCents(Math.round(toCents(amount) * factor));
}

export function roundMoney(amount: number): number {
  return fromCents(toCents(amount));
}

/** Round a price to a symbol's precision (decimal places). */
export function roundPrice(price: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round(price * f) / f;
}
