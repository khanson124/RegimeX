import { type Mt5BridgePosition } from "./types.js";

export interface Mt5OwnershipFilter {
  magic: number;
}

export function isRegimeXMt5Position(position: Mt5BridgePosition, magic: number): boolean {
  return position.magic === magic;
}

/**
 * Emergency / manual close may only target RegimeX-owned tickets that already
 * have a local PostgreSQL row. Untracked broker positions are listed, never closed.
 */
export function selectMt5PositionsForEmergencyClose(input: {
  brokerOpen: Mt5BridgePosition[];
  localBrokerIds: Set<string>;
  magic: number;
}): { close: string[]; skipExternal: string[] } {
  const close: string[] = [];
  const skipExternal: string[] = [];
  for (const p of input.brokerOpen) {
    const id = String(p.positionTicket);
    const owned = isRegimeXMt5Position(p, input.magic);
    if (!owned || !input.localBrokerIds.has(id)) {
      skipExternal.push(id);
      continue;
    }
    close.push(id);
  }
  return { close, skipExternal };
}

export function findMt5PositionByIdempotency(
  positions: Mt5BridgePosition[],
  input: { magic: number; comment: string; idempotencyKey?: string }
): Mt5BridgePosition | undefined {
  return positions.find((p) => {
    if (p.magic !== input.magic) return false;
    if (p.comment && input.comment && p.comment === input.comment) return true;
    return false;
  });
}
