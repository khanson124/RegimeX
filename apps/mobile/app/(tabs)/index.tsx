import React, { useState } from "react";
import { Alert, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { ApiError, configuredApiUrl } from "../../src/api/client";
import { useDashboard, useEngineAction, useStrategies } from "../../src/api/hooks";
import { useLiveEvents } from "../../src/ws/useLiveEvents";
import { Badge, Button, Card, ErrorView, Metric, RegimeBadge, Row, SectionTitle, Skeleton } from "../../src/components/ui";
import { colors, font, spacing } from "../../src/theme";

export default function DashboardScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useDashboard();
  const { data: strategiesData } = useStrategies();
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

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <Card>
        <Row>
          <Metric label="Engine" value={s.engineState.replace(/_/g, " ")} tone={engineRunning ? "up" : s.engineState === "EMERGENCY_STOPPED" ? "down" : "neutral"} />
          <Metric label="Deriv" value={s.derivConnected ? "Connected" : "Offline"} tone={s.derivConnected ? "up" : "warning"} />
          <Metric label="Live feed" value={connected ? "Streaming" : "Reconnecting"} tone={connected ? "up" : "warning"} />
        </Row>
        {s.emergencyStop ? <Badge tone="down" text="EMERGENCY STOP ACTIVE" /> : null}
      </Card>

      <Card>
        <Row>
          <Metric
            label={`Demo balance ${s.currency ?? ""}`}
            value={s.balance != null ? s.balance.toFixed(2) : "—"}
            large
          />
          <Metric
            label="Today P/L"
            value={`${s.todayPnl >= 0 ? "+" : ""}${s.todayPnl.toFixed(2)}`}
            tone={s.todayPnl > 0 ? "up" : s.todayPnl < 0 ? "down" : "neutral"}
            large
          />
        </Row>
        <Row>
          <Metric label="Symbol" value={s.symbol ?? "—"} />
          <Metric label="Trades today" value={String(s.todayTrades)} />
          <Metric
            label="Consec. losses"
            value={String(s.consecutiveLosses)}
            tone={s.consecutiveLosses >= 2 ? "warning" : "neutral"}
          />
        </Row>
      </Card>

      <SectionTitle>Market view</SectionTitle>
      <Card>
        <RegimeBadge regime={s.currentRegime} confidence={s.regimeConfidence} />
        <Row style={{ marginTop: spacing.md }}>
          <Metric label="Active strategy" value={strategyLabel(s.activeStrategy)} />
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
        Experimental system for demo accounts. Backtest results are not guarantees of future performance.
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
