import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useBacktest, useBacktestEquity, useBacktestRegimes } from "../../src/api/hooks";
import { LineChart } from "../../src/components/CandleChart";
import { Badge, Card, EmptyState, ErrorView, KeyValue, Metric, Row, SectionTitle, Skeleton } from "../../src/components/ui";
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
    <>
      <SectionTitle>{title}</SectionTitle>
      <Card>
        {rows.length === 0 ? (
          <Text style={styles.dim}>No trades recorded</Text>
        ) : (
          rows.map((row) => (
            <View key={row.key} style={styles.groupRow}>
              <Text style={styles.groupKey}>{REGIME_LABELS[row.key] ?? row.key}</Text>
              <Text style={styles.groupStat}>{row.trades} trades</Text>
              <Text style={styles.groupStat}>{(row.winRate * 100).toFixed(0)}% win</Text>
              <Text style={[styles.groupStat, { color: row.netProfit >= 0 ? colors.up : colors.down }]}>
                {row.netProfit >= 0 ? "+" : ""}
                {row.netProfit.toFixed(2)}
              </Text>
            </View>
          ))
        )}
      </Card>
    </>
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
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Text style={styles.title}>
            {bt.symbol} · {bt.interval} · {bt.selectionMode}
          </Text>
          <Badge
            tone={done ? "up" : status === "FAILED" ? "down" : status === "RUNNING" ? "warning" : "neutral"}
            text={status ?? "UNKNOWN"}
          />
        </Row>
        <Text style={styles.dates}>
          {bt.fromDate.slice(0, 10)} → {bt.toDate.slice(0, 10)}
        </Text>
        {status === "RUNNING" || status === "QUEUED" ? (
          <Text style={styles.progress}>Progress {bt.progress}%</Text>
        ) : null}
        {bt.error ? <Text style={styles.error}>{bt.error}</Text> : null}
      </Card>

      {sum ? (
        <>
          <SectionTitle>Summary</SectionTitle>
          <Card>
            <Row>
              <Metric
                label="Net profit"
                value={`${(sum.netProfit ?? 0) >= 0 ? "+" : ""}${fmt(sum.netProfit)}`}
                tone={(sum.netProfit ?? 0) > 0 ? "up" : (sum.netProfit ?? 0) < 0 ? "down" : "neutral"}
                large
              />
              <Metric label="Return" value={`${fmt(sum.returnPercent, 1)}%`} large />
            </Row>
            <Row>
              <Metric label="Trades" value={String(sum.totalTrades ?? 0)} />
              <Metric label="Win rate" value={`${fmt((sum.winRate ?? 0) * 100, 1)}%`} />
              <Metric label="Profit factor" value={fmt(sum.profitFactor)} />
              <Metric label="Expectancy" value={fmt(sum.expectancy, 3)} />
            </Row>
            <Row>
              <Metric label="Max drawdown" value={`${fmt(sum.maxDrawdownPercent, 1)}%`} tone="warning" />
              <Metric label="Win streak" value={String(sum.longestWinStreak ?? 0)} />
              <Metric label="Loss streak" value={String(sum.longestLossStreak ?? 0)} />
            </Row>
            <KeyValue k="No-trade candles" v={String(sum.noTradeCount ?? 0)} />
            <KeyValue k="Risk-rejected signals" v={String(sum.rejectedSignalCount ?? 0)} />
            <KeyValue k="Ending balance" v={fmt(sum.endingBalance)} />
          </Card>
        </>
      ) : null}

      {done ? (
        <>
          <SectionTitle>Balance curve</SectionTitle>
          <Card>
            {equity.isLoading ? (
              <Skeleton height={140} />
            ) : balancePoints.length > 1 ? (
              <LineChart points={balancePoints} width={chartWidth} height={140} color={colors.accent} />
            ) : (
              <EmptyState title="No equity points" />
            )}
          </Card>

          <SectionTitle>Drawdown</SectionTitle>
          <Card>
            {drawdownPoints.length > 1 ? (
              <LineChart points={drawdownPoints} width={chartWidth} height={100} color={colors.warning} />
            ) : (
              <Text style={styles.dim}>No drawdown data</Text>
            )}
          </Card>

          {regimes.data ? (
            <>
              <GroupTable title="Performance by regime" rows={regimes.data.regimeResults} />
              <GroupTable title="Performance by strategy" rows={regimes.data.strategyResults} />
            </>
          ) : null}

          {validation ? (
            <>
              <SectionTitle>Train vs test (out-of-sample)</SectionTitle>
              <Card>
                <Row>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.splitTitle}>Train</Text>
                    <KeyValue k="Net profit" v={fmt(validation.train.netProfit)} />
                    <KeyValue k="Win rate" v={`${fmt((validation.train.winRate ?? 0) * 100, 1)}%`} />
                    <KeyValue k="Trades" v={String(validation.train.totalTrades ?? 0)} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.splitTitle}>Test</Text>
                    <KeyValue k="Net profit" v={fmt(validation.test.netProfit)} />
                    <KeyValue k="Win rate" v={`${fmt((validation.test.winRate ?? 0) * 100, 1)}%`} />
                    <KeyValue k="Trades" v={String(validation.test.totalTrades ?? 0)} />
                  </View>
                </Row>
                <Text style={styles.note}>
                  A strategy that only performs on training data is likely overfit. Trust out-of-sample results more.
                </Text>
              </Card>
            </>
          ) : null}
        </>
      ) : null}

      <Text style={styles.note}>Simulated results with assumed payouts. Not indicative of future performance.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: font.body, fontWeight: "700", flexShrink: 1 },
  dates: { color: colors.textDim, fontSize: font.caption, marginTop: 2 },
  progress: { color: colors.warning, fontSize: font.caption, marginTop: spacing.xs },
  error: { color: colors.down, fontSize: font.caption, marginTop: spacing.xs },
  dim: { color: colors.textDim, fontSize: font.body },
  groupRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, gap: 8 },
  groupKey: { color: colors.text, fontSize: font.caption, fontWeight: "600", flex: 1.4 },
  groupStat: { color: colors.textDim, fontSize: font.caption, flex: 1, textAlign: "right" },
  splitTitle: { color: colors.text, fontWeight: "700", fontSize: font.body, marginBottom: spacing.xs },
  note: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.md, lineHeight: 18 }
});
