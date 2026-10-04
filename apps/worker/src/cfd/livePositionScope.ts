/** REAL recovery/reconciliation must never act on DEMO or unclassified position history. */
export function livePositionFilter(executionMode?: string) {
  return executionMode === "broker_real_mt5"
    ? { metadata: { path: ["executionModel"], equals: "broker_real_mt5" } }
    : {};
}
export function positionMatchesLiveScope(executionMode: string | undefined, metadata: unknown): boolean {
  return executionMode !== "broker_real_mt5" || (metadata != null && typeof metadata === "object" &&
    "executionModel" in metadata && metadata.executionModel === "broker_real_mt5");
}
