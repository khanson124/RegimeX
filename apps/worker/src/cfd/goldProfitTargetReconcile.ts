import type { PrismaClient } from '@regimex/database';
import type { BrokerOpenPosition, BrokerQuote, ClosedPositionResult, ClosePositionRequest } from '@regimex/shared';
import type { Logger } from 'pino';
import type { ProfitLockLocalPosition } from './r10ProfitLockReconcile.js';
import { recordPositionEvent } from './paperPersistence.js';

// Shared by both DEMO sessions. Re-read under the guard; broker closes are ticket-idempotent.
const closingGoldTickets = new Set<string>();
type GoldPosition = ProfitLockLocalPosition & {
  strategyId: string; interval: string | null; origin: string; metadata: unknown; volume: unknown;
};
export async function applyDemoGoldProfitTargets(input: {
  executionMode: string; targetUsd: number | undefined; prisma: PrismaClient; logger: Logger;
  adapter: {
    getStatus(): { isDemo: boolean | null; currency?: string | null };
    getPosition(id: string): Promise<BrokerOpenPosition | null>;
    getQuote(symbol: string): Promise<BrokerQuote | null>;
    closePosition(request: ClosePositionRequest): Promise<ClosedPositionResult>;
  };
  brokerOpen: BrokerOpenPosition[]; localOpen: GoldPosition[];
}): Promise<void> {
  const { adapter, targetUsd, logger } = input;
  const status = adapter.getStatus();
  if (input.executionMode !== 'broker_demo_mt5' || status.isDemo !== true || status.currency !== 'USD'
    || targetUsd === undefined || !Number.isFinite(targetUsd) || targetUsd <= 0) return;
  for (const local of input.localOpen) {
    const meta = local.metadata as { executionModel?: string; ownedByRegimeX?: boolean } | null;
    if (local.symbol !== 'XAUUSD' || local.interval !== '15m' || local.strategyId !== 'xau-trend-pullback-v1'
      || local.origin !== 'ENGINE' || local.status !== 'OPEN' || meta?.executionModel !== 'broker_demo_mt5'
      || meta.ownedByRegimeX === false || !local.brokerPositionId) continue;
    const ticket = local.brokerPositionId;
    if (!input.brokerOpen.some(p => p.brokerPositionId === ticket) || closingGoldTickets.has(ticket)) continue;
    closingGoldTickets.add(ticket);
    try {
      const quote = await adapter.getQuote('XAUUSD');
      const age = quote ? Date.now() - quote.timestamp : Infinity;
      if (!quote || quote.symbol !== 'XAUUSD' || !Number.isFinite(age) || age < -1000 || age > 10000
        || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) continue;
      const fresh = await adapter.getPosition(ticket);
      if (!fresh || fresh.brokerPositionId !== ticket || fresh.symbol !== 'XAUUSD' || fresh.status !== 'OPEN'
        || fresh.direction !== local.direction || !Number.isFinite(fresh.volume) || fresh.volume <= 0
        || !Number.isFinite(Number(local.volume)) || Math.abs(fresh.volume - Number(local.volume)) > 1e-8
        || !Number.isFinite(fresh.floatingPnl) || fresh.floatingPnl < targetUsd) continue;
      const closed = await adapter.closePosition({ brokerPositionId: ticket, reason: 'TAKE_PROFIT', quote });
      if (closed.brokerPositionId !== ticket || !Number.isFinite(closed.closePrice) || closed.closePrice <= 0
        || !Number.isFinite(closed.realizedPnl) || !Number.isFinite(closed.closedAt) || closed.closedAt <= 0) {
        logger.warn({ event: 'DEMO_GOLD_PROFIT_TARGET_UNCONFIRMED', positionId: local.id }, 'Gold close acknowledgement mismatch');
        continue;
      }
      // Ordinary history reconciliation owns CLOSED state, evidence and notifications.
      // Remove this confirmed broker close from the snapshot so it can reconcile now.
      const index = input.brokerOpen.findIndex(p => p.brokerPositionId === ticket);
      if (index >= 0) input.brokerOpen.splice(index, 1);
      await recordPositionEvent(input.prisma, local.id, 'PROFIT_TARGET_CLOSE_CONFIRMED', {
        scope: 'DEMO_GOLD', targetUsd, triggerFloatingPnl: fresh.floatingPnl,
        brokerPositionId: ticket, realizedPnl: closed.realizedPnl, closePrice: closed.closePrice,
        brokerClosedAt: closed.closedAt
      });
      logger.info({ event: 'DEMO_GOLD_PROFIT_TARGET_CLOSED', positionId: local.id,
        brokerPositionId: ticket, targetUsd, triggerFloatingPnl: fresh.floatingPnl,
        realizedPnl: closed.realizedPnl }, 'Gold DEMO profit target close confirmed');
    } catch (err) {
      logger.warn({ err, event: 'DEMO_GOLD_PROFIT_TARGET_FAILED', positionId: local.id }, 'Gold DEMO profit close failed; reconcile before retry');
    } finally {
      closingGoldTickets.delete(ticket);
    }
  }
}
