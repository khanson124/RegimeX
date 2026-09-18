/**
 * Engine configuration multi-symbol safety policy.
 * Default: preserve other active symbol tracks (R_10 + XAUUSD).
 */

export type EngineConfigurationScope = "preserve_others" | "replace_all_active";

export interface EngineConfigurationScopeInput {
  /** Legacy flag: false = replace all; true/omit = preserve (when deactivate not set). */
  retainOtherActiveConfigurations?: boolean;
  /** Explicit replace-all. Wins when true. */
  deactivateOtherActiveConfigurations?: boolean;
}

/**
 * Resolve whether updating one symbol should deactivate other active configs.
 *
 * Precedence:
 * 1. deactivateOtherActiveConfigurations === true → replace_all_active
 * 2. retainOtherActiveConfigurations === false → replace_all_active (legacy)
 * 3. otherwise → preserve_others (safe default for multi-symbol)
 */
export function resolveEngineConfigurationScope(
  input: EngineConfigurationScopeInput
): EngineConfigurationScope {
  if (input.deactivateOtherActiveConfigurations === true) return "replace_all_active";
  if (input.retainOtherActiveConfigurations === false) return "replace_all_active";
  return "preserve_others";
}

export interface ActiveEngineConfigRow {
  id: string;
  symbol: string;
  isActive: boolean;
}

/**
 * Which active configs should be deactivated before inserting a new row for `targetSymbol`.
 * - preserve_others: only same-symbol active rows
 * - replace_all_active: every active row
 */
export function selectEngineConfigsToDeactivate(
  activeRows: ActiveEngineConfigRow[],
  targetSymbol: string,
  scope: EngineConfigurationScope
): string[] {
  const active = activeRows.filter((r) => r.isActive);
  if (scope === "replace_all_active") {
    return active.map((r) => r.id);
  }
  return active.filter((r) => r.symbol === targetSymbol).map((r) => r.id);
}
