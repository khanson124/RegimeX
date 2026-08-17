import React from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useDemoTrades } from "../src/api/hooks";
import { Badge, Card, EmptyState, ErrorView, Metric, Row, Skeleton } from "../src/components/ui";
import { colors, font, spacing, REGIME_LABELS } from "../src/theme";

interface TradeRow {
  id: string;
  status: string;
  direction: string;
  stake: number | string;
  proposedPayout?: number | string | null;
  finalPayout?: number | string | null;
  profit: number | string | null;
  symbol: string;
  strategyId: string | null;
  regime: string | null;
  signalConfidence?: number | null;
  entryReason?: string | null;
  openedAt: string | null;
  settledAt: string | null;
}

function asNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatMoney(value: unknown): string {
  const n = asNumber(value);
  return n != null ? n.toFixed(2) : "—";
}

export default function TradesScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useDemoTrades();

  if (isLoading) {
    return (
      <View style={[styles.container, { padding: spacing.lg }]}>
        <Skeleton height={120} />
        <Skeleton height={120} />
      </View>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const trades = (data?.items ?? []) as unknown as TradeRow[];

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      data={trades}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListEmptyComponent={
        <EmptyState
          title="No demo trades yet"
          hint="Trades appear here when the engine runs in demo-trading mode and a signal passes all risk checks."
        />
      }
      renderItem={({ item }) => {
        const settled = item.status === "WON" || item.status === "LOST";
        const stake = asNumber(item.stake);
        const payout = asNumber(item.finalPayout ?? item.proposedPayout);
        const profit = asNumber(item.profit);
        const openedLabel = item.openedAt ? new Date(item.openedAt).toLocaleString() : "—";
        return (
          <Card>
            <Row style={{ justifyContent: "space-between" }}>
              <Text style={styles.title}>
                {item.symbol} · {item.direction}
              </Text>
              <Badge
                tone={item.status === "WON" ? "up" : item.status === "LOST" ? "down" : "warning"}
                text={item.status}
              />
            </Row>
            <Text style={styles.meta}>
              {openedLabel}
              {item.regime ? ` · ${REGIME_LABELS[item.regime] ?? item.regime}` : ""}
              {item.strategyId ? ` · ${item.strategyId}` : ""}
            </Text>
            <Row style={{ marginTop: spacing.sm }}>
              <Metric label="Stake" value={formatMoney(stake)} />
              <Metric label="Payout" value={formatMoney(payout)} />
              <Metric
                label="Profit/Loss"
                value={settled && profit != null ? `${profit >= 0 ? "+" : ""}${profit.toFixed(2)}` : "open"}
                tone={profit != null && profit > 0 ? "up" : profit != null && profit < 0 ? "down" : "neutral"}
              />
              <Metric
                label="Confidence"
                value={item.signalConfidence != null ? `${(item.signalConfidence * 100).toFixed(0)}%` : "—"}
              />
            </Row>
            {item.entryReason ? <Text style={styles.reason}>{item.entryReason}</Text> : null}
          </Card>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  meta: { color: colors.textFaint, fontSize: font.caption, marginTop: 2 },
  reason: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 }
});
