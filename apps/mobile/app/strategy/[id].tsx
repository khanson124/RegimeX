import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useStrategy, useToggleStrategy } from "../../src/api/hooks";
import { Badge, Button, Card, ErrorView, KeyValue, Row, SectionTitle, Skeleton } from "../../src/components/ui";
import { colors, font, spacing, REGIME_LABELS } from "../../src/theme";

export default function StrategyDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading, isError, error, refetch, isRefetching } = useStrategy(id);
  const toggle = useToggleStrategy();

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

  const s = data.strategy;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Text style={styles.name}>{s.name}</Text>
          <Badge tone={s.enabled ? "up" : "neutral"} text={s.enabled ? "ENABLED" : "DISABLED"} />
        </Row>
        <Text style={styles.desc}>{s.description}</Text>
        <Text style={styles.meta}>
          {s.kind} · version {s.version} · min history {s.minimumHistory} candles
          {s.isSystem ? " · system strategy" : ""}
        </Text>
      </Card>

      <SectionTitle>Supported regimes</SectionTitle>
      <Card>
        <View style={styles.regimeRow}>
          {s.supportedRegimes.map((r) => (
            <Text key={r} style={styles.regimeChip}>
              {REGIME_LABELS[r] ?? r}
            </Text>
          ))}
        </View>
      </Card>

      <SectionTitle>Parameters</SectionTitle>
      <Card>
        {Object.entries(s.parameters).map(([key, value]) => (
          <KeyValue key={key} k={key} v={String(value)} />
        ))}
      </Card>

      <Button
        title={s.enabled ? "Disable strategy" : "Enable strategy"}
        variant={s.enabled ? "secondary" : "primary"}
        loading={toggle.isPending}
        onPress={() => toggle.mutate({ id: s.id, enable: !s.enabled })}
      />
      <Text style={styles.note}>
        Validated performance appears in the backtest results screens. Selection eligibility depends on
        regime fit, sample size, and recent out-of-sample performance — not raw profit alone.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  name: { color: colors.text, fontSize: font.title, fontWeight: "800", flexShrink: 1 },
  desc: { color: colors.textDim, fontSize: font.body, marginTop: spacing.sm, lineHeight: 20 },
  meta: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm },
  regimeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
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
  note: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.md, lineHeight: 18 }
});
