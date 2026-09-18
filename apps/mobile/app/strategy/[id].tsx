import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useStrategy, useToggleStrategy } from "../../src/api/hooks";
import { ErrorView, Skeleton } from "../../src/components/ui";
import {
  ChipRow,
  Collapsible,
  InfoRow,
  PrimaryButton,
  SectionHeader,
  SoftCard,
  StatusChip
} from "../../src/components/design";
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
  const params = s.parameters ?? {};
  const origin = (s as { parametersOrigin?: string }).parametersOrigin ?? "SEED";

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.pad}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <SoftCard>
        <View style={styles.header}>
          <Text style={styles.name}>{s.name}</Text>
          <StatusChip
            label={s.enabled ? "Enabled" : "Disabled"}
            tone={s.enabled ? "up" : "neutral"}
          />
        </View>
        <Text style={styles.desc}>{s.description}</Text>
        <ChipRow>
          <StatusChip label={s.kind} tone="accent" />
          <StatusChip label={`v${s.version}`} tone="neutral" />
          {s.isSystem ? <StatusChip label="System" tone="warning" /> : null}
        </ChipRow>
        <Text style={styles.meta}>Min history {s.minimumHistory} candles</Text>
      </SoftCard>

      <SectionHeader title="Supported regimes" />
      <SoftCard>
        <ChipRow>
          {s.supportedRegimes.map((r) => (
            <StatusChip key={r} label={REGIME_LABELS[r] ?? r} tone="accent" />
          ))}
        </ChipRow>
      </SoftCard>

      <Collapsible title="Active parameter set">
        <ChipRow>
          <StatusChip label={`Origin · ${origin}`} tone="neutral" />
          <StatusChip label="Read only" tone="warning" />
        </ChipRow>
        <Text style={styles.hint}>
          {s.isSystem
            ? "System strategies are read-only here. Clone to create an editable copy (API validates parameters)."
            : "Parameter editing stays API-only for validated updates — shown here for inspection."}
        </Text>
        {Object.keys(params).length === 0 ? (
          <Text style={styles.hint}>No active parameters.</Text>
        ) : (
          Object.entries(params).map(([key, value]) => (
            <InfoRow key={key} label={key} value={String(value)} />
          ))
        )}
      </Collapsible>

      <PrimaryButton
        title={s.enabled ? "Disable strategy" : "Enable strategy"}
        variant={s.enabled ? "secondary" : "primary"}
        loading={toggle.isPending}
        onPress={() => toggle.mutate({ id: s.id, enable: !s.enabled })}
      />
      <Text style={styles.note}>
        Validated performance appears in backtests. Selection depends on regime fit, sample size, and
        out-of-sample evidence — not raw profit alone.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 48 },
  header: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm, alignItems: "flex-start" },
  name: { color: colors.text, fontSize: font.title, fontWeight: "800", flex: 1 },
  desc: { color: colors.textDim, fontSize: font.body, marginTop: spacing.sm, lineHeight: 20, marginBottom: spacing.md },
  meta: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm },
  hint: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.sm, marginBottom: spacing.sm, lineHeight: 18 },
  note: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.md, lineHeight: 18 }
});
