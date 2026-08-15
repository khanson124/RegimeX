import React from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useDecisions } from "../src/api/hooks";
import { Badge, Card, EmptyState, ErrorView, Skeleton } from "../src/components/ui";
import { colors, font, spacing, REGIME_LABELS } from "../src/theme";

function eventTone(eventType: string): "up" | "down" | "warning" | "neutral" | "accent" {
  if (eventType.includes("REJECTED") || eventType.includes("FAILED") || eventType.includes("EMERGENCY")) return "down";
  if (eventType.includes("SIGNAL") || eventType.includes("TRADE")) return "up";
  if (eventType.includes("SELECTED") || eventType.includes("CLASSIFIED")) return "accent";
  return "neutral";
}

export default function DecisionsScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useDecisions();

  if (isLoading) {
    return (
      <View style={[styles.container, { padding: spacing.lg }]}>
        <Skeleton height={90} />
        <Skeleton height={90} />
        <Skeleton height={90} />
      </View>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const items = data?.items ?? [];

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      data={items}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListEmptyComponent={
        <EmptyState
          title="No decisions logged"
          hint="Start the live engine — every regime classification, strategy selection, signal, and risk check is recorded here."
        />
      }
      renderItem={({ item }) => (
        <Card>
          <View style={styles.headerRow}>
            <Badge tone={eventTone(item.eventType)} text={item.eventType.replace(/_/g, " ")} />
            <Text style={styles.time}>{new Date(item.createdAt).toLocaleTimeString()}</Text>
          </View>
          <Text style={styles.meta}>
            {[
              item.symbol,
              item.regime ? REGIME_LABELS[item.regime] ?? item.regime : null,
              item.strategyId,
              item.action,
              item.riskApproved === false ? "RISK BLOCKED" : null
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {item.reasons.map((r, i) => (
            <Text key={i} style={styles.reason}>
              • {r}
            </Text>
          ))}
        </Card>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  time: { color: colors.textFaint, fontSize: font.caption },
  meta: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.xs, fontWeight: "600" },
  reason: { color: colors.textDim, fontSize: font.caption, marginTop: 3, lineHeight: 17 }
});
