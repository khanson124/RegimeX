import { describe, expect, it } from 'vitest';
import { goldProtectedStop } from './goldProfitLock.js';
const buy = { direction: 'BUY', entry: 100, initialStop: 90, currentStop: 90, market: 110,
  tickSize: 0.01, point: 0.01, stopsLevel: 20, freezeLevel: 3 };
describe('DEMO Gold protected stop', () => {
  it('leaves the original stop below 1R', () => expect(goldProtectedStop({ ...buy, market: 109.99 })).toBeNull());
  it('locks 0.1R at 1R', () => expect(goldProtectedStop(buy)).toEqual({ stop: 101, favorableR: 1, protectedR: 0.1 }));
  it('locks 0.5R at 1.5R', () => expect(goldProtectedStop({ ...buy, market: 115 })).toEqual({ stop: 105, favorableR: 1.5, protectedR: 0.5 }));
  it('protects SELL symmetrically', () => expect(goldProtectedStop({ ...buy, direction: 'SELL', initialStop: 110, currentStop: 110, market: 85 })).toEqual({ stop: 95, favorableR: 1.5, protectedR: 0.5 }));
  it.each([101, 105, 106])('never loosens already protected BUY stop %s', currentStop => expect(goldProtectedStop({ ...buy, currentStop })).toBeNull());
  it('never loosens a SELL stop after retracement', () => expect(goldProtectedStop({ ...buy, direction: 'SELL', initialStop: 110, currentStop: 95, market: 90 })).toBeNull());
  it('uses original risk after a prior modification', () => expect(goldProtectedStop({ ...buy, currentStop: 101, market: 115 })?.stop).toBe(105));
  it('respects minimum stop and freeze distance', () => expect(goldProtectedStop({ ...buy, freezeLevel: 1000 })).toBeNull());
  it('rounds to the tick away from market', () => expect(goldProtectedStop({ ...buy, entry: 100.03, initialStop: 90.03, market: 110.03, tickSize: 0.1 })?.stop).toBe(101));
  it.each([{ initialStop: 110 }, { initialStop: 100 }, { market: NaN }, { tickSize: 0 }, { currentStop: Infinity }, { direction: 'HOLD' }, { stopsLevel: NaN }])('fails closed for invalid input %j', patch => expect(goldProtectedStop({ ...buy, ...patch })).toBeNull());
});

describe('Gold risk-based exit V1', () => {
  it.each([[.49, null], [.5, .1], [1, .5], [1.5, 1], [1.8, 1.3], [2, 1.5]])(
    'protects profit at %sR without widening risk', (r, protectedR) => {
      for (const sign of [1,-1]) {
        const result = goldProtectedStop({ ...buy, riskBased: true, direction: sign===1?'BUY':'SELL',
          initialStop:100-sign*10,currentStop:100-sign*10,market:100+sign*10*r });
        if (protectedR===null) expect(result).toBeNull();
        else { expect(result?.protectedR).toBeCloseTo(protectedR);expect(result?.stop).toBeCloseTo(100+sign*10*protectedR); }
      }
    });
  it('never gives back a previously acknowledged stop on retracement',()=>{
    expect(goldProtectedStop({...buy,riskBased:true,currentStop:110,market:112})).toBeNull();
  });
  it('keeps legacy protection thresholds unchanged when not opted in',()=>{
    expect(goldProtectedStop({...buy,market:105})).toBeNull();
    expect(goldProtectedStop(buy)?.protectedR).toBe(.1);
  });
});
