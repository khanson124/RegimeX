import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { useDashboard, useEngineAction } from "../../src/api/hooks";
import { useLiveEvents } from "../../src/ws/useLiveEvents";
import { Badge, Button, Card, ErrorView, Metric, RegimeBadge, Row, SectionTitle, Skeleton } from "../../src/components/ui";
import { colors, font, spacing } from "../../src/theme";

export default function DashboardScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useDashboard();
  const engineAction = useEngineAction();
  const { connected } = useLiveEvents();
  const router = useRouter();

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
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
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
          <Metric label="Active strategy" value={s.activeStrategy ?? "None selected"} />
        </Row>
        {s.latestSignal ? (
          <Row>
            <Metric
              label={`Latest signal (${s.latestSignal.status})`}
              value={`${s.latestSignal.action} · ${(s.latestSignal.confidence * 100).toFixed(0)}%`}
              tone={s.latestSignal.action === "BUY" ? "up" : s.latestSignal.action === "SELL" ? "down" : "neutral"}
            />
          </Row>
        ) : (
          <Text style={styles.dim}>No signals yet</Text>
        )}
      </Card>

      <SectionTitle>Controls</SectionTitle>
      <Button title="Open Live Engine" onPress={() => router.push("/engine")} variant="secondary" />
      <Button
        title="EMERGENCY STOP"
        variant="danger"
        onPress={() => engineAction.mutate("emergency-stop")}
        loading={engineAction.isPending}
      />
      <Text style={styles.disclaimer}>
        Experimental system for demo accounts. Backtest results are not guarantees of future performance.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  dim: { color: colors.textDim, fontSize: font.body, marginTop: spacing.sm },
  disclaimer: { color: colors.textFaint, fontSize: font.caption, textAlign: "center", marginTop: spacing.lg }
});
