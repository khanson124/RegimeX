import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ApiError } from "../src/api/client";
import { useCreateOptimization, useOptimizationCandidates, useOptimizations, useSymbols } from "../src/api/hooks";
import { Badge, Button, Card, EmptyState, ErrorView, Input, Row, SectionTitle, Skeleton } from "../src/components/ui";
import { colors, font, spacing } from "../src/theme";

const STRATEGIES = [
  { kind: "breakout-momentum", label: "Breakout Momentum" },
  { kind: "ema-pullback", label: "EMA Pullback" },
  { kind: "bollinger-reversion", label: "Bollinger Reversion" },
  { kind: "squeeze-breakout", label: "Squeeze Breakout" }
] as const;

const INTERVALS = ["1m", "5m"] as const;

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
      <ViewPad>
        <Skeleton height={200} />
        <Skeleton height={120} />
      </ViewPad>
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
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      data={items}
      keyExtractor={(item) => String(item.id)}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
      ListHeaderComponent={
        <>
          <SectionTitle>New grid search</SectionTitle>
          <Card>
            <Text style={styles.label}>Strategy</Text>
            <Row style={{ marginBottom: spacing.sm, flexWrap: "wrap" }}>
              {STRATEGIES.map((s) => (
                <Pressable key={s.kind} onPress={() => setStrategyKind(s.kind)}>
                  <Text style={[styles.selector, strategyKind === s.kind && styles.selectorActive]}>{s.label}</Text>
                </Pressable>
              ))}
            </Row>
            <Text style={styles.label}>Symbol</Text>
            <Row style={{ marginBottom: spacing.sm }}>
              {enabledSymbols.map((sym) => (
                <Pressable key={sym.id} onPress={() => setSymbol(sym.derivSymbol)}>
                  <Text style={[styles.selector, activeSymbol === sym.derivSymbol && styles.selectorActive]}>
                    {sym.derivSymbol}
                  </Text>
                </Pressable>
              ))}
            </Row>
            <Text style={styles.label}>Interval</Text>
            <Row style={{ marginBottom: spacing.sm }}>
              {INTERVALS.map((iv) => (
                <Pressable key={iv} onPress={() => setInterval(iv)}>
                  <Text style={[styles.selector, interval === iv && styles.selectorActive]}>{iv}</Text>
                </Pressable>
              ))}
            </Row>
            <Input label="From (YYYY-MM-DD)" value={from} onChangeText={setFrom} />
            <Input label="To (YYYY-MM-DD)" value={to} onChangeText={setTo} />
            {formError ? <Text style={styles.error}>{formError}</Text> : null}
            <Button
              title={confirmLarge ? "Confirm large run" : "Start optimization"}
              onPress={submit}
              loading={create.isPending}
            />
            <Text style={styles.hint}>
              Initial MVP uses a small default parameter grid. Large runs require explicit confirmation to prevent
              combinatorial explosions.
            </Text>
          </Card>

          <SectionTitle>Runs</SectionTitle>
        </>
      }
      ListEmptyComponent={<EmptyState title="No optimization runs" hint="Start a grid search above." />}
      renderItem={({ item }) => {
        const run = item as Record<string, unknown>;
        const status = String(run.status ?? "UNKNOWN");
        const id = String(run.id);
        const expanded = selectedRunId === id;
        return (
          <Pressable onPress={() => setSelectedRunId(expanded ? null : id)}>
            <Card>
              <Row style={{ justifyContent: "space-between" }}>
                <Text style={styles.runTitle}>
                  {String(run.strategyKind)} · {String(run.symbol)} {String(run.interval)}
                </Text>
                <Badge
                  tone={status === "COMPLETED" ? "up" : status === "FAILED" ? "down" : "accent"}
                  text={status}
                />
              </Row>
              <Text style={styles.meta}>
                {String(run.totalCombinations)} combos · {Math.round(Number(run.progress ?? 0) * 100)}%
              </Text>
              {expanded && candidates.data?.candidates?.length ? (
                <View style={{ marginTop: spacing.sm }}>
                  {(candidates.data.candidates as Array<Record<string, unknown>>).slice(0, 5).map((c) => (
                    <Text key={String(c.id)} style={styles.candidate}>
                      Score {Number(c.selectionScore ?? 0).toFixed(1)} · PF{" "}
                      {c.profitFactor != null ? Number(c.profitFactor).toFixed(2) : "—"} · OOS{" "}
                      {c.oosExpectancy != null ? Number(c.oosExpectancy).toFixed(3) : "—"}
                    </Text>
                  ))}
                </View>
              ) : null}
            </Card>
          </Pressable>
        );
      }}
    />
  );
}

function ViewPad({ children }: { children: React.ReactNode }) {
  return <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>{children}</ScrollView>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  label: { color: colors.textDim, fontSize: font.caption, marginBottom: spacing.xs },
  selector: {
    color: colors.textDim,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: font.caption,
    fontWeight: "700",
    marginRight: 6,
    marginBottom: 6
  },
  selectorActive: { color: colors.text, borderColor: colors.accent, backgroundColor: "#12283F" },
  error: { color: colors.down, fontSize: font.caption, marginBottom: spacing.sm },
  hint: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  runTitle: { color: colors.text, fontSize: font.body, fontWeight: "700", flex: 1 },
  meta: { color: colors.textDim, fontSize: font.caption, marginTop: 4 },
  candidate: { color: colors.textDim, fontSize: font.caption, marginTop: 4 }
});
