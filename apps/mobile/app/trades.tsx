import React from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useDemoTrades } from "../src/api/hooks";
import { EmptyState, ErrorView, Skeleton } from "../src/components/ui";
import {
  ChipRow,
  Collapsible,
  SoftCard,
  StatRow,
  StatTile,
  StatusChip
} from "../src/components/design";
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
      <View style={[styles.container, styles.pad]}>
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
      contentContainerStyle={styles.pad}
      data={trades}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListHeaderComponent={
        <SoftCard>
          <ChipRow>
            <StatusChip label="Legacy" tone="warning" />
            <StatusChip label="Read only" tone="neutral" />
          </ChipRow>
          <Text style={styles.archiveHint}>
            Archived rise/fall (CALL/PUT) demo contracts. Live CFD positions are on Positions.
          </Text>
        </SoftCard>
      }
      ListEmptyComponent={
        <EmptyState
          title="No archived binary trades"
          hint="This list is historical rise/fall demo contracts only."
        />
      }
      renderItem={({ item }) => {
        const settled = item.status === "WON" || item.status === "LOST";
        const stake = asNumber(item.stake);
        const payout = asNumber(item.finalPayout ?? item.proposedPayout);
        const profit = asNumber(item.profit);
        const openedLabel = item.openedAt ? new Date(item.openedAt).toLocaleString() : "—";
        return (
          <SoftCard>
            <View style={styles.header}>
              <Text style={styles.title}>
                {item.symbol} · {item.direction}
              </Text>
              <StatusChip
                label={item.status}
                tone={item.status === "WON" ? "up" : item.status === "LOST" ? "down" : "warning"}
              />
            </View>
            <Text style={styles.meta}>
              {openedLabel}
              {item.regime ? ` · ${REGIME_LABELS[item.regime] ?? item.regime}` : ""}
              {item.strategyId ? ` · ${item.strategyId}` : ""}
            </Text>
            <View style={{ height: spacing.sm }} />
            <StatRow>
              <StatTile label="Stake" value={formatMoney(stake)} />
              <StatTile label="Payout" value={formatMoney(payout)} />
              <StatTile
                label="P/L"
                value={settled && profit != null ? `${profit >= 0 ? "+" : ""}${profit.toFixed(2)}` : "open"}
                tone={profit != null && profit > 0 ? "up" : profit != null && profit < 0 ? "down" : "neutral"}
              />
            </StatRow>
            {item.entryReason || item.signalConfidence != null ? (
              <Collapsible title="Entry detail" inline>
                {item.signalConfidence != null ? (
                  <Text style={styles.detail}>
                    Confidence {(item.signalConfidence * 100).toFixed(0)}%
                  </Text>
                ) : null}
                {item.entryReason ? <Text style={styles.detail}>{item.entryReason}</Text> : null}
              </Collapsible>
            ) : null}
          </SoftCard>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 48 },
  archiveHint: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: spacing.sm },
  title: { color: colors.textDim, fontSize: font.body, fontWeight: "600", flex: 1 },
  meta: { color: colors.textFaint, fontSize: font.caption, marginTop: 4 },
  detail: { color: colors.textDim, fontSize: font.caption, marginTop: 4, lineHeight: 18 }
});
