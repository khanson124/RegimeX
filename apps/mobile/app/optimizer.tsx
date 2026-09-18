import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApiError } from "../src/api/client";
import { useCreateOptimization, useOptimizationCandidates, useOptimizations, useSymbols } from "../src/api/hooks";
import { EmptyState, ErrorView, Skeleton } from "../src/components/ui";
import {
  ChipRow,
  Collapsible,
  PrimaryButton,
  ProgressBar,
  SectionHeader,
  SegmentedChips,
  SoftCard,
  StatusChip,
  TicketField
} from "../src/components/design";
import { colors, font, spacing } from "../src/theme";

const STRATEGIES = [
  { kind: "breakout-momentum", label: "Breakout Momentum" },
  { kind: "ema-pullback", label: "EMA Pullback" },
  { kind: "bollinger-reversion", label: "Bollinger Reversion" },
  { kind: "squeeze-breakout", label: "Squeeze Breakout" }
] as const;

const INTERVALS = ["1m", "5m", "15m"] as const;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export default function OptimizerScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useOptimizations();
  const { data: symbolsData } = useSymbols();
  const create = useCreateOptimization();

  const [strategyKind, setStrategyKind] = useState<(typeof STRATEGIES)[number]["kind"]>("breakout-momentum");
  const [symbol, setSymbol] = useState<string | null>(null);
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>("1m");
  const [from, setFrom] = useState(isoDaysAgo(60));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmLarge, setConfirmLarge] = useState(false);

  const candidates = useOptimizationCandidates(selectedRunId);
  const enabledSymbols = symbolsData?.symbols.filter((s) => s.enabled) ?? [];
  const activeSymbol = symbol ?? enabledSymbols[0]?.derivSymbol ?? null;
  const items = data?.items ?? [];

  if (isLoading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.pad}>
        <Skeleton height={200} />
        <Skeleton height={120} />
      </ScrollView>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  function submit(): void {
    setFormError(null);
    if (!activeSymbol) {
      setFormError("Select a symbol");
      return;
    }
    create.mutate(
      {
        strategyKind,
        symbol: activeSymbol,
        interval,
        from,
        to,
        testSplit: 0.3,
        confirmLargeRun: confirmLarge,
        parameters: {
          emaFast: [10, 20],
          emaSlow: [40, 50],
          adxThreshold: [18, 22]
        }
      },
      {
        onSuccess: () => {
          setConfirmLarge(false);
          void refetch();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") {
            setConfirmLarge(true);
            setFormError(`${err.message} Tap "Confirm large run" to proceed.`);
          } else {
            setFormError(err instanceof ApiError ? err.message : "Failed to start optimizer");
          }
        }
      }
    );
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.pad}
      data={items}
      keyExtractor={(item) => String(item.id)}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListHeaderComponent={
        <>
          <SectionHeader title="New grid search" />
          <SoftCard>
            <Text style={styles.fieldLabel}>Strategy</Text>
            <SegmentedChips
              options={STRATEGIES.map((s) => ({ id: s.kind, label: s.label }))}
              value={strategyKind}
              onChange={(id) => setStrategyKind(id as (typeof STRATEGIES)[number]["kind"])}
            />
            <View style={{ height: spacing.md }} />
            <Text style={styles.fieldLabel}>Symbol</Text>
            <SegmentedChips
              options={enabledSymbols.map((s) => ({ id: s.derivSymbol, label: s.derivSymbol }))}
              value={activeSymbol}
              onChange={setSymbol}
            />
            <View style={{ height: spacing.md }} />
            <Text style={styles.fieldLabel}>Interval</Text>
            <SegmentedChips
              options={INTERVALS.map((iv) => ({ id: iv, label: iv }))}
              value={interval}
              onChange={(id) => setInterval(id as (typeof INTERVALS)[number])}
            />
            <View style={{ height: spacing.md }} />
            <View style={styles.fieldRow}>
              <TicketField label="From" value={from} onChangeText={setFrom} keyboardType="default" />
              <TicketField label="To" value={to} onChangeText={setTo} keyboardType="default" />
            </View>

            <Collapsible title="Optimization ranges (default grid)" inline>
              <Text style={styles.hint}>Editable ranges are not exposed in this MVP — default grid:</Text>
              <Text style={styles.paramLine}>emaFast · [10, 20]</Text>
              <Text style={styles.paramLine}>emaSlow · [40, 50]</Text>
              <Text style={styles.paramLine}>adxThreshold · [18, 22]</Text>
            </Collapsible>

            {formError ? <Text style={styles.error}>{formError}</Text> : null}
            <PrimaryButton
              title={confirmLarge ? "Confirm large run" : "Start optimization"}
              onPress={submit}
              loading={create.isPending}
            />
            <Text style={styles.hint}>
              Large combinatorial runs require explicit confirmation.
            </Text>
          </SoftCard>

          <SectionHeader title="Runs" />
        </>
      }
      ListEmptyComponent={<EmptyState title="No optimization runs" hint="Start a grid search above." />}
      renderItem={({ item }) => {
        const run = item as Record<string, unknown>;
        const status = String(run.status ?? "UNKNOWN");
        const id = String(run.id);
        const expanded = selectedRunId === id;
        const progress = Math.round(Number(run.progress ?? 0) * 100);
        const tone =
          status === "COMPLETED" ? "up" : status === "FAILED" ? "down" : status === "RUNNING" ? "warning" : "neutral";
        return (
          <Pressable onPress={() => setSelectedRunId(expanded ? null : id)}>
            <SoftCard>
              <View style={styles.runHeader}>
                <Text style={styles.runTitle}>
                  {String(run.strategyKind)} · {String(run.symbol)} {String(run.interval)}
                </Text>
                <StatusChip label={status} tone={tone} />
              </View>
              <Text style={styles.meta}>
                {String(run.totalCombinations)} combos · {progress}%
              </Text>
              {status === "RUNNING" || progress > 0 ? (
                <ProgressBar progress={progress} tone={status === "FAILED" ? "down" : "accent"} />
              ) : null}
              {expanded ? (
                <View style={{ marginTop: spacing.md }}>
                  <Text style={styles.fieldLabel}>Top candidates</Text>
                  {candidates.data?.candidates?.length ? (
                    (candidates.data.candidates as Array<Record<string, unknown>>).slice(0, 5).map((c, idx) => (
                      <View key={String(c.id)} style={styles.candidate}>
                        <ChipRow>
                          <StatusChip
                            label={idx === 0 ? "Best" : `#${idx + 1}`}
                            tone={idx === 0 ? "up" : "neutral"}
                          />
                          <StatusChip
                            label={`Score ${Number(c.selectionScore ?? 0).toFixed(1)}`}
                            tone="accent"
                          />
                        </ChipRow>
                        <Text style={styles.candidateMeta}>
                          PF {c.profitFactor != null ? Number(c.profitFactor).toFixed(2) : "—"} · OOS E{" "}
                          {c.oosExpectancy != null ? Number(c.oosExpectancy).toFixed(3) : "—"}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.hint}>
                      {candidates.isLoading ? "Loading candidates…" : "No candidates yet."}
                    </Text>
                  )}
                </View>
              ) : (
                <Text style={styles.tapHint}>{expanded ? "" : "Tap for candidates"}</Text>
              )}
            </SoftCard>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 48 },
  fieldLabel: {
    color: colors.textFaint,
    fontSize: font.micro,
    fontWeight: "700",
    marginBottom: spacing.sm,
    letterSpacing: 0.6,
    textTransform: "uppercase"
  },
  fieldRow: { flexDirection: "row", gap: spacing.md, flexWrap: "wrap" },
  error: { color: colors.down, fontSize: font.caption, marginBottom: spacing.sm },
  hint: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  paramLine: { color: colors.textDim, fontSize: font.caption, marginTop: 4, fontWeight: "600" },
  runHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: spacing.sm },
  runTitle: { color: colors.text, fontSize: font.body, fontWeight: "700", flex: 1 },
  meta: { color: colors.textDim, fontSize: font.caption, marginTop: 6 },
  candidate: { marginTop: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  candidateMeta: { color: colors.textDim, fontSize: font.caption, marginTop: 6 },
  tapHint: { color: colors.textFaint, fontSize: font.micro, marginTop: spacing.sm }
});
