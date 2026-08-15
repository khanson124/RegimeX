/** Lightweight correlation-id generator (no external dependency). */
export function correlationId(prefix = "cid"): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
