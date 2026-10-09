/** DEMO Gold protection uses original fill-to-stop risk, never the tightened stop. */
export function goldProtectedStop(input: {
  direction: string; entry: number; initialStop: number; currentStop: number;
  market: number; tickSize: number; point: number; stopsLevel: number; freezeLevel: number;
}): { stop: number; favorableR: number; protectedR: number } | null {
  const { direction, entry, initialStop, currentStop, market, tickSize, point, stopsLevel, freezeLevel } = input;
  if (![entry, initialStop, currentStop, market, tickSize, point].every(v => Number.isFinite(v) && v > 0)
    || ![stopsLevel, freezeLevel].every(v => Number.isFinite(v) && v >= 0)
    || (direction !== 'BUY' && direction !== 'SELL')) return null;
  const sign = direction === 'BUY' ? 1 : -1;
  const risk = sign * (entry - initialStop);
  if (risk <= 0) return null;
  const favorableR = sign * (market - entry) / risk;
  if (favorableR < 1) return null;
  const protectedR = favorableR >= 1.5 ? 0.5 : 0.1;
  const raw = entry + sign * risk * protectedR;
  // Round away from the market; preserve the broker's minimum stop distance.
  const stop = Number(((sign === 1 ? Math.floor(raw / tickSize) : Math.ceil(raw / tickSize)) * tickSize).toFixed(8));
  const minDistance = Math.max(stopsLevel, freezeLevel) * point + tickSize;
  if (sign * (stop - currentStop) < tickSize / 2 || sign * (market - stop) < minDistance
    || sign * (stop - entry) <= 0) return null;
  return { stop, favorableR, protectedR };
}
