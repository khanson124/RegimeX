import React, { useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, configuredApiUrl } from "../../src/api/client";
import { useDashboard, useEngineAction, useStrategies, useBrokerDemoStatus, useMt5Status } from "../../src/api/hooks";
import { useLiveEvents } from "../../src/ws/useLiveEvents";
import { Badge, Button, Card, ErrorView, Metric, RegimeBadge, Row, SectionTitle, Skeleton } from "../../src/components/ui";
import { colors, font, spacing } from "../../src/theme";

export default function DashboardScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useDashboard();
  const { data: strategiesData } = useStrategies();
  const { data: brokerDemo } = useBrokerDemoStatus();
  const { data: mt5Status } = useMt5Status();
  const engineAction = useEngineAction();
  const { connected } = useLiveEvents();
  const router = useRouter();
  const [actionError, setActionError] = useState<string | null>(null);

  function strategyLabel(strategyId: string | null | undefined): string {
    if (!strategyId) return "None selected";
    const match = strategiesData?.strategies.find((s) => s.id === strategyId);
    return match?.name ?? strategyId;
  }

  function confirmEmergencyStop(): void {
    Alert.alert(
      "Emergency stop?",
      "This halts the live engine immediately and latches the stop until you clear it from Live Engine.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Stop now",
          style: "destructive",
          onPress: () => {
            setActionError(null);
            engineAction.mutate("emergency-stop", {
              onSuccess: () => Alert.alert("Emergency stop active", "The engine has been halted."),
              onError: (err) =>
                setActionError(err instanceof ApiError ? err.message : "Emergency stop failed")
            });
          }
        }
      ]
    );
  }

  if (isLoading) {
    return (
      <ScrollView style={styles.container}>
        <Skeleton height={120} />
        <Skeleton height={180} />
        <Skeleton height={100} />
      </ScrollView>
    );
  }
  if (isError || !data) {
    const detail = error instanceof Error ? error.message : "Failed to load";
    const api = configuredApiUrl();
    return (
      <ErrorView
        message={`${detail}\n\nAPI: ${api}`}
        onRetry={() => void refetch()}
      />
    );
  }

  const s = data.summary;
  const engineRunning = s.engineState.startsWith("RUNNING");
  const executionSource = s.execution?.source ?? (mt5Status?.status?.enabled && s.executionMode === "broker_demo_mt5" ? "MT5_DEMO" : "PAPER_CFD");
  const mt5 = mt5Status?.status;
  const mt5Active = Boolean(mt5?.enabled) || executionSource === "MT5_DEMO";
  const mt5EngineOn = Boolean(mt5?.engineAutomationEnabled ?? s.execution?.mt5EngineAutomationEnabled);

  function formatAgo(ts: number | null | undefined): string {
    if (ts == null || !Number.isFinite(ts)) return "—";
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
    if (mins < 1) return "just now";
    if (mins === 1) return "1m ago";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? "1h ago" : `${hours}h ago`;
  }

  const bridgeLabel =
    mt5?.bridge === "online" ? "Online" : mt5?.bridge === "unhealthy" ? "Unhealthy" : mt5?.connected ? "Online" : "Offline";
  const eaLabel =
    mt5?.ea === "online" ? "Online" : mt5?.ea === "offline" ? "Offline" : mt5?.eaConnected ? "Online" : "Unknown";
  const reconcileLabel =
    mt5?.reconciliation === "fresh" ? "Fresh" : mt5?.reconciliation === "stale" ? "Stale" : "Unknown";
  const mt5Ready = Boolean(mt5?.ready) && mt5?.bridge === "online";
  const executionBlocked = Boolean(mt5?.executionBlockReason) || !mt5Ready;
  const executionReason = mt5?.executionBlockReason ?? s.autonomous?.decisionCode ?? s.autonomous?.reason ?? null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <Card>
        <Row>
          <Metric label="Engine" value={s.engineState.replace(/_/g, " ")} tone={engineRunning ? "up" : s.engineState === "EMERGENCY_STOPPED" ? "down" : "neutral"} />
          <Metric label="Market data" value={s.derivConnected ? "Connected" : "Offline"} tone={s.derivConnected ? "up" : "warning"} />
          <Metric label="Live feed" value={connected ? "Streaming" : "Reconnecting"} tone={connected ? "up" : "warning"} />
        </Row>
        {s.emergencyStop ? <Badge tone="down" text="EMERGENCY STOP ACTIVE" /> : null}
        <Row style={{ marginTop: spacing.md }}>
          <Metric
            label="Execution"
            value={
              executionSource === "MT5_DEMO"
                ? "MT5 DEMO"
                : executionSource === "CTRADER_DEMO"
                  ? "cTrader DEMO"
                  : "PAPER CFD"
            }
            tone={executionSource === "PAPER_CFD" ? "neutral" : "warning"}
          />
          {executionSource === "MT5_DEMO" || mt5Active ? (
            <Metric
              label="MT5 engine"
              value={mt5EngineOn ? "ON" : "OFF"}
              tone={mt5EngineOn ? "warning" : "neutral"}
            />
          ) : (
            <Metric label="Paper role" value="Dev / fallback" />
          )}
        </Row>
        {brokerDemo?.status?.enabled && executionSource === "CTRADER_DEMO" ? (
          <Row style={{ marginTop: spacing.md }}>
            <Metric
              label="cTrader"
              value={brokerDemo.status.demo || brokerDemo.status.isDemo ? "DEMO" : "—"}
              tone="warning"
            />
            <Metric
              label="cTrader link"
              value={brokerDemo.status.connected ? "Connected" : brokerDemo.status.error ? "Error" : "Offline"}
              tone={brokerDemo.status.connected ? "up" : "warning"}
            />
            <Metric
              label="Demo equity"
              value={
                brokerDemo.status.account?.equity != null
                  ? String(brokerDemo.status.account.equity)
                  : "—"
              }
            />
          </Row>
        ) : null}
        {mt5Active ? (
          <>
            <Row style={{ marginTop: spacing.md }}>
              <Metric
                label="MT5 DEMO"
                value={mt5?.isDemo || mt5?.demo ? "DEMO" : "—"}
                tone={mt5?.isDemo || mt5?.demo ? "warning" : "neutral"}
              />
              <Metric
                label="Bridge"
                value={bridgeLabel}
                tone={bridgeLabel === "Online" ? "up" : "warning"}
              />
              <Metric
                label="EA"
                value={eaLabel}
                tone={eaLabel === "Online" ? "up" : "warning"}
              />
            </Row>
            <Row style={{ marginTop: spacing.sm }}>
              <Metric
                label="Reconcile"
                value={reconcileLabel}
                tone={reconcileLabel === "Fresh" ? "up" : "warning"}
              />
              <Metric
                label="Circuit"
                value={mt5?.circuitState ?? "—"}
                tone={mt5?.circuitState === "CLOSED" ? "up" : "warning"}
              />
              <Metric
                label="Execution"
                value={executionBlocked ? "Blocked" : "Ready"}
                tone={executionBlocked ? "warning" : "up"}
              />
            </Row>
            {executionReason ? (
              <Text style={{ color: colors.textDim, marginTop: spacing.xs, fontSize: font.caption }}>
                Reason: {String(executionReason).replace(/_/g, " ")}
                {mt5?.lastBridgeSuccessAt
                  ? ` · Last healthy: ${formatAgo(mt5.lastBridgeSuccessAt)}`
                  : ""}
              </Text>
            ) : null}
            <Row style={{ marginTop: spacing.sm }}>
              <Metric
                label="MT5 equity"
                value={mt5?.account?.equity != null ? String(mt5.account.equity) : "—"}
              />
              <Metric
                label="MT5 balance"
                value={mt5?.account?.balance != null ? String(mt5.account.balance) : "—"}
              />
              <Metric
                label="Broker"
                value={mt5?.company || mt5?.server || "—"}
              />
            </Row>
            {mt5?.server ? (
              <Text style={{ color: colors.textDim, marginTop: spacing.xs, fontSize: font.caption }}>
                {mt5.server}
                {mt5.login ? ` · login ${mt5.login}` : ""}
                {Array.isArray(mt5.openPositions) ? ` · ${mt5.openPositions.length} open` : ""}
              </Text>
            ) : null}
          </>
        ) : null}
        {executionSource === "PAPER_CFD" && !mt5Active ? (
          <Text style={{ color: colors.textDim, marginTop: spacing.sm, fontSize: font.caption }}>
            PAPER CFD — local development / tests / fallback. Primary forward path is Deriv MT5 DEMO.
          </Text>
        ) : null}
      </Card>

      <Card>
        <Row>
          <Metric
            label={
              executionSource === "MT5_DEMO"
                ? `MT5 DEMO ${mt5?.account?.currency ?? ""}`.trim()
                : executionSource === "CTRADER_DEMO"
                  ? `cTrader DEMO ${s.currency ?? ""}`
                  : `Paper CFD ${s.currency ?? ""}`
            }
            value={
              executionSource === "MT5_DEMO"
                ? mt5?.account?.equity != null
                  ? String(mt5.account.equity)
                  : "—"
                : executionSource === "CTRADER_DEMO" && brokerDemo?.status?.account?.equity != null
                  ? String(brokerDemo.status.account.equity)
                  : s.paperEquity != null
                    ? s.paperEquity.toFixed(2)
                    : s.balance != null
                      ? s.balance.toFixed(2)
                      : "—"
            }
            large
          />
        </Row>
        <Row>
          <Metric
            label="Today P/L"
            value={`${s.todayPnl >= 0 ? "+" : ""}${s.todayPnl.toFixed(2)}`}
            tone={s.todayPnl > 0 ? "up" : s.todayPnl < 0 ? "down" : "neutral"}
            large
          />
          <Metric
            label="Today R"
            value={s.todayR != null ? `${s.todayR >= 0 ? "+" : ""}${s.todayR.toFixed(2)}R` : "—"}
            tone={s.todayR != null && s.todayR > 0 ? "up" : s.todayR != null && s.todayR < 0 ? "down" : "neutral"}
            large
          />
        </Row>
        <Text style={{ color: colors.textDim, marginTop: spacing.xs, fontSize: font.caption }}>
          Today P/L and opened-today are from realized CFD positions, not binary options contracts.
        </Text>
        <Row>
          <Metric label="Symbol" value={s.symbol ?? "—"} />
          <Metric label="Opened today" value={String(s.todayTrades)} />
          <Metric
            label="Consec. losses"
            value={String(s.consecutiveLosses)}
            tone={s.consecutiveLosses >= 2 ? "warning" : "neutral"}
          />
        </Row>
      </Card>

      {executionSource === "MT5_DEMO" || mt5Active ? (
        <>
          <SectionTitle>Autonomous MT5 DEMO</SectionTitle>
          <Card>
            <Row>
              <Metric
                label="Autonomous"
                value={s.autonomous?.enabled ? "Enabled" : "Blocked"}
                tone={s.autonomous?.enabled ? "warning" : "neutral"}
              />
              <Metric
                label="Engine flag"
                value={s.autonomous?.mt5EngineEnabled || mt5EngineOn ? "ON" : "OFF"}
                tone={s.autonomous?.mt5EngineEnabled || mt5EngineOn ? "warning" : "neutral"}
              />
              <Metric
                label="Open owned"
                value={String(s.autonomous?.openEnginePositions ?? 0)}
              />
            </Row>
            {s.autonomous?.blocked && s.autonomous.reason ? (
              <Text style={{ color: colors.textDim, marginTop: spacing.sm, fontSize: font.caption }}>
                {s.autonomous.reason.replace(/_/g, " ")}
              </Text>
            ) : null}
            <Row style={{ marginTop: spacing.md }}>
              <Metric label="RegimeX" value={s.autonomous?.mapping?.internalSymbol ?? s.symbol ?? "—"} />
              <Metric
                label="MT5 symbol"
                value={s.autonomous?.mapping?.brokerSymbol ?? "—"}
              />
              <Metric
                label="Mapping"
                value={s.autonomous?.mapping?.verified ? "Verified" : "Unverified"}
                tone={s.autonomous?.mapping?.verified ? "up" : "warning"}
              />
            </Row>
            <Row style={{ marginTop: spacing.sm }}>
              <Metric
                label="Broker min"
                value={
                  s.autonomous?.brokerMinVolume != null ? String(s.autonomous.brokerMinVolume) : "—"
                }
              />
              <Metric
                label="Broker step"
                value={
                  s.autonomous?.brokerVolumeStep != null ? String(s.autonomous.brokerVolumeStep) : "—"
                }
              />
              <Metric
                label="Engine max vol"
                value={s.autonomous?.engineMaxVolume != null ? String(s.autonomous.engineMaxVolume) : "—"}
              />
            </Row>
            <Row style={{ marginTop: spacing.md }}>
              <Metric label="Forward trades" value={String(s.mt5Forward?.trades ?? 0)} />
              <Metric
                label="Expectancy R"
                value={s.mt5Forward?.expectancyR != null ? s.mt5Forward.expectancyR.toFixed(2) : "—"}
              />
              <Metric
                label="Profit factor"
                value={s.mt5Forward?.profitFactor != null ? s.mt5Forward.profitFactor.toFixed(2) : "—"}
              />
            </Row>
            <Row style={{ marginTop: spacing.sm }}>
              <Metric
                label="Drawdown"
                value={
                  s.mt5Forward?.maxDrawdownPercent != null
                    ? `${s.mt5Forward.maxDrawdownPercent.toFixed(1)}%`
                    : "—"
                }
              />
              <Metric
                label="Lifecycle"
                value={(s.mt5Forward?.lifecycle ?? "EXPERIMENTAL").replace(/_/g, " ")}
              />
            </Row>
            {s.recentAutonomousDecisions && s.recentAutonomousDecisions.length > 0 ? (
              <Text style={{ color: colors.textDim, marginTop: spacing.sm, fontSize: font.caption }}>
                Recent: {s.recentAutonomousDecisions.slice(0, 5).map((d) => d.code).join(" · ")}
              </Text>
            ) : (
              <Text style={{ color: colors.textDim, marginTop: spacing.sm, fontSize: font.caption }}>
                No autonomous decisions yet. Engine-driven orders stay off until you enable them.
              </Text>
            )}
          </Card>
        </>
      ) : null}

      <SectionTitle>Market view</SectionTitle>
      <Card>
        <RegimeBadge regime={s.currentRegime} confidence={s.regimeConfidence} />
        <Row style={{ marginTop: spacing.md }}>
          <Metric label="Active strategy" value={strategyLabel(s.activeStrategy)} />
          <Metric
            label="Selection"
            value={s.strategySelection?.selectionMode ?? "—"}
          />
          <Metric
            label="Current signal"
            value={
              s.currentSignal.action === "HOLD"
                ? "HOLD"
                : s.currentSignal.action === "BUY" || s.currentSignal.action === "SELL"
                  ? s.currentSignal.action
                  : "—"
            }
            tone={
              s.currentSignal.action === "BUY" ? "up" : s.currentSignal.action === "SELL" ? "down" : "neutral"
            }
          />
        </Row>
        {s.latestSignal ? (
          <Row>
            <Metric
              label={`Last signal (${s.latestSignal.status})`}
              value={`${s.latestSignal.action} · ${(s.latestSignal.confidence * 100).toFixed(0)}%`}
              tone={s.latestSignal.action === "BUY" ? "up" : s.latestSignal.action === "SELL" ? "down" : "neutral"}
            />
          </Row>
        ) : (
          <Text style={styles.dim}>No signals recorded yet</Text>
        )}
      </Card>

      <SectionTitle>Controls</SectionTitle>
      <Button title="Open Live Engine" onPress={() => router.push("/engine")} variant="secondary" />
      <Button
        title="EMERGENCY STOP"
        variant="danger"
        onPress={confirmEmergencyStop}
        loading={engineAction.isPending}
      />
      {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
      <Text style={styles.disclaimer}>
        CFD research lab — MT5 DEMO is the primary forward path; paper CFD is fallback. Not binary options.
        Backtests are not guarantees of future performance.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  dim: { color: colors.textDim, fontSize: font.body, marginTop: spacing.sm },
  actionError: { color: colors.down, fontSize: font.caption, textAlign: "center", marginTop: spacing.sm },
  disclaimer: { color: colors.textFaint, fontSize: font.caption, textAlign: "center", marginTop: spacing.lg }
});
