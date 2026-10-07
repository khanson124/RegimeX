import { afterEach, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "./index.js";
const required = { DATABASE_URL: "postgresql://test:test@localhost/test", JWT_ACCESS_SECRET: "a".repeat(32),
 JWT_REFRESH_SECRET: "b".repeat(32), CREDENTIAL_ENCRYPTION_KEY: "c".repeat(32) };
afterEach(resetConfigCache);
it.each([undefined, "", "junk", "48", "2026-10-08", "2026-10-08T12:00:00+05:00"])("invalid/unset deadline is OFF: %s", value => {
 resetConfigCache(); const config = loadConfig({ ...required, MT5_DEMO_XAUUSD_RISK_TEST_UNTIL: value });
 expect(config.MT5_DEMO_XAUUSD_RISK_TEST_UNTIL).toBeUndefined(); expect(config.MT5_ENGINE_MAX_RISK_PERCENT).toBe(.1);
});
it("parses an explicit UTC deadline without changing normal caps", () => {
 const config = loadConfig({ ...required, MT5_DEMO_XAUUSD_RISK_TEST_UNTIL: "2026-10-08T12:00:00Z", MT5_DEMO_XAUUSD_MAX_RISK_PERCENT: ".35" });
 expect(config.MT5_DEMO_XAUUSD_RISK_TEST_UNTIL).toBe("2026-10-08T12:00:00Z");
 expect(config.MT5_DEMO_XAUUSD_MAX_RISK_PERCENT).toBe(.35); expect(config.MT5_ENGINE_MAX_RISK_PERCENT).toBe(.1);
});
