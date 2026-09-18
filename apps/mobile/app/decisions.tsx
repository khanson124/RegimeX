import React, { useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useDecisions } from "../src/api/hooks";
import { EmptyState, ErrorView, Skeleton } from "../src/components/ui";
import {
  ChipRow,
  Collapsible,
  SegmentedChips,
  SoftCard,
  StatusChip
} from "../src/components/design";
import { colors, font, spacing, REGIME_LABELS } from "../src/theme";

type FilterKey = "ALL" | "TRADES" | "HOLDS" | "RISK" | "OTHER";

function eventTone(eventType: string): "up" | "down" | "warning" | "neutral" | "accent" {
  if (eventType.includes("REJECTED") || eventType.includes("FAILED") || eventType.includes("EMERGENCY")) {
    return "down";
  }
  if (eventType.includes("SIGNAL") || eventType.includes("TRADE")) return "up";
  if (eventType.includes("SELECTED") || eventType.includes("CLASSIFIED")) return "accent";
  return "neutral";
}

function actionTone(action: string | null): "up" | "down" | "warning" | "neutral" | "accent" {
  if (!action) return "neutral";
  const a = action.toUpperCase();
  if (a === "HOLD" || a === "NO_TRADE" || a === "SKIP") return "warning";
  if (a.includes("BUY") || a.includes("CALL") || a === "LONG") return "up";
  if (a.includes("SELL") || a.includes("PUT") || a === "SHORT") return "down";
  return "accent";
}

function matchesFilter(
  item: {
    eventType: string;
    action: string | null;
    riskApproved: boolean | null;
  },
  filter: FilterKey
): boolean {
  if (filter === "ALL") return true;
  const action = (item.action ?? "").toUpperCase();
  if (filter === "HOLDS") {
    return action === "HOLD" || action === "NO_TRADE" || action === "SKIP" || item.eventType.includes("HOLD");
  }
  if (filter === "RISK") {
    return item.riskApproved === false || item.eventType.includes("RISK") || item.eventType.includes("REJECTED");
  }
  if (filter === "TRADES") {
    return (
      item.eventType.includes("TRADE") ||
      item.eventType.includes("SIGNAL") ||
      action.includes("BUY") ||
      action.includes("SELL") ||
      action.includes("CALL") ||
      action.includes("PUT")
    );
  }
  return !(
    matchesFilter(item, "HOLDS") ||
    matchesFilter(item, "RISK") ||
    matchesFilter(item, "TRADES")
  );
}

export default function DecisionsScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useDecisions();
  const [filter, setFilter] = useState<FilterKey>("ALL");

  const items = data?.items ?? [];
  const filtered = useMemo(() => items.filter((item) => matchesFilter(item, filter)), [items, filter]);

  if (isLoading) {
    return (
      <View style={[styles.container, styles.pad]}>
        <Skeleton height={90} />
        <Skeleton height={90} />
        <Skeleton height={90} />
      </View>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.pad}
      data={filtered}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListHeaderComponent={
        <View style={styles.filterBlock}>
          <SegmentedChips
            options={[
              { id: "ALL", label: "All" },
              { id: "TRADES", label: "Signals" },
              { id: "HOLDS", label: "Holds" },
              { id: "RISK", label: "Risk" },
              { id: "OTHER", label: "Other" }
            ]}
            value={filter}
            onChange={(v) => setFilter(v as FilterKey)}
          />
          <Text style={styles.filterMeta}>
            {filtered.length} of {items.length} events
          </Text>
        </View>
      }
      ListEmptyComponent={
        <EmptyState
          title={items.length === 0 ? "No decisions logged" : "No matches"}
          hint={
            items.length === 0
              ? "Start the live engine — every regime classification, strategy selection, signal, and risk check is recorded here."
              : "Try another filter."
          }
        />
      }
      renderItem={({ item }) => {
        const actionLabel = item.action?.toUpperCase() || "—";
        const primaryReason = item.reasons[0] ?? null;
        const extraReasons = item.reasons.slice(1);
        const when = new Date(item.createdAt);
        return (
          <SoftCard>
            <View style={styles.headerRow}>
              <Text style={styles.symbol}>{item.symbol ?? "—"}</Text>
              <Text style={styles.time}>
                {when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
                {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
              </Text>
            </View>
            <ChipRow>
              <StatusChip label={actionLabel} tone={actionTone(item.action)} />
              <StatusChip
                label={item.eventType.replace(/_/g, " ")}
                tone={eventTone(item.eventType)}
              />
              {item.riskApproved === false ? <StatusChip label="Risk blocked" tone="down" /> : null}
            </ChipRow>
            <Text style={styles.meta}>
              {[
                item.strategyId ?? "No strategy",
                item.regime ? REGIME_LABELS[item.regime] ?? item.regime : null
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {primaryReason ? <Text style={styles.reason}>{primaryReason}</Text> : null}
            {extraReasons.length > 0 || item.regimeConfidence != null ? (
              <Collapsible title="Details" inline>
                {extraReasons.map((r, i) => (
                  <Text key={i} style={styles.detailLine}>
                    • {r}
                  </Text>
                ))}
                {item.regimeConfidence != null ? (
                  <Text style={styles.detailLine}>Regime confidence: {item.regimeConfidence}</Text>
                ) : null}
                <Text style={styles.detailLine}>Event: {item.eventType}</Text>
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
  filterBlock: { marginBottom: spacing.md },
  filterMeta: { color: colors.textFaint, fontSize: font.micro, marginTop: spacing.sm },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", marginBottom: spacing.sm },
  symbol: { color: colors.text, fontSize: font.title, fontWeight: "700" },
  time: { color: colors.textFaint, fontSize: font.caption },
  meta: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.sm, fontWeight: "600" },
  reason: { color: colors.text, fontSize: font.body, marginTop: spacing.sm, lineHeight: 20 },
  detailLine: { color: colors.textDim, fontSize: font.caption, marginTop: 4, lineHeight: 17 }
});
