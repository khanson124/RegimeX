import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View, Pressable, ActivityIndicator } from "react-native";
import {
  useForwardComparison,
  useResearchMetrics,
  useResearchRuns,
  useResearchVerdict,
  useStrategies,
  useCreateResearchExperiment,
  type StrategyRow
} from "../src/api/hooks";
import { Card, EmptyState } from "../src/components/ui";
import { colors, font, spacing } from "../src/theme";

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];

export default function ResearchScreen() {
  const [symbol, setSymbol] = useState("R_75");
  const [interval, setInterval] = useState<"1m" | "5m">("5m");
  const [strategyId, setStrategyId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();

  const { data: strategies } = useStrategies();
  const { data: runs } = useResearchRuns();
  const { data: metrics } = useResearchMetrics({ symbol, interval, strategyId: strategyId || undefined });
  const { data: comparison } = useForwardComparison({
    symbol,
    interval,
    strategyId: strategyId || undefined
  });
  const { data: verdictData } = useResearchVerdict(selectedRunId);
  const createExperiment = useCreateResearchExperiment();

  const selectedStrategy = strategies?.strategies.find((s: StrategyRow) => s.id === strategyId);
  const wfMetric = metrics?.items.find((m) => m.segment === "WALK_FORWARD" && m.regime === "ALL");
  const trainMetric = metrics?.items.find((m) => m.segment === "TRAIN" && m.regime === "ALL");
  const holdoutMetric = metrics?.items.find((m) => m.segment === "HOLDOUT" && m.regime === "ALL");
  const demoMetric = metrics?.items.find((m) => m.segment === "DEMO_FORWARD" && m.regime === "ALL");

  const completedRuns = runs?.items.filter((r) => r.status === "COMPLETED" && r.symbol === symbol) ?? [];

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
      <Text style={styles.title}>Research & Validation</Text>
      <Text style={styles.subtitle}>
        Full validation ladder: walk-forward optimization, untouched holdout, baselines, and demo-forward.
        Statistical evidence is not guaranteed future profitability.
      </Text>

      <Card>
        <Text style={styles.label}>Symbol</Text>
        <View style={styles.row}>
          {SYMBOLS.map((s) => (
            <Pressable key={s} onPress={() => setSymbol(s)} style={[styles.chip, symbol === s && styles.chipActive]}>
              <Text style={styles.chipText}>{s}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.label, { marginTop: spacing.md }]}>Timeframe</Text>
        <View style={styles.row}>
          {(["1m", "5m"] as const).map((tf) => (
            <Pressable key={tf} onPress={() => setInterval(tf)} style={[styles.chip, interval === tf && styles.chipActive]}>
              <Text style={styles.chipText}>{tf}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.label, { marginTop: spacing.md }]}>Strategy</Text>
        <TextInput
          style={styles.input}
          placeholder="Strategy ID (from Strategies tab)"
          placeholderTextColor={colors.textFaint}
          value={strategyId}
          onChangeText={setStrategyId}
        />
        <Pressable
          style={[styles.runBtn, createExperiment.isPending && styles.runBtnDisabled]}
          disabled={createExperiment.isPending}
          onPress={() =>
            void createExperiment.mutateAsync({
              symbol,
              interval,
              from: "2025-01-01T00:00:00.000Z",
              to: "2026-07-01T00:00:00.000Z",
              strategies: strategyId ? [strategyId] : "ALL",
              holdoutPercent: 0.3
            })
          }
        >
          {createExperiment.isPending ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={styles.runBtnText}>Run full experiment</Text>
          )}
        </Pressable>
      </Card>

      {completedRuns.length > 0 ? (
        <Card>
          <Text style={styles.sectionTitle}>Recent experiments</Text>
          {completedRuns.slice(0, 5).map((r) => (
            <Pressable key={r.id} onPress={() => setSelectedRunId(r.id)} style={styles.runRow}>
              <Text style={[styles.runRowText, selectedRunId === r.id && styles.runRowActive]}>
                {r.verdict ?? "—"} · {r.interval} · {r.id.slice(0, 8)}
              </Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {!strategyId && !selectedRunId ? (
        <EmptyState title="Select a strategy or experiment" hint="Run an experiment or paste a strategy ID to view metrics." />
      ) : (
        <>
          {verdictData?.verdict ? (
            <Card>
              <Text style={styles.sectionTitle}>Research Verdict</Text>
              <Text style={styles.verdict}>{verdictData.verdict.replace(/_/g, " ")}</Text>
              <Text style={styles.bigScore}>Confidence: {verdictData.confidence ?? "—"} / 100</Text>
              {(verdictData.reasons ?? []).slice(0, 8).map((r) => (
                <Text key={r} style={styles.reason}>{r}</Text>
              ))}
              {verdictData.summary && typeof verdictData.summary === "object" && "conclusion" in verdictData.summary ? (
                <Text style={styles.conclusion}>{String((verdictData.summary as { conclusion?: string }).conclusion)}</Text>
              ) : null}
            </Card>
          ) : null}

          <Card>
            <Text style={styles.sectionTitle}>Validation Ladder</Text>
            <MetricRow label="Train PF" value={fmtPf(trainMetric?.profitFactor ?? verdictData?.summary)} />
            <MetricRow label="Walk-forward PF" value={fmt(wfMetric?.profitFactor ?? comparison?.comparison.walkForwardProfitFactor)} />
            <MetricRow label="Final holdout PF" value={fmt(holdoutMetric?.profitFactor ?? comparison?.comparison.holdoutProfitFactor)} />
            <MetricRow label="Demo forward PF" value={fmt(demoMetric?.profitFactor ?? comparison?.comparison.demoForwardProfitFactor)} />
            {demoMetric?.evaluationStatus === "PRELIMINARY" || (demoMetric && demoMetric.totalTrades < 100) ? (
              <Text style={styles.hint}>Demo-forward sample: PRELIMINARY — not enough live demo trades yet.</Text>
            ) : null}
          </Card>

          {verdictData?.baselines ? (
            <Card>
              <Text style={styles.sectionTitle}>Baselines</Text>
              <MetricRow label="RegimeX PF" value={fmt(verdictData.baselines.regimeX?.profitFactor)} />
              <MetricRow label="No regime filter PF" value={fmt(verdictData.baselines.noRegimeFilter?.profitFactor)} />
              <MetricRow label="Random median PF" value={fmt(verdictData.baselines.random?.medianProfitFactor)} />
              <MetricRow label="Random 95th pct PF" value={fmt(verdictData.baselines.random?.percentile95)} />
              <MetricRow label="Always CALL PF" value={fmt(verdictData.baselines.alwaysCall?.profitFactor)} />
              <MetricRow label="Always PUT PF" value={fmt(verdictData.baselines.alwaysPut?.profitFactor)} />
              {verdictData.baselines.regimePfImprovementPercent != null ? (
                <Text style={styles.hint}>
                  Regime filtering PF change: {verdictData.baselines.regimePfImprovementPercent.toFixed(1)}%
                </Text>
              ) : null}
            </Card>
          ) : null}

          <Card>
            <Text style={styles.sectionTitle}>Robustness</Text>
            <MetricRow
              label="Parameter stability"
              value={verdictData?.parameterStability?.level ?? wfMetric?.parameterStabilityLevel ?? "UNKNOWN"}
            />
            {verdictData?.degradation?.worstLevel ? (
              <MetricRow label="Performance degradation" value={verdictData.degradation.worstLevel.replace(/_/g, " ")} />
            ) : null}
            {(verdictData?.degradation?.suspiciousPatterns ?? []).map((p) => (
              <Text key={p} style={styles.warning}>{p}</Text>
            ))}
            <MetricRow label="Sample quality" value={wfMetric?.evaluationStatus ?? "—"} />
            {(verdictData?.holdoutEvaluationCount ?? 0) > 1 ? (
              <Text style={styles.warning}>
                Holdout evaluated {verdictData?.holdoutEvaluationCount} times — repeated peeking turns holdout into training data.
              </Text>
            ) : null}
          </Card>

          {selectedStrategy ? (
            <Card>
              <Text style={styles.sectionTitle}>Regime Breakdown</Text>
              {metrics?.items
                .filter((m) => m.regime !== "ALL" && m.segment === "WALK_FORWARD")
                .slice(0, 8)
                .map((m) => (
                  <View key={m.id} style={styles.regimeRow}>
                    <Text style={styles.regimeName}>{m.regime}</Text>
                    <Text style={styles.regimeStat}>
                      {m.totalTrades} trades · WR {(Number(m.winRate) * 100).toFixed(1)}% · PF {fmt(m.profitFactor)} · {m.evaluationStatus}
                    </Text>
                  </View>
                ))}
            </Card>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricRow}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return Number(v).toFixed(2);
}

function fmtPf(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object" && v !== null && "profitFactor" in v) {
    return fmt((v as { profitFactor?: number }).profitFactor);
  }
  return fmt(v as number);
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: font.title, fontWeight: "800" },
  subtitle: { color: colors.textDim, fontSize: font.caption, lineHeight: 18 },
  label: { color: colors.textDim, fontSize: font.caption, fontWeight: "600", marginBottom: spacing.xs },
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: 8, backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.surfaceRaised, borderWidth: 1, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: font.caption },
  input: { color: colors.text, backgroundColor: colors.surface, borderRadius: 8, padding: spacing.md, fontSize: font.body },
  runBtn: { marginTop: spacing.md, backgroundColor: colors.accent, borderRadius: 8, padding: spacing.md, alignItems: "center" },
  runBtnDisabled: { opacity: 0.6 },
  runBtnText: { color: colors.text, fontWeight: "700" },
  sectionTitle: { color: colors.text, fontSize: font.title, fontWeight: "700", marginBottom: spacing.sm },
  verdict: { color: colors.accent, fontSize: 28, fontWeight: "800" },
  bigScore: { color: colors.text, fontSize: font.body, fontWeight: "600", marginTop: 4 },
  status: { color: colors.textDim, fontSize: font.caption, marginTop: 4 },
  hint: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  conclusion: { color: colors.text, fontSize: font.caption, marginTop: spacing.md, lineHeight: 20, fontStyle: "italic" },
  reason: { color: colors.textDim, fontSize: font.caption, marginTop: 2 },
  metricRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  metricLabel: { color: colors.textDim, fontSize: font.body },
  metricValue: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  warning: { color: colors.warning, fontSize: font.caption, marginTop: spacing.sm },
  regimeRow: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  regimeName: { color: colors.text, fontWeight: "600", fontSize: font.caption },
  regimeStat: { color: colors.textDim, fontSize: font.caption, marginTop: 2 },
  runRow: { paddingVertical: 8 },
  runRowText: { color: colors.textDim, fontSize: font.caption },
  runRowActive: { color: colors.accent, fontWeight: "700" }
});
