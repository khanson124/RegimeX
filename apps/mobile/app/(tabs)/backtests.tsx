import React from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useBacktests } from "../../src/api/hooks";
import { EmptyState, ErrorView, Skeleton } from "../../src/components/ui";
import {
  PrimaryButton,
  ProgressBar,
  SoftCard,
  StatRow,
  StatTile,
  StatusChip
} from "../../src/components/design";
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
      <View style={[styles.container, styles.pad]}>
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
      contentContainerStyle={styles.pad}
      data={backtests}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListHeaderComponent={<PrimaryButton title="New backtest" onPress={() => router.push("/backtest/new")} />}
      ListEmptyComponent={
        <EmptyState title="No backtests yet" hint="Run your first backtest to compare strategies against historical regimes." />
      }
      renderItem={({ item }) => {
        const netProfit = item.summary?.netProfit ?? null;
        const winRate = item.summary?.winRate ?? null;
        const profitFactor = item.summary?.profitFactor ?? null;
        const totalTrades = item.summary?.totalTrades ?? null;
        const expectancy = item.summary?.expectancy ?? null;
        const drawdown = item.summary?.maxDrawdownPercent ?? null;
        return (
          <Pressable onPress={() => router.push(`/backtest/${item.id}`)}>
            <SoftCard>
              <View style={styles.header}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>
                    {item.symbol} · {item.interval}
                  </Text>
                  <Text style={styles.dates}>
                    {item.fromDate.slice(0, 10)} → {item.toDate.slice(0, 10)} · {item.selectionMode}
                    {item.executionModel === "cfd_v1"
                      ? " · CFD"
                      : item.executionModel === "rise_fall_v1"
                        ? " · Legacy"
                        : ""}
                  </Text>
                </View>
                <StatusChip label={item.status} tone={statusTone(item.status)} />
              </View>
              {item.status === "RUNNING" ? (
                <ProgressBar progress={item.progress ?? 0} tone="warning" label={`${item.progress ?? 0}%`} />
              ) : null}
              {item.summary ? (
                <>
                  <View style={{ height: spacing.md }} />
                  <StatRow>
                    <StatTile
                      label="Net"
                      value={
                        netProfit != null ? `${netProfit >= 0 ? "+" : ""}${netProfit.toFixed(2)}` : "—"
                      }
                      tone={
                        netProfit != null && netProfit > 0
                          ? "up"
                          : netProfit != null && netProfit < 0
                            ? "down"
                            : "neutral"
                      }
                    />
                    <StatTile
                      label="Win %"
                      value={winRate != null ? `${(winRate * 100).toFixed(1)}%` : "—"}
                    />
                    <StatTile label="PF" value={profitFactor != null ? profitFactor.toFixed(2) : "—"} />
                  </StatRow>
                  <View style={{ height: spacing.sm }} />
                  <StatRow>
                    <StatTile label="Trades" value={totalTrades != null ? String(totalTrades) : "—"} />
                    <StatTile
                      label="E"
                      value={expectancy != null ? expectancy.toFixed(3) : "—"}
                    />
                    <StatTile
                      label="DD %"
                      value={drawdown != null ? drawdown.toFixed(1) : "—"}
                      tone="warning"
                    />
                  </StatRow>
                </>
              ) : null}
            </SoftCard>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 48 },
  header: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm, alignItems: "flex-start" },
  title: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  dates: { color: colors.textDim, fontSize: font.caption, marginTop: 4 }
});
