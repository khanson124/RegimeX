import React from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useBacktests } from "../../src/api/hooks";
import { Badge, Button, Card, EmptyState, ErrorView, Metric, Row, Skeleton } from "../../src/components/ui";
import { colors, font, spacing } from "../../src/theme";

function statusTone(status: string): "up" | "down" | "warning" | "neutral" {
  if (status === "COMPLETED") return "up";
  if (status === "FAILED" || status === "CANCELLED") return "down";
  if (status === "RUNNING") return "warning";
  return "neutral";
}

export default function BacktestsScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useBacktests();
  const router = useRouter();

  if (isLoading) {
    return (
      <View style={[styles.container, { padding: spacing.lg }]}>
        <Skeleton height={110} />
        <Skeleton height={110} />
      </View>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const backtests = data?.items ?? [];

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      data={backtests}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListHeaderComponent={<Button title="New backtest" onPress={() => router.push("/backtest/new")} />}
      ListEmptyComponent={
        <EmptyState title="No backtests yet" hint="Run your first backtest to compare strategies against historical regimes." />
      }
      renderItem={({ item }) => {
        const netProfit = item.summary?.netProfit ?? null;
        const winRate = item.summary?.winRate ?? null;
        const profitFactor = item.summary?.profitFactor ?? null;
        const totalTrades = item.summary?.totalTrades ?? null;
        return (
          <Pressable onPress={() => router.push(`/backtest/${item.id}`)}>
            <Card>
              <Row style={{ justifyContent: "space-between" }}>
                <Text style={styles.title}>
                  {item.symbol} · {item.interval} · {item.selectionMode}
                  {item.executionModel === "cfd_v1"
                    ? " · CFD"
                    : item.executionModel === "rise_fall_v1"
                      ? " · Legacy binary"
                      : ""}
                </Text>
                <Badge tone={statusTone(item.status)} text={item.status} />
              </Row>
              <Text style={styles.dates}>
                {item.fromDate.slice(0, 10)} → {item.toDate.slice(0, 10)}
              </Text>
              {item.status === "RUNNING" ? <Text style={styles.progress}>Progress {item.progress}%</Text> : null}
              {item.summary ? (
                <Row style={{ marginTop: spacing.sm }}>
                  <Metric
                    label="Net profit"
                    value={netProfit != null ? `${netProfit >= 0 ? "+" : ""}${netProfit.toFixed(2)}` : "—"}
                    tone={netProfit != null && netProfit > 0 ? "up" : netProfit != null && netProfit < 0 ? "down" : "neutral"}
                  />
                  <Metric label="Win rate" value={winRate != null ? `${(winRate * 100).toFixed(1)}%` : "—"} />
                  <Metric label="PF" value={profitFactor != null ? profitFactor.toFixed(2) : "—"} />
                  <Metric label="Trades" value={totalTrades != null ? String(totalTrades) : "—"} />
                </Row>
              ) : null}
            </Card>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: font.body, fontWeight: "700", flexShrink: 1 },
  dates: { color: colors.textDim, fontSize: font.caption, marginTop: 2 },
  progress: { color: colors.warning, fontSize: font.caption, marginTop: spacing.xs }
});
