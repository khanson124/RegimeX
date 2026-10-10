import { afterEach, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from './index.js';
const required={DATABASE_URL:'postgresql://test:test@localhost/test',JWT_ACCESS_SECRET:'a'.repeat(32),JWT_REFRESH_SECRET:'b'.repeat(32),CREDENTIAL_ENCRYPTION_KEY:'c'.repeat(32)};
afterEach(resetConfigCache);
it.each([undefined,'',' ','bad','0','-10','Infinity','NaN'])('missing/invalid profit target is off: %s', value=>{
 const c=loadConfig({...required,MT5_DEMO_XAUUSD_PROFIT_TARGET_USD:value});
 expect(c.MT5_DEMO_XAUUSD_PROFIT_TARGET_USD).toBeUndefined();expect(c.MT5_ENGINE_MAX_RISK_PERCENT).toBe(.1);
});
it('parses 10 without changing Gold risk or default sessions',()=>{
 const c=loadConfig({...required,MT5_DEMO_XAUUSD_PROFIT_TARGET_USD:'10',MT5_DEMO_XAUUSD_MAX_RISK_PERCENT:'.35'});
 expect(c.MT5_DEMO_XAUUSD_PROFIT_TARGET_USD).toBe(10);expect(c.MT5_DEMO_XAUUSD_MAX_RISK_PERCENT).toBe(.35);
 expect(c.MT5_DEMO_XAUUSD_SESSION_START_UTC).toBeUndefined();expect(c.MT5_ENGINE_MAX_RISK_PERCENT).toBe(.1);
});
