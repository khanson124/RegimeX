import React, { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, configuredApiUrl } from "../../src/api/client";
import { useDashboard, useEngineAction, useStrategies, useBrokerDemoStatus, useMt5Status } from "../../src/api/hooks";
import { useLiveEvents } from "../../src/ws/useLiveEvents";
import { ErrorView, RegimeBadge, Skeleton } from "../../src/components/ui";
import {
  ChipRow,
  Collapsible,
  HeroStat,
  PrimaryButton,
  SectionHeader,
  SoftCard,
  StatRow,
  StatTile,
  StatusChip
} from "../../src/components/design";
import { colors, font, spacing } from "../../src/theme";
import { webStyle } from "../../src/lib/webStyles";

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
      <ScrollView style={styles.container} contentContainerStyle={styles.pad}>
        <Skeleton height={140} />
        <Skeleton height={100} />
        <Skeleton height={160} />
      </ScrollView>
    );
  }
  if (isError || !data) {
    const detail = error instanceof Error ? error.message : "Failed to load";
    return (
      <ErrorView message={`${detail}\n\nAPI: ${configuredApiUrl()}`} onRetry={() => void refetch()} />
    );
  }

  const s = data.summary;
  const engineRunning = s.engineState.startsWith("RUNNING");
  const executionSource =
    s.execution?.source ??
    (mt5Status?.status?.enabled && s.executionMode === "broker_demo_mt5" ? "MT5_DEMO" : "PAPER_CFD");
  const mt5 = mt5Status?.status;
  const mt5Active = Boolean(mt5?.enabled) || executionSource === "MT5_DEMO";
  const mt5EngineOn = Boolean(mt5?.engineAutomationEnabled ?? s.execution?.mt5EngineAutomationEnabled);
  const bridgeOnline = mt5?.bridge === "online" || Boolean(mt5?.connected);
  const eaOnline = mt5?.ea === "online" || Boolean(mt5?.eaConnected);
  const mt5Ready = Boolean(mt5?.ready) && mt5?.bridge === "online";
  const executionBlocked = Boolean(mt5?.executionBlockReason) || (mt5Active && !mt5Ready);
  const openCount = Array.isArray(mt5?.openPositions)
    ? mt5.openPositions.length
    : (s.autonomous?.openEnginePositions ?? 0);

  const equityValue =
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
            : "—";

  const venueLabel =
    executionSource === "MT5_DEMO"
      ? "MT5 DEMO"
      : executionSource === "CTRADER_DEMO"
        ? "cTrader DEMO"
        : "Paper CFD";

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.pad}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />
      }
    >
      <SoftCard>
        <HeroStat
          label={`Equity · ${venueLabel}`}
          value={equityValue}
          subtitle={`Today ${s.todayPnl >= 0 ? "+" : ""}${s.todayPnl.toFixed(2)}${
            s.todayR != null ? ` · ${s.todayR >= 0 ? "+" : ""}${s.todayR.toFixed(2)}R` : ""
          }`}
          tone={s.todayPnl > 0 ? "up" : s.todayPnl < 0 ? "down" : "neutral"}
        />
        <StatRow>
          <StatTile
            label="Today P/L"
            value={`${s.todayPnl >= 0 ? "+" : ""}${s.todayPnl.toFixed(2)}`}
            tone={s.todayPnl > 0 ? "up" : s.todayPnl < 0 ? "down" : "neutral"}
          />
          <StatTile label="Open" value={String(openCount)} />
          <StatTile label="Symbol" value={s.symbol ?? "—"} />
        </StatRow>
      </SoftCard>

      <SectionHeader title="Status" />
      <SoftCard>
        <ChipRow>
          <StatusChip
            label={engineRunning ? "Engine running" : s.engineState.replace(/_/g, " ")}
            tone={engineRunning ? "up" : s.engineState === "EMERGENCY_STOPPED" ? "down" : "neutral"}
          />
          <StatusChip label={venueLabel} tone="accent" />
          <StatusChip
            label={executionBlocked ? "Exec blocked" : "Exec ready"}
            tone={executionBlocked ? "warning" : "up"}
          />
          <StatusChip label={connected ? "Live feed" : "Reconnecting"} tone={connected ? "up" : "warning"} />
          <StatusChip
            label={s.derivConnected ? "Market data" : "Data offline"}
            tone={s.derivConnected ? "up" : "warning"}
          />
          {mt5Active ? (
            <>
              <StatusChip label={`Bridge ${bridgeOnline ? "online" : "offline"}`} tone={bridgeOnline ? "up" : "warning"} />
              <StatusChip label={`EA ${eaOnline ? "online" : "offline"}`} tone={eaOnline ? "up" : "warning"} />
              <StatusChip label={mt5EngineOn ? "MT5 auto ON" : "MT5 auto OFF"} tone={mt5EngineOn ? "accent" : "neutral"} />
            </>
          ) : null}
          {s.emergencyStop ? <StatusChip label="Emergency stop" tone="down" /> : null}
        </ChipRow>
        {executionBlocked && (mt5?.executionBlockReason || s.autonomous?.reason) ? (
          <Text style={styles.reason}>
            {String(mt5?.executionBlockReason ?? s.autonomous?.reason ?? "").replace(/_/g, " ")}
          </Text>
        ) : null}
      </SoftCard>

      <SectionHeader title="Market" action="Trade" onAction={() => router.push("/(tabs)/market")} />
      <SoftCard>
        <RegimeBadge regime={s.currentRegime} confidence={s.regimeConfidence} />
        <StatRow>
          <StatTile label="Strategy" value={strategyLabel(s.activeStrategy)} />
          <StatTile
            label="Signal"
            value={
              s.currentSignal.action === "BUY" || s.currentSignal.action === "SELL"
                ? s.currentSignal.action
                : s.currentSignal.action === "HOLD"
                  ? "HOLD"
                  : "—"
            }
            tone={
              s.currentSignal.action === "BUY" ? "up" : s.currentSignal.action === "SELL" ? "down" : "neutral"
            }
          />
        </StatRow>
        <Text style={styles.meta}>
          Opened today {s.todayTrades} · Consec. losses {s.consecutiveLosses}
        </Text>
      </SoftCard>

      {(executionSource === "MT5_DEMO" || mt5Active) && (
        <Collapsible title="MT5 details">
          <StatRow>
            <StatTile label="Owned open" value={String(s.autonomous?.openEnginePositions ?? 0)} />
            <StatTile
              label="Forward E[R]"
              value={s.mt5Forward?.expectancyR != null ? s.mt5Forward.expectancyR.toFixed(2) : "—"}
            />
            <StatTile
              label="Lifecycle"
              value={(s.mt5Forward?.lifecycle ?? "EXPERIMENTAL").replace(/_/g, " ")}
            />
          </StatRow>
          <Text style={styles.meta}>
            {s.autonomous?.mapping?.internalSymbol ?? s.symbol ?? "—"} →{" "}
            {s.autonomous?.mapping?.brokerSymbol ?? "—"}
            {s.autonomous?.mapping?.verified ? " · verified" : " · unverified"}
          </Text>
          {mt5?.server ? (
            <Text style={styles.meta}>
              {mt5.server}
              {mt5.login ? ` · ${mt5.login}` : ""}
            </Text>
          ) : null}
        </Collapsible>
      )}

      <SectionHeader title="Controls" />
      <PrimaryButton title="Open Live Engine" variant="secondary" onPress={() => router.push("/engine")} />
      <PrimaryButton
        title="Emergency stop"
        variant="danger"
        onPress={confirmEmergencyStop}
        loading={engineAction.isPending}
      />
      <Pressable onPress={() => router.push("/positions")} style={webStyle({ cursor: "pointer" })}>
        <Text style={styles.link}>View positions →</Text>
      </Pressable>
      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
      <Text style={styles.disclaimer}>
        CFD research lab · MT5 DEMO primary · Paper fallback · Not live money
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 56 },
  reason: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.md, lineHeight: 18 },
  meta: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.md },
  link: {
    color: colors.accent,
    fontSize: font.body,
    fontWeight: "600",
    textAlign: "center",
    marginTop: spacing.md
  },
  error: { color: colors.down, fontSize: font.caption, textAlign: "center", marginTop: spacing.sm },
  disclaimer: {
    color: colors.textFaint,
    fontSize: font.micro,
    textAlign: "center",
    marginTop: spacing.xl,
    lineHeight: 16
  }
});
