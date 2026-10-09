import type { PrismaClient } from '@regimex/database';
import type { BrokerOpenPosition, BrokerQuote } from '@regimex/shared';
import type { Logger } from 'pino';
import type { ProfitLockLocalPosition } from './r10ProfitLockReconcile.js';
import { recordPositionEvent } from './paperPersistence.js';
import { goldProtectedStop } from './goldProfitLock.js';

type GoldPosition = ProfitLockLocalPosition & {
  strategyId: string; interval: string | null; origin: string; metadata: unknown;
};
type SymbolSpec = { tickSize: number; point: number; stopsLevel?: number | null; freezeLevel?: number | null };
export async function applyDemoGoldProfitLocks(input: {
  executionMode: string; prisma: PrismaClient; logger: Logger;
  adapter: {
    getStatus(): { isDemo: boolean | null };
    getQuote(symbol: string): Promise<BrokerQuote | null>;
    getLiveSymbol(symbol: string): Promise<SymbolSpec | null>;
    modifyPosition(request: { brokerPositionId: string; stopLoss: number; takeProfit: number | null }): Promise<BrokerOpenPosition>;
  };
  brokerOpen: BrokerOpenPosition[]; localOpen: GoldPosition[];
}): Promise<void> {
  const { adapter, prisma, logger } = input;
  if (input.executionMode !== 'broker_demo_mt5' || adapter.getStatus().isDemo !== true) return;
  for (const local of input.localOpen) {
    const metadata = local.metadata as { executionModel?: string } | null;
    if (local.symbol !== 'XAUUSD' || local.interval !== '15m' || local.origin !== 'ENGINE'
      || local.strategyId !== 'xau-trend-pullback-v1' || local.status !== 'OPEN'
      || metadata?.executionModel !== 'broker_demo_mt5' || !local.brokerPositionId) continue;
    const broker = input.brokerOpen.find(p => p.brokerPositionId === local.brokerPositionId);
    if (!broker || broker.symbol !== 'XAUUSD' || broker.status !== 'OPEN' || broker.direction !== local.direction) continue;
    try {
      const spec = await adapter.getLiveSymbol(broker.symbol);
      const quote = await adapter.getQuote(broker.symbol);
      const age = quote ? Date.now() - quote.timestamp : Infinity;
      if (!spec || !quote || quote.symbol !== broker.symbol || !Number.isFinite(age) || age < -1000 || age > 10000
        || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid
        || Math.abs(Number(local.entryPrice) - broker.entryPrice) > spec.tickSize) continue;
      const market = broker.direction === 'BUY' ? quote.bid : quote.ask;
      const decision = goldProtectedStop({ direction: broker.direction, entry: Number(local.entryPrice),
        initialStop: Number(local.initialStopLoss), currentStop: broker.stopLoss, market,
        tickSize: spec.tickSize, point: spec.point, stopsLevel: spec.stopsLevel ?? NaN, freezeLevel: spec.freezeLevel ?? NaN });
      if (!decision) continue;
      const confirmed = await adapter.modifyPosition({ brokerPositionId: broker.brokerPositionId,
        stopLoss: decision.stop, takeProfit: broker.takeProfit });
      // Persist the returned broker stop, never an unacknowledged proposal.
      if (confirmed.brokerPositionId !== broker.brokerPositionId || confirmed.symbol !== broker.symbol
        || confirmed.direction !== broker.direction || confirmed.status !== 'OPEN'
        || !Number.isFinite(confirmed.stopLoss) || Math.abs(confirmed.stopLoss - decision.stop) > spec.tickSize / 2
        || (broker.direction === 'BUY' ? confirmed.stopLoss <= broker.stopLoss || confirmed.stopLoss <= broker.entryPrice
          : confirmed.stopLoss >= broker.stopLoss || confirmed.stopLoss >= broker.entryPrice)
        || confirmed.takeProfit !== broker.takeProfit) {
        logger.warn({ event: 'DEMO_GOLD_PROFIT_LOCK_UNCONFIRMED', positionId: local.id }, 'Gold stop acknowledgement mismatch');
        continue;
      }
      const oldStopLoss = broker.stopLoss;
      broker.stopLoss = confirmed.stopLoss;
      local.stopLoss = confirmed.stopLoss;
      await prisma.position.update({ where: { id: local.id }, data: { stopLoss: confirmed.stopLoss } });
      await recordPositionEvent(prisma, local.id, 'PROFIT_LOCK_UPDATED', {
        scope: 'DEMO_GOLD', favorableR: decision.favorableR, protectedR: decision.protectedR,
        oldStopLoss, newStopLoss: confirmed.stopLoss, entryPrice: Number(local.entryPrice),
        initialStopLoss: Number(local.initialStopLoss), currentPrice: market, brokerPositionId: broker.brokerPositionId
      });
      logger.info({ event: 'DEMO_GOLD_PROFIT_LOCK_UPDATED', positionId: local.id,
        oldStopLoss, newStopLoss: confirmed.stopLoss, favorableR: decision.favorableR,
        protectedR: decision.protectedR }, 'DEMO Gold profit protection applied');
    } catch (err) {
      logger.warn({ err, event: 'DEMO_GOLD_PROFIT_LOCK_FAILED', positionId: local.id }, 'Gold profit protection failed; continuing reconcile');
    }
  }
}
