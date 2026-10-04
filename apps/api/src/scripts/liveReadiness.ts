/** Read-only diagnostics: never arms, switches environment, writes DB rows or sends broker orders. */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig } from "@regimex/config";
import { resolveMt5EnvironmentConfig } from "../../../../packages/config/src/mt5EnvironmentConfig.js";
import { getPrisma } from "@regimex/database";
import { HttpMt5BridgeClient, Mt5BridgeCircuitBreaker, resolveLiveTradingCapability,
  resolveMt5BridgeUrlForEnvironment, validateMt5ExecutionEnvironment, isUnresolvedExecutionIntentState,
  type Mt5AccountInfo, type Mt5SymbolInfo, type Mt5CommandType } from "@regimex/trading-engine";

export async function runLiveReadiness(userId = process.argv[2]) {
  if (!userId) throw Error("Usage: tsx src/scripts/liveReadiness.ts <userId>");
  const base = loadConfig();
  const live = resolveMt5EnvironmentConfig(base, "LIVE");
  const prisma = getPrisma();
  try {
    const [engine, environment, intents] = await Promise.all([
      prisma.liveEngine.findUnique({ where: { userId }, select: { liveTradingArmed: true, emergencyStop: true } }),
      prisma.tradingEnvironmentState.findUnique({ where: { userId } }),
      prisma.executionIntent.findMany({ where: { userId }, select: { state: true } })
    ]);
    const unresolved = intents.filter(x => isUnresolvedExecutionIntentState(x.state)).length;
    const capability = resolveLiveTradingCapability(live);
    const blockers = [...capability.reasons];
    const effectiveLiveLotCeiling = live.LIVE_SMOKE_TEST_MODE
      ? Math.min(live.LIVE_MAX_LOT_SIZE, 0.01) : live.LIVE_MAX_LOT_SIZE;
    if (unresolved) blockers.push(`${unresolved} unresolved execution intent(s) block environment switching`);
    if (engine?.emergencyStop) blockers.push("Emergency stop is active");
    const bridgeUrl = resolveMt5BridgeUrlForEnvironment(live, "LIVE");
    let bridgeRecentlyActive = false;
    let eaOnline = false;
    try {
      const response = await fetch(`${bridgeUrl}/health/ready`, { signal: AbortSignal.timeout(6000) });
      const ready = await response.json() as { eaRecent?: boolean; eaHealth?: string };
      bridgeRecentlyActive = response.ok && ready.eaRecent === true && ready.eaHealth === "online";
    } catch { /* Report as unavailable; do not change circuits or configuration. */ }
    let account: { server: string; loginMasked: string; tradeMode: string } | null = null;
    let minimumVolume: number | null = null;
    // Readiness measures response freshness, not a heartbeat. An idle EA may still answer.
    // Always try one bounded read-only account request; never infer connectivity from stale telemetry.
    {
      const client = new HttpMt5BridgeClient({ baseUrl: bridgeUrl, secret: live.MT5_BRIDGE_SECRET ?? "",
        timeoutMs: Math.min(live.MT5_COMMAND_TIMEOUT_MS, 15000), circuit: new Mt5BridgeCircuitBreaker() });
      const request = <T>(command: Mt5CommandType, payload: unknown) => client.request<T>(command, payload,
        { requestId: randomUUID(), idempotencyKey: `readonly-live-readiness:${randomUUID()}` });
      const reply = await request<Mt5AccountInfo>("getAccount", {});
      if (!reply.ok || !reply.result) blockers.push(`LIVE EA/account unverified: ${reply.errorCode ?? "missing snapshot"}`);
      else {
        eaOnline = true;
        const result = validateMt5ExecutionEnvironment({ account: reply.result, expectedEnvironment: "live",
          expectedBroker: live.MT5_EXPECTED_BROKER, expectedServer: live.MT5_EXPECTED_SERVER, expectedLogin: live.MT5_EXPECTED_LOGIN });
        blockers.push(...result.reasons);
        account = { server: reply.result.server, tradeMode: reply.result.tradeMode, loginMasked: `***${String(reply.result.login).slice(-3)}` };
        const instrument = await request<Mt5SymbolInfo>("getInstrument", { symbol: "Volatility 10 Index" });
        if (!instrument.ok || !(Number(instrument.result?.volumeMin) > 0)) blockers.push("R_10 minimum volume unavailable");
        else {
          minimumVolume = Number(instrument.result!.volumeMin);
          if (minimumVolume > Math.min(effectiveLiveLotCeiling, live.MT5_ENGINE_MAX_VOLUME)) {
            blockers.push(`R_10 broker minimum ${minimumVolume} exceeds configured LIVE/engine volume ceiling`);
            if (live.LIVE_SMOKE_TEST_MODE) blockers.push("LIVE_SMOKE_TEST_MODE independently limits LIVE volume to 0.01 lots");
          }
        }
      }
    }
    console.log(JSON.stringify({ connectionReady: blockers.length === 0, activeEnvironment: environment?.activeEnvironment ?? null,
      executionMode: base.EXECUTION_MODE, targetExecutionMode: live.EXECUTION_MODE, liveTradingArmed: engine?.liveTradingArmed ?? false,
      eaOnline, bridgeRecentlyActive, account, unresolvedIntents: unresolved, limits: { liveLotCeiling: live.LIVE_MAX_LOT_SIZE,
        effectiveLiveLotCeiling, smokeTestMode: live.LIVE_SMOKE_TEST_MODE,
        engineLotCeiling: live.MT5_ENGINE_MAX_VOLUME, globalRiskPercent: live.MT5_ENGINE_MAX_RISK_PERCENT,
        liveRiskPercent: live.LIVE_MAX_RISK_PER_TRADE_PERCENT, liveDailyLoss: live.LIVE_MAX_DAILY_LOSS },
      r10MinimumVolume: minimumVolume, blockers, readOnly: true }, null, 2));
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLiveReadiness().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
