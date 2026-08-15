import React from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useCloneStrategy, useStrategies, useToggleStrategy } from "../../src/api/hooks";
import { Badge, Card, EmptyState, ErrorView, Row, Skeleton } from "../../src/components/ui";
import { colors, font, spacing, REGIME_LABELS } from "../../src/theme";

export default function StrategiesScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useStrategies();
  const toggle = useToggleStrategy();
  const clone = useCloneStrategy();
  const router = useRouter();

  if (isLoading) {
    return (
      <View style={[styles.container, { padding: spacing.lg }]}>
        <Skeleton height={110} />
        <Skeleton height={110} />
        <Skeleton height={110} />
      </View>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const strategies = data?.strategies ?? [];

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      data={strategies}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListEmptyComponent={<EmptyState title="No strategies" hint="Seed the database or create a strategy via the API." />}
      renderItem={({ item }) => (
        <Pressable onPress={() => router.push(`/strategy/${item.id}`)}>
          <Card>
            <Row style={{ justifyContent: "space-between" }}>
              <Text style={styles.name}>{item.name}</Text>
              <Badge tone={item.enabled ? "up" : "neutral"} text={item.enabled ? "ENABLED" : "DISABLED"} />
            </Row>
            <Text style={styles.kind}>
              {item.kind} · v{item.version}
            </Text>
            <View style={styles.regimeRow}>
              {item.supportedRegimes.slice(0, 4).map((r) => (
                <Text key={r} style={styles.regimeChip}>
                  {REGIME_LABELS[r] ?? r}
                </Text>
              ))}
            </View>
            <Row style={{ marginTop: spacing.sm }}>
              <Pressable
                style={styles.actionBtn}
                disabled={toggle.isPending}
                onPress={() => toggle.mutate({ id: item.id, enable: !item.enabled })}
              >
                <Text style={styles.actionText}>{item.enabled ? "Disable" : "Enable"}</Text>
              </Pressable>
              <Pressable style={styles.actionBtn} disabled={clone.isPending} onPress={() => clone.mutate(item.id)}>
                <Text style={styles.actionText}>Clone</Text>
              </Pressable>
            </Row>
          </Card>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  name: { color: colors.text, fontSize: font.title, fontWeight: "700", flexShrink: 1 },
  kind: { color: colors.textDim, fontSize: font.caption, marginTop: 2 },
  regimeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: spacing.sm },
  regimeChip: {
    color: colors.textDim,
    fontSize: font.caption,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: "hidden"
  },
  actionBtn: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8
  },
  actionText: { color: colors.accent, fontSize: font.caption, fontWeight: "700" }
});
