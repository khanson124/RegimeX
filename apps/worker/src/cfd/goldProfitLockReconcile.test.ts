import { describe, expect, it, vi } from 'vitest';
import type { BrokerOpenPosition } from '@regimex/shared';
import type { PrismaClient } from '@regimex/database';
import type { Logger } from 'pino';
import { applyDemoGoldProfitLocks } from './goldProfitLockReconcile.js';
function fixture() {
  const broker = { brokerPositionId: '42', symbol: 'XAUUSD', direction: 'SELL', status: 'OPEN',
    entryPrice: 100, currentPrice: 89, stopLoss: 110, takeProfit: 80 } as BrokerOpenPosition;
  const local = { id: 'p1', symbol: 'XAUUSD', strategyId: 'xau-trend-pullback-v1', interval: '15m',
    origin: 'ENGINE', metadata: { executionModel: 'broker_demo_mt5' }, status: 'OPEN', direction: 'SELL',
    entryPrice: 100, initialStopLoss: 110, stopLoss: 110, takeProfit: 80, currentPrice: 90, brokerPositionId: '42' };
  const update = vi.fn().mockResolvedValue({}); const create = vi.fn().mockResolvedValue({});
  const adapter = { getPosition: vi.fn(async () => ({ ...broker })), getStatus: vi.fn(() => ({ isDemo: true })),
    getQuote: vi.fn(async () => ({ symbol: 'XAUUSD', bid: 89.75, ask: 90, mid: 89.875, timestamp: Date.now() })),
    getLiveSymbol: vi.fn(async () => ({ tickSize: 0.01, point: 0.01, stopsLevel: 20, freezeLevel: 3 })),
    modifyPosition: vi.fn(async () => ({ ...broker, stopLoss: 99 })) };
  const input = { executionMode: 'broker_demo_mt5',
    prisma: { position: { update }, positionEvent: { create } } as unknown as PrismaClient,
    logger: { warn: vi.fn(), info: vi.fn() } as unknown as Logger,
    adapter, brokerOpen: [broker], localOpen: [local] };
  return { input, adapter, broker, local, update, create };
}
describe('active Gold DEMO reconciliation', () => {
  it('uses executable ask, keeps TP, persists confirmed stop and aligns snapshots', async () => {
    const f = fixture(); await applyDemoGoldProfitLocks(f.input);
    expect(f.adapter.modifyPosition).toHaveBeenCalledWith({ brokerPositionId: '42', stopLoss: 99, takeProfit: 80 });
    expect(f.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stopLoss: 99 } });
    expect(f.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'PROFIT_LOCK_UPDATED', payload: expect.objectContaining({ scope: 'DEMO_GOLD', protectedR: 0.1 }) }) });
    expect(f.broker.stopLoss).toBe(99); expect(f.local.stopLoss).toBe(99);
    await applyDemoGoldProfitLocks(f.input); expect(f.adapter.modifyPosition).toHaveBeenCalledTimes(1);
  });
  it('protects BUY using bid', async () => {
    const f = fixture();Object.assign(f.broker,{ direction:'BUY',stopLoss:90,takeProfit:120 });
    Object.assign(f.local,{ direction:'BUY',initialStopLoss:90,stopLoss:90,takeProfit:120 });
    f.adapter.getQuote.mockResolvedValue({symbol:'XAUUSD',bid:110,ask:110.25,mid:110.125,timestamp:Date.now()});
    f.adapter.modifyPosition.mockResolvedValue({...f.broker,stopLoss:101});
    await applyDemoGoldProfitLocks(f.input);expect(f.update).toHaveBeenCalledWith({where:{id:'p1'},data:{stopLoss:101}});
  });
  it.each(['broker_real_mt5','paper','broker_demo'])('cannot touch execution mode %s', async mode => {
    const f=fixture();f.input.executionMode=mode;await applyDemoGoldProfitLocks(f.input);expect(f.adapter.getQuote).not.toHaveBeenCalled();expect(f.update).not.toHaveBeenCalled();
  });
  it('requires verified DEMO account', async () => {
    const f=fixture();f.adapter.getStatus.mockReturnValue({isDemo:false});await applyDemoGoldProfitLocks(f.input);expect(f.adapter.modifyPosition).not.toHaveBeenCalled();
  });
  it.each([{symbol:'R_10'},{strategyId:'another'},{interval:'1m'},{origin:'MANUAL'},{status:'PENDING'}, {metadata:{executionModel:'broker_real_mt5'}}])('does not modify outside position scope %j', async patch => {
    const f=fixture();Object.assign(f.local,patch);await applyDemoGoldProfitLocks(f.input);expect(f.adapter.modifyPosition).not.toHaveBeenCalled();
  });
  it('skips stale quotes', async () => {
    const f=fixture();f.adapter.getQuote.mockResolvedValue({symbol:'XAUUSD',bid:89.75,ask:90,mid:89.875,timestamp:Date.now()-20000});
    await applyDemoGoldProfitLocks(f.input);expect(f.adapter.modifyPosition).not.toHaveBeenCalled();
  });
  it('does not mistake bid-side movement for a SELL trigger', async () => {
    const f=fixture();f.adapter.getQuote.mockResolvedValue({symbol:'XAUUSD',bid:89.8,ask:90.1,mid:89.95,timestamp:Date.now()});
    await applyDemoGoldProfitLocks(f.input);expect(f.adapter.modifyPosition).not.toHaveBeenCalled();
  });
  it('does not persist failed modifications', async () => {
    const f=fixture();f.adapter.modifyPosition.mockRejectedValue(Error('rejected'));
    await applyDemoGoldProfitLocks(f.input);expect(f.update).not.toHaveBeenCalled();expect(f.broker.stopLoss).toBe(110);
  });
  it('requires the returned broker stop to confirm the proposal', async () => {
    const f=fixture();f.adapter.modifyPosition.mockResolvedValue({...f.broker});
    await applyDemoGoldProfitLocks(f.input);expect(f.update).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();
  });
  it('rejects unexpected TP changes in the acknowledgement', async () => {
    const f=fixture();f.adapter.modifyPosition.mockResolvedValue({...f.broker,stopLoss:99,takeProfit:79});
    await applyDemoGoldProfitLocks(f.input);expect(f.update).not.toHaveBeenCalled();
  });
  it('re-reads the broker stop rather than loosening from a stale snapshot', async () => {
    const f=fixture();f.adapter.getPosition.mockResolvedValue({...f.broker,stopLoss:95});
    await applyDemoGoldProfitLocks(f.input);
    expect(f.adapter.modifyPosition).not.toHaveBeenCalled();expect(f.broker.stopLoss).toBe(95);
  });
  it('allows only one overlapping modification per Gold ticket', async () => {
    const f=fixture();let release!: () => void;
    f.adapter.modifyPosition.mockImplementation(async () => {
      await new Promise<void>(resolve => { release=resolve; });return {...f.broker,stopLoss:99};
    });
    const first=applyDemoGoldProfitLocks(f.input);
    await vi.waitFor(() => expect(f.adapter.modifyPosition).toHaveBeenCalledTimes(1));
    const second={...f.input,brokerOpen:[{...f.broker}],localOpen:[{...f.local}]};
    await applyDemoGoldProfitLocks(second);release();await first;
    expect(f.adapter.modifyPosition).toHaveBeenCalledTimes(1);
    f.adapter.getPosition.mockResolvedValue({...f.broker});
    await applyDemoGoldProfitLocks(second);expect(f.adapter.modifyPosition).toHaveBeenCalledTimes(1);
  });
  it('releases the overlap guard after a failed modification', async () => {
    const f=fixture();f.adapter.modifyPosition.mockRejectedValueOnce(Error('failure'));
    await applyDemoGoldProfitLocks(f.input);await applyDemoGoldProfitLocks(f.input);
    expect(f.adapter.modifyPosition).toHaveBeenCalledTimes(2);expect(f.update).toHaveBeenCalledTimes(1);
  });
  it('skips a position that closed since the snapshot', async () => {
    const f=fixture();f.adapter.getPosition.mockResolvedValue({...f.broker,status:'CLOSED'});
    await applyDemoGoldProfitLocks(f.input);expect(f.adapter.modifyPosition).not.toHaveBeenCalled();
  });
  it('leaves absent TP absent', async () => {
    const f=fixture();f.broker.takeProfit=null;f.adapter.modifyPosition.mockResolvedValue({...f.broker,stopLoss:99});
    await applyDemoGoldProfitLocks(f.input);expect(f.adapter.modifyPosition).toHaveBeenCalledWith({brokerPositionId:'42',stopLoss:99,takeProfit:null});
  });
});
