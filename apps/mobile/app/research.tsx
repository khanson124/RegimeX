import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  useForwardComparison,
  useResearchMetrics,
  useResearchRuns,
  useResearchRunDetail,
  useResearchVerdict,
  useStrategies,
  useCreateResearchExperiment,
  type StrategyRow
} from "../src/api/hooks";
import { EmptyState } from "../src/components/ui";
import {
  ChipRow,
  Collapsible,
  InfoRow,
  PrimaryButton,
  SectionHeader,
  SegmentedChips,
  SoftCard,
  StatRow,
  StatTile,
  StatusChip,
  TicketField
} from "../src/components/design";
import { colors, font, spacing } from "../src/theme";

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100"];

type ExecutionModel = "cfd_v1" | "rise_fall_v1";

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

function MetricLines({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <>
      {rows.map((r) => (
        <InfoRow key={r.label} label={r.label} value={r.value} />
      ))}
    </>
  );
}

export default function ResearchScreen() {
  const [symbol, setSymbol] = useState("R_75");
  const [interval, setInterval] = useState<"1m" | "5m">("5m");
  const [strategyId, setStrategyId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [executionModel, setExecutionModel] = useState<ExecutionModel>("cfd_v1");

  const { data: strategies } = useStrategies();
  const { data: runs } = useResearchRuns();
  const { data: metrics } = useResearchMetrics({ symbol, interval, strategyId: strategyId || undefined });
  const { data: comparison } = useForwardComparison({
    symbol,
    interval,
    strategyId: strategyId || undefined
  });
  const { data: verdictData } = useResearchVerdict(selectedRunId);
  const { data: runDetail } = useResearchRunDetail(selectedRunId);
  const createExperiment = useCreateResearchExperiment();

  const selectedStrategy = strategies?.strategies.find((s: StrategyRow) => s.id === strategyId);
  const selectedRun = runs?.items.find((r) => r.id === selectedRunId);
  const runModel = (selectedRun?.executionModel ??
    runDetail?.researchRun.executionModel ??
    executionModel) as ExecutionModel;
  const isCfd = runModel === "cfd_v1";
  const summary = (runDetail?.researchRun.summary ?? verdictData?.summary ?? null) as Record<
    string,
    unknown
  > | null;
  const aggregate = (summary?.aggregate ?? null) as Record<string, number> | null;
  const promotion = (summary?.promotion ?? null) as { eligibility?: string; reasons?: string[] } | null;
  const historicalEvidence = (summary?.historicalEvidence ?? null) as Record<string, unknown> | null;
  const forwardEvidence = (summary?.forwardEvidence ?? null) as Record<string, unknown> | null;

  const wfMetric = metrics?.items.find((m) => m.segment === "WALK_FORWARD" && m.regime === "ALL");
  const trainMetric = metrics?.items.find((m) => m.segment === "TRAIN" && m.regime === "ALL");
  const holdoutMetric = metrics?.items.find((m) => m.segment === "HOLDOUT" && m.regime === "ALL");
  const demoMetric = metrics?.items.find((m) => m.segment === "DEMO_FORWARD" && m.regime === "ALL");
  const paperMetric = metrics?.items.find((m) => m.segment === "PAPER_FORWARD" && m.regime === "ALL");

  const completedRuns =
    runs?.items.filter(
      (r) =>
        r.status === "COMPLETED" &&
        r.symbol === symbol &&
        (!r.executionModel || r.executionModel === executionModel)
    ) ?? [];

  const evidenceStatus =
    verdictData?.verdict?.replace(/_/g, " ") ??
    wfMetric?.evaluationStatus ??
    (selectedRunId || strategyId ? "Pending" : null);
  const sampleSize = aggregate?.totalValidationTrades ?? wfMetric?.totalTrades ?? null;
  const expectancy = isCfd
    ? (aggregate?.medianExpectancyR as number | undefined) ?? wfMetric?.expectancyR
    : null;
  const profitFactor = wfMetric?.profitFactor ?? comparison?.comparison.walkForwardProfitFactor;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.pad}>
      <SoftCard>
        <Text style={styles.lede}>
          Walk-forward, holdout, and forward evidence. CFD uses expectancyR / net P&amp;L — not binary win rates.
        </Text>
        <SectionHeader title="Execution model" />
        <SegmentedChips
          options={[
            { id: "cfd_v1", label: "CFD" },
            { id: "rise_fall_v1", label: "Legacy binary" }
          ]}
          value={executionModel}
          onChange={(id) => setExecutionModel(id as ExecutionModel)}
        />
        <Text style={styles.hint}>
          {executionModel === "cfd_v1"
            ? "Lots, SL/TP, spread/slippage, netR metrics."
            : "Fixed stake & payout — historical comparison only."}
        </Text>

        <SectionHeader title="Symbol" />
        <SegmentedChips
          options={SYMBOLS.map((s) => ({ id: s, label: s }))}
          value={symbol}
          onChange={setSymbol}
        />
        <SectionHeader title="Timeframe" />
        <SegmentedChips
          options={[
            { id: "1m", label: "1m" },
            { id: "5m", label: "5m" }
          ]}
          value={interval}
          onChange={(id) => setInterval(id as "1m" | "5m")}
        />
        <View style={{ height: spacing.md }} />
        <TicketField
          label="Strategy ID"
          value={strategyId}
          onChangeText={setStrategyId}
          keyboardType="default"
          hint="From Strategies tab — leave blank to run all"
        />
        <PrimaryButton
          title={
            createExperiment.isPending
              ? "Queuing…"
              : `Run ${executionModel === "cfd_v1" ? "CFD" : "binary"} experiment`
          }
          disabled={createExperiment.isPending}
          loading={createExperiment.isPending}
          onPress={() =>
            void createExperiment.mutateAsync({
              symbol,
              interval,
              from: "2025-01-01T00:00:00.000Z",
              to: "2026-07-01T00:00:00.000Z",
              strategies: strategyId ? [strategyId] : "ALL",
              holdoutPercent: 0.3,
              executionModel
            })
          }
        />
      </SoftCard>

      {completedRuns.length > 0 ? (
        <>
          <SectionHeader title="Recent experiments" />
          <SoftCard>
            {completedRuns.slice(0, 5).map((r) => (
              <Pressable
                key={r.id}
                onPress={() => setSelectedRunId(r.id)}
                style={[styles.runRow, selectedRunId === r.id && styles.runRowActive]}
              >
                <Text style={[styles.runRowText, selectedRunId === r.id && styles.runRowTextActive]}>
                  {(r.verdict ?? "—").replace(/_/g, " ")} · {r.interval} · {r.id.slice(0, 8)}
                </Text>
              </Pressable>
            ))}
          </SoftCard>
        </>
      ) : null}

      {!strategyId && !selectedRunId ? (
        <EmptyState
          title="Select a strategy or experiment"
          hint="Run an experiment or paste a strategy ID to view metrics."
        />
      ) : (
        <>
          <SectionHeader title="Evidence snapshot" />
          <SoftCard>
            <ChipRow>
              {evidenceStatus ? (
                <StatusChip label={String(evidenceStatus)} tone="accent" />
              ) : null}
              <StatusChip label={isCfd ? "CFD" : "Binary"} tone="neutral" />
              {promotion?.eligibility ? (
                <StatusChip
                  label={`Promotion ${promotion.eligibility}`}
                  tone={promotion.eligibility === "ELIGIBLE" ? "up" : "warning"}
                />
              ) : null}
            </ChipRow>
            <View style={{ height: spacing.md }} />
            <StatRow>
              <StatTile label="Sample" value={sampleSize != null ? String(sampleSize) : "—"} />
              <StatTile
                label={isCfd ? "E[R]" : "PF"}
                value={isCfd ? fmt(expectancy) : fmt(profitFactor)}
                tone={
                  isCfd
                    ? Number(expectancy) > 0
                      ? "up"
                      : Number(expectancy) < 0
                        ? "down"
                        : "neutral"
                    : Number(profitFactor) >= 1
                      ? "up"
                      : "down"
                }
              />
              <StatTile
                label="Confidence"
                value={verdictData?.confidence != null ? String(verdictData.confidence) : "—"}
              />
            </StatRow>
            {verdictData?.verdict ? (
              <Text style={styles.verdict}>{verdictData.verdict.replace(/_/g, " ")}</Text>
            ) : null}
            {(verdictData?.reasons ?? []).slice(0, 3).map((r) => (
              <Text key={r} style={styles.reason}>
                {r}
              </Text>
            ))}
            {(verdictData?.reasons?.length ?? 0) > 3 ||
            (verdictData?.summary &&
              typeof verdictData.summary === "object" &&
              "conclusion" in verdictData.summary) ? (
              <Collapsible title="Verdict details" inline>
                {(verdictData?.reasons ?? []).slice(3).map((r) => (
                  <Text key={r} style={styles.reason}>
                    {r}
                  </Text>
                ))}
                {verdictData?.summary &&
                typeof verdictData.summary === "object" &&
                "conclusion" in verdictData.summary ? (
                  <Text style={styles.conclusion}>
                    {String((verdictData.summary as { conclusion?: string }).conclusion)}
                  </Text>
                ) : null}
              </Collapsible>
            ) : null}
          </SoftCard>

          {isCfd && aggregate ? (
            <>
              <SectionHeader title="Walk-forward aggregates" />
              <SoftCard>
                <StatRow>
                  <StatTile label="Windows" value={String(aggregate.windowCount ?? "—")} />
                  <StatTile
                    label="Profitable %"
                    value={
                      aggregate.percentProfitableWindows != null
                        ? `${(Number(aggregate.percentProfitableWindows) * 100).toFixed(0)}%`
                        : "—"
                    }
                  />
                  <StatTile label="Median E[R]" value={fmt(aggregate.medianExpectancyR as number)} />
                </StatRow>
                <Collapsible title="More aggregates" inline>
                  <MetricLines
                    rows={[
                      {
                        label: "Positive E[R] windows %",
                        value:
                          aggregate.percentPositiveExpectancyWindows != null
                            ? `${(Number(aggregate.percentPositiveExpectancyWindows) * 100).toFixed(0)}%`
                            : "—"
                      },
                      {
                        label: "Weighted OOS E[R]",
                        value: fmt(aggregate.weightedExpectancyR as number)
                      },
                      {
                        label: "E[R] variability",
                        value: fmt(aggregate.expectancyRVariability as number)
                      },
                      {
                        label: "Param stability",
                        value:
                          runDetail?.researchRun.parameterStability?.level ??
                          verdictData?.parameterStability?.level ??
                          "—"
                      }
                    ]}
                  />
                </Collapsible>
              </SoftCard>
            </>
          ) : null}

          {isCfd ? (
            <Collapsible title="Historical vs forward">
              <MetricLines
                rows={[
                  {
                    label: "Historical median E[R]",
                    value: fmt(historicalEvidence?.medianExpectancyR as number | undefined)
                  },
                  {
                    label: "Forward-paper E[R]",
                    value: fmt(forwardEvidence?.expectancyR as number | undefined)
                  },
                  {
                    label: "Forward-paper trades",
                    value: forwardEvidence?.trades != null ? String(forwardEvidence.trades) : "—"
                  }
                ]}
              />
              <Text style={styles.hint}>Broker-demo forward is a third lane when available — never blended.</Text>
            </Collapsible>
          ) : null}

          {isCfd && (runDetail?.windows?.length ?? 0) > 0 ? (
            <Collapsible title={`Walk-forward windows (${runDetail!.windows.length})`}>
              {runDetail!.windows.map((w) => {
                const val = w.testSummary as {
                  expectancyR?: number;
                  profitFactor?: number | null;
                  totalTrades?: number;
                  maxDrawdownPercent?: number;
                } | null;
                const train = w.trainSummary as { expectancyR?: number; totalTrades?: number } | null;
                return (
                  <View key={w.windowIndex} style={styles.regimeRow}>
                    <Text style={styles.regimeName}>Window {w.windowIndex}</Text>
                    <Text style={styles.regimeStat}>
                      train E[R] {fmt(train?.expectancyR)} ({train?.totalTrades ?? 0}) · val E[R]{" "}
                      {fmt(val?.expectancyR)} · PF {fmt(val?.profitFactor ?? undefined)} · DD{" "}
                      {fmt(val?.maxDrawdownPercent)}%
                    </Text>
                  </View>
                );
              })}
            </Collapsible>
          ) : null}

          <SectionHeader title={isCfd ? "CFD validation ladder" : "Binary validation ladder"} />
          <SoftCard>
            {isCfd ? (
              <MetricLines
                rows={[
                  { label: "Train E[R]", value: fmt(trainMetric?.expectancyR) },
                  { label: "Walk-forward E[R]", value: fmt(wfMetric?.expectancyR) },
                  { label: "Holdout E[R]", value: fmt(holdoutMetric?.expectancyR) },
                  {
                    label: "Walk-forward PF",
                    value: fmt(wfMetric?.profitFactor ?? comparison?.comparison.walkForwardProfitFactor)
                  },
                  {
                    label: "Holdout PF",
                    value: fmt(holdoutMetric?.profitFactor ?? comparison?.comparison.holdoutProfitFactor)
                  },
                  {
                    label: "Max DD %",
                    value: fmt(wfMetric?.maxDrawdownPercent ?? holdoutMetric?.maxDrawdownPercent)
                  },
                  {
                    label: "Paper-forward E[R]",
                    value: fmt(paperMetric?.expectancyR ?? paperMetric?.averageR)
                  },
                  {
                    label: "Paper-forward trades",
                    value: paperMetric?.totalTrades != null ? String(paperMetric.totalTrades) : "—"
                  }
                ]}
              />
            ) : (
              <>
                <MetricLines
                  rows={[
                    { label: "Train PF", value: fmtPf(trainMetric?.profitFactor ?? verdictData?.summary) },
                    {
                      label: "Walk-forward PF",
                      value: fmt(wfMetric?.profitFactor ?? comparison?.comparison.walkForwardProfitFactor)
                    },
                    {
                      label: "Holdout PF",
                      value: fmt(holdoutMetric?.profitFactor ?? comparison?.comparison.holdoutProfitFactor)
                    },
                    {
                      label: "Demo forward PF",
                      value: fmt(demoMetric?.profitFactor ?? comparison?.comparison.demoForwardProfitFactor)
                    }
                  ]}
                />
                {demoMetric?.evaluationStatus === "PRELIMINARY" ||
                (demoMetric && demoMetric.totalTrades < 100) ? (
                  <Text style={styles.hint}>Demo-forward sample: PRELIMINARY.</Text>
                ) : null}
              </>
            )}
          </SoftCard>

          {verdictData?.baselines ? (
            <Collapsible title="Baselines">
              {isCfd ? (
                <MetricLines
                  rows={[
                    { label: "RegimeX PF", value: fmt(verdictData.baselines.regimeX?.profitFactor) },
                    { label: "RegimeX E[R]", value: fmt(verdictData.baselines.regimeX?.expectancyR) },
                    {
                      label: "Always LONG PF",
                      value: fmt(verdictData.baselines.alwaysLong?.profitFactor)
                    },
                    {
                      label: "Always SHORT PF",
                      value: fmt(verdictData.baselines.alwaysShort?.profitFactor)
                    },
                    {
                      label: "Random median E[R]",
                      value: fmt(verdictData.baselines.randomDirection?.medianExpectancyR)
                    }
                  ]}
                />
              ) : (
                <MetricLines
                  rows={[
                    { label: "RegimeX PF", value: fmt(verdictData.baselines.regimeX?.profitFactor) },
                    {
                      label: "No regime filter PF",
                      value: fmt(verdictData.baselines.noRegimeFilter?.profitFactor)
                    },
                    {
                      label: "Random median PF",
                      value: fmt(verdictData.baselines.random?.medianProfitFactor)
                    },
                    {
                      label: "Always CALL PF",
                      value: fmt(verdictData.baselines.alwaysCall?.profitFactor)
                    },
                    {
                      label: "Always PUT PF",
                      value: fmt(verdictData.baselines.alwaysPut?.profitFactor)
                    }
                  ]}
                />
              )}
            </Collapsible>
          ) : null}

          <Collapsible title="Robustness">
            <MetricLines
              rows={[
                {
                  label: "Parameter stability",
                  value:
                    verdictData?.parameterStability?.level ??
                    wfMetric?.parameterStabilityLevel ??
                    "UNKNOWN"
                },
                {
                  label: "Degradation",
                  value: verdictData?.degradation?.worstLevel?.replace(/_/g, " ") ?? "—"
                },
                { label: "Sample quality", value: wfMetric?.evaluationStatus ?? "—" }
              ]}
            />
            {(verdictData?.degradation?.suspiciousPatterns ?? []).map((p) => (
              <Text key={p} style={styles.warning}>
                {p}
              </Text>
            ))}
            {(verdictData?.holdoutEvaluationCount ?? 0) > 1 ? (
              <Text style={styles.warning}>
                Holdout evaluated {verdictData?.holdoutEvaluationCount} times — repeated peeking risk.
              </Text>
            ) : null}
          </Collapsible>

          {selectedStrategy ? (
            <Collapsible title="Regime breakdown">
              {metrics?.items
                .filter((m) => m.regime !== "ALL" && m.segment === "WALK_FORWARD")
                .slice(0, 8)
                .map((m) => (
                  <View key={m.id} style={styles.regimeRow}>
                    <Text style={styles.regimeName}>{m.regime}</Text>
                    <Text style={styles.regimeStat}>
                      {isCfd
                        ? `${m.totalTrades} trades · E[R] ${fmt(m.expectancyR)} · PF ${fmt(m.profitFactor)} · ${m.evaluationStatus}`
                        : `${m.totalTrades} trades · WR ${(Number(m.winRate) * 100).toFixed(1)}% · PF ${fmt(m.profitFactor)}`}
                    </Text>
                  </View>
                ))}
            </Collapsible>
          ) : null}
        </>
      )}

      {createExperiment.isPending ? (
        <View style={styles.pending}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 56 },
  lede: { color: colors.textDim, fontSize: font.caption, lineHeight: 18, marginBottom: spacing.sm },
  hint: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  runRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  runRowActive: { backgroundColor: colors.accentSoft, marginHorizontal: -spacing.sm, paddingHorizontal: spacing.sm, borderRadius: 8 },
  runRowText: { color: colors.textDim, fontSize: font.caption },
  runRowTextActive: { color: colors.text, fontWeight: "700" },
  verdict: { color: colors.accent, fontSize: font.title, fontWeight: "800", marginTop: spacing.md },
  reason: { color: colors.textDim, fontSize: font.caption, marginTop: 4, lineHeight: 17 },
  conclusion: { color: colors.text, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 20, fontStyle: "italic" },
  warning: { color: colors.warning, fontSize: font.caption, marginTop: spacing.sm },
  regimeRow: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  regimeName: { color: colors.text, fontWeight: "600", fontSize: font.caption },
  regimeStat: { color: colors.textDim, fontSize: font.caption, marginTop: 2 },
  pending: { padding: spacing.lg, alignItems: "center" }
});
