/** A separate entry permission, never a replacement for LIVE arming or risk gates. */
export const liveGoldEntryPermissionKey = (userId: string): string => `engine:live-gold-entry-permission:${userId}`;
export const LIVE_GOLD_ENTRIES_DISABLED = "LIVE_GOLD_ENTRIES_DISABLED";
export const isLiveGoldEntryPermissionEnabled = (raw: string | null | undefined): boolean => raw === "enabled";
