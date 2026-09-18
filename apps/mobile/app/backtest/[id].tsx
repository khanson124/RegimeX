import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useBacktest, useBacktestEquity, useBacktestRegimes } from "../../src/api/hooks";
import { LineChart } from "../../src/components/CandleChart";
import { EmptyState, ErrorView, Skeleton } from "../../src/components/ui";
import {
  ChipRow,
  Collapsible,
  InfoRow,
  ProgressBar,
  SectionHeader,
  SoftCard,
  StatRow,
  StatTile,
  StatusChip
} from "../../src/components/design";
import { colors, font, spacing, REGIME_LABELS } from "../../src/theme";

function fmt(value: number | null | undefined, digits = 2): string {
  return value != null && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function GroupTable({
  title,
  rows
}: {
  title: string;
  rows: Array<{ key: string; trades: number; winRate: number; netProfit: number; profitFactor: number | null }>;
}) {
  return (
    <Collapsible title={title}>
      {rows.length === 0 ? (
        <Text style={styles.dim}>No trades recorded</Text>
      ) : (
        rows.map((row) => (
          <View key={row.key} style={styles.groupRow}>
            <Text style={styles.groupKey}>{REGIME_LABELS[row.key] ?? row.key}</Text>
            <Text style={styles.groupStat}>{row.trades} tr</Text>
            <Text style={styles.groupStat}>{(row.winRate * 100).toFixed(0)}%</Text>
            <Text style={[styles.groupStat, { color: row.netProfit >= 0 ? colors.up : colors.down }]}>
              {row.netProfit >= 0 ? "+" : ""}
              {row.netProfit.toFixed(2)}
            </Text>
          </View>
        ))
      )}
    </Collapsible>
  );
}

export default function BacktestDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading, isError, error, refetch, isRefetching } = useBacktest(id);
  const status = data?.backtest.status;
  const done = status === "COMPLETED";
  const equity = useBacktestEquity(id, done);
  const regimes = useBacktestRegimes(id, done);
  const { width } = useWindowDimensions();

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: spacing.lg }}>
        <Skeleton height={140} />
        <Skeleton height={220} />
      </View>
    );
  }
  if (isError || !data) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const bt = data.backtest;
  const sum = bt.summary;
  const balancePoints =
    equity.data?.points.map((p) => ({ time: p.time, value: p.balance })) ?? [];
  const drawdownPoints =
    equity.data?.points.map((p) => ({ time: p.time, value: -p.drawdown })) ?? [];
  const chartWidth = width - spacing.lg * 4;
  const validation = regimes.data?.validation ?? bt.validation ?? null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.pad}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <SoftCard>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>
              {bt.symbol} · {bt.interval}
            </Text>
            <Text style={styles.dates}>
              {bt.fromDate.slice(0, 10)} → {bt.toDate.slice(0, 10)} · {bt.selectionMode}
            </Text>
          </View>
          <StatusChip
            label={status ?? "UNKNOWN"}
            tone={done ? "up" : status === "FAILED" ? "down" : status === "RUNNING" ? "warning" : "neutral"}
          />
        </View>
        <ChipRow>
          <StatusChip
            label={
              bt.executionModel === "cfd_v1"
                ? "CFD"
                : bt.executionModel === "rise_fall_v1"
                  ? "Legacy binary"
                  : "Model ?"
            }
            tone="neutral"
          />
        </ChipRow>
        {status === "RUNNING" || status === "QUEUED" ? (
          <ProgressBar progress={bt.progress ?? 0} tone="warning" label={`${bt.progress ?? 0}%`} />
        ) : null}
        {bt.error ? <Text style={styles.error}>{bt.error}</Text> : null}
      </SoftCard>

      {sum ? (
        <>
          <SectionHeader title="Summary" />
          <SoftCard>
            <StatRow>
              <StatTile
                label="Net result"
                value={`${(sum.netProfit ?? 0) >= 0 ? "+" : ""}${fmt(sum.netProfit)}`}
                tone={(sum.netProfit ?? 0) > 0 ? "up" : (sum.netProfit ?? 0) < 0 ? "down" : "neutral"}
              />
              <StatTile label="Return" value={`${fmt(sum.returnPercent, 1)}%`} />
              <StatTile label="Trades" value={String(sum.totalTrades ?? 0)} />
            </StatRow>
            <View style={{ height: spacing.sm }} />
            <StatRow>
              <StatTile label="Win rate" value={`${fmt((sum.winRate ?? 0) * 100, 1)}%`} />
              <StatTile label="Expectancy" value={fmt(sum.expectancy, 3)} />
              <StatTile label="PF" value={fmt(sum.profitFactor)} />
            </StatRow>
            <View style={{ height: spacing.sm }} />
            <StatRow>
              <StatTile label="Max DD" value={`${fmt(sum.maxDrawdownPercent, 1)}%`} tone="warning" />
              <StatTile label="Win streak" value={String(sum.longestWinStreak ?? 0)} />
              <StatTile label="Loss streak" value={String(sum.longestLossStreak ?? 0)} />
            </StatRow>
            <Collapsible title="More summary" inline>
              <InfoRow label="No-trade candles" value={String(sum.noTradeCount ?? 0)} />
              <InfoRow label="Risk-rejected" value={String(sum.rejectedSignalCount ?? 0)} />
              <InfoRow label="Ending balance" value={fmt(sum.endingBalance)} />
            </Collapsible>
          </SoftCard>
        </>
      ) : null}

      {done ? (
        <>
          <SectionHeader title="Balance curve" />
          <SoftCard>
            {equity.isLoading ? (
              <Skeleton height={140} />
            ) : balancePoints.length > 1 ? (
              <LineChart points={balancePoints} width={chartWidth} height={140} color={colors.accent} />
            ) : (
              <EmptyState title="No equity points" />
            )}
          </SoftCard>

          <SectionHeader title="Drawdown" />
          <SoftCard>
            {drawdownPoints.length > 1 ? (
              <LineChart points={drawdownPoints} width={chartWidth} height={100} color={colors.warning} />
            ) : (
              <Text style={styles.dim}>No drawdown data</Text>
            )}
          </SoftCard>

          {regimes.data ? (
            <>
              <SectionHeader title="Breakdowns" />
              <GroupTable title="By regime" rows={regimes.data.regimeResults} />
              <GroupTable title="By strategy" rows={regimes.data.strategyResults} />
            </>
          ) : null}

          {validation ? (
            <Collapsible title="Train vs test (out-of-sample)">
              <View style={styles.splitRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.splitTitle}>Train</Text>
                  <InfoRow label="Net" value={fmt(validation.train.netProfit)} />
                  <InfoRow label="Win %" value={`${fmt((validation.train.winRate ?? 0) * 100, 1)}%`} />
                  <InfoRow label="Trades" value={String(validation.train.totalTrades ?? 0)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.splitTitle}>Test</Text>
                  <InfoRow label="Net" value={fmt(validation.test.netProfit)} />
                  <InfoRow label="Win %" value={`${fmt((validation.test.winRate ?? 0) * 100, 1)}%`} />
                  <InfoRow label="Trades" value={String(validation.test.totalTrades ?? 0)} />
                </View>
              </View>
              <Text style={styles.note}>
                Trust out-of-sample results more than train-only performance.
              </Text>
            </Collapsible>
          ) : null}
        </>
      ) : null}

      <Text style={styles.note}>
        {bt.executionModel === "rise_fall_v1"
          ? "Legacy binary simulation with assumed payouts. Not indicative of future performance."
          : "Simulated CFD results (spread, SL/TP, lot sizing). Not indicative of future performance."}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 48 },
  header: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm, marginBottom: spacing.sm },
  title: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  dates: { color: colors.textDim, fontSize: font.caption, marginTop: 4 },
  error: { color: colors.down, fontSize: font.caption, marginTop: spacing.sm },
  dim: { color: colors.textDim, fontSize: font.body },
  groupRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, gap: 8 },
  groupKey: { color: colors.text, fontSize: font.caption, fontWeight: "600", flex: 1.4 },
  groupStat: { color: colors.textDim, fontSize: font.caption, flex: 1, textAlign: "right" },
  splitRow: { flexDirection: "row", gap: spacing.md },
  splitTitle: { color: colors.text, fontWeight: "700", fontSize: font.body, marginBottom: spacing.xs },
  note: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.md, lineHeight: 18 }
});
