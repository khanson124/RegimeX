import React from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useCloneStrategy, useStrategies, useToggleStrategy } from "../../src/api/hooks";
import { EmptyState, ErrorView, Skeleton } from "../../src/components/ui";
import {
  ChipRow,
  PrimaryButton,
  SoftCard,
  StatusChip
} from "../../src/components/design";
import { colors, font, spacing, REGIME_LABELS } from "../../src/theme";

export default function StrategiesScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useStrategies();
  const toggle = useToggleStrategy();
  const clone = useCloneStrategy();
  const router = useRouter();

  if (isLoading) {
    return (
      <View style={[styles.container, styles.pad]}>
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
      contentContainerStyle={styles.pad}
      data={strategies}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListEmptyComponent={<EmptyState title="No strategies" hint="Seed the database or create a strategy via the API." />}
      renderItem={({ item }) => (
        <Pressable onPress={() => router.push(`/strategy/${item.id}`)}>
          <SoftCard>
            <View style={styles.header}>
              <Text style={styles.name}>{item.name}</Text>
              <StatusChip
                label={item.enabled ? "Enabled" : "Disabled"}
                tone={item.enabled ? "up" : "neutral"}
              />
            </View>
            <Text style={styles.kind}>
              {item.kind} · v{item.version}
              {item.isSystem ? " · system" : ""}
            </Text>
            <ChipRow>
              {item.supportedRegimes.slice(0, 4).map((r) => (
                <StatusChip key={r} label={REGIME_LABELS[r] ?? r} tone="accent" />
              ))}
            </ChipRow>
            <View style={styles.actions}>
              <PrimaryButton
                title={item.enabled ? "Disable" : "Enable"}
                variant="secondary"
                disabled={toggle.isPending}
                onPress={() => toggle.mutate({ id: item.id, enable: !item.enabled })}
              />
              <PrimaryButton
                title="Clone"
                variant="secondary"
                disabled={clone.isPending}
                onPress={() => clone.mutate(item.id)}
              />
            </View>
          </SoftCard>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 48 },
  header: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm, alignItems: "flex-start" },
  name: { color: colors.text, fontSize: font.title, fontWeight: "700", flex: 1 },
  kind: { color: colors.textDim, fontSize: font.caption, marginTop: 4, marginBottom: spacing.sm },
  actions: { marginTop: spacing.md, gap: spacing.xs }
});
