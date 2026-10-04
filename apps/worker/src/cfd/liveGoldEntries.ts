import { isLiveGoldEntryPermissionEnabled } from "@regimex/shared";

/** Called for new entries only; reconciliation, closes and protective stops never use this gate. */
export async function liveGoldEntriesAllowed(
  input: { userId: string; executionMode: string; symbol: string },
  read?: (userId: string) => Promise<string | null>,
  onError?: (err: unknown) => void
): Promise<boolean> {
  if (input.executionMode !== "broker_real_mt5" || input.symbol !== "XAUUSD") return true;
  try { return isLiveGoldEntryPermissionEnabled(await read?.(input.userId)); }
  catch (err) { onError?.(err); return false; }
}
