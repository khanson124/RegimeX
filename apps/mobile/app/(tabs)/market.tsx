import React, { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions } from "react-native";
import { useCandles, useDashboard, useStrategies, useSymbols } from "../../src/api/hooks";
import { useLiveEvents } from "../../src/ws/useLiveEvents";
import { CandleChart } from "../../src/components/CandleChart";
import { Card, EmptyState, Metric, RegimeBadge, Row, SectionTitle, Skeleton } from "../../src/components/ui";
import { colors, font, spacing } from "../../src/theme";

function fmt(n: number | null | undefined, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

const INTERVALS = ["1m", "5m"] as const;

const COMPONENT_LABELS: Record<string, string> = {
  regimeFit: "regime fit",
  expectancy: "expectancy score",
  sampleConfidence: "sample confidence",
  profitFactor: "profit factor",
  researchVerdict: "research verdict",
  forwardValidation: "forward validation",
  forwardPaper: "forward validation",
  drawdownPenalty: "drawdown penalty",
  degradationPenalty: "degradation penalty",
  winRate: "win rate",
  recent: "recent performance",
  bootstrap: "bootstrap score"
};

export default function MarketScreen() {
  const { data: symbolsData } = useSymbols();
  const [symbol, setSymbol] = useState<string | null>(null);
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>("1m");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const { width } = useWindowDimensions();
  const { data: dashboard } = useDashboard();
  const { data: strategiesData } = useStrategies();
  const { price, lastEvent } = useLiveEvents();

  const enabledSymbols = symbolsData?.symbols.filter((s) => s.enabled) ?? [];
  const activeSymbol = symbol ?? enabledSymbols[0]?.derivSymbol ?? null;

  const { data: candleData, isLoading, refetch, isRefetching } = useCandles(activeSymbol, interval);
  const candles = candleData?.candles ?? [];

  const lastClose = candles[candles.length - 1]?.close ?? null;
  const displayPrice = price ?? lastClose;
  const s = dashboard?.summary;
  const proposal = s?.cfdProposal;
  const selection = s?.strategySelection;
  const evidence = selection?.evidence;

  function strategyLabel(strategyId: string | null | undefined): string {
    if (!strategyId) return "None";
    const match = strategiesData?.strategies.find((st) => st.id === strategyId);
    return match?.name ?? strategyId;
  }

  const currentAction = proposal?.action ?? s?.currentSignal?.action ?? null;
  const currentSignalLabel =
    currentAction === "HOLD"
      ? "HOLD"
      : currentAction === "BUY" || currentAction === "SELL"
        ? currentAction
        : "—";
  const currentSignalTone =
    currentAction === "BUY" ? "up" : currentAction === "SELL" ? "down" : "neutral";

  const noTradeReasons =
    lastEvent?.type === "strategy.noTrade" ? ((lastEvent.payload.reasons as string[]) ?? []) : null;
  const signalReasons =
    lastEvent?.type === "strategy.signal" ? ((lastEvent.payload.entryReason as string[]) ?? []) : null;
  const apiReasons = proposal?.reasons?.length
    ? proposal.reasons
    : s?.currentSignal?.reasons?.length
      ? s.currentSignal.reasons
      : null;
  const explainReasons = signalReasons ?? noTradeReasons ?? apiReasons;
  const explainTitle = signalReasons
    ? "Why the last signal fired"
    : explainReasons
      ? "Why the engine is not trading"
      : null;

  const componentEntries = selection?.componentScores
    ? Object.entries(selection.componentScores).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    : [];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <Row style={{ marginBottom: spacing.sm }}>
        {enabledSymbols.map((sym) => (
          <Pressable key={sym.id} onPress={() => setSymbol(sym.derivSymbol)}>
            <Text style={[styles.selector, activeSymbol === sym.derivSymbol && styles.selectorActive]}>
              {sym.derivSymbol}
            </Text>
          </Pressable>
        ))}
      </Row>
      <Row style={{ marginBottom: spacing.md }}>
        {INTERVALS.map((iv) => (
          <Pressable key={iv} onPress={() => setInterval(iv)}>
            <Text style={[styles.selector, interval === iv && styles.selectorActive]}>{iv}</Text>
          </Pressable>
        ))}
      </Row>

      <Card>
        <Row>
          <Metric label={`${activeSymbol ?? "—"} price`} value={displayPrice != null ? String(displayPrice) : "—"} large />
        </Row>
        {isLoading ? (
          <Skeleton height={220} />
        ) : candles.length === 0 ? (
          <EmptyState title="No candles" hint="Download historical data in Settings, or start the live engine to stream candles." />
        ) : (
          <CandleChart candles={candles} width={width - spacing.lg * 4} />
        )}
        <Text style={styles.legend}>Live CFD — BUY / SELL / HOLD with SL, TP, and lot sizing</Text>
      </Card>

      <SectionTitle>Regime & signal</SectionTitle>
      <Card>
        <RegimeBadge regime={s?.currentRegime ?? proposal?.regime ?? null} confidence={s?.regimeConfidence} />
        <Row style={{ marginTop: spacing.md }}>
          <Metric
            label="Strategy"
            value={strategyLabel(proposal?.strategyId ?? selection?.strategyId ?? s?.activeStrategy)}
          />
          <Metric label="Action" value={currentSignalLabel} tone={currentSignalTone} />
        </Row>
        <Row style={{ marginTop: spacing.md }}>
          <Metric label="Selection" value={selection?.selectionMode ?? "—"} />
          <Metric
            label="Score"
            value={selection?.selectionScore != null ? String(selection.selectionScore) : "—"}
          />
        </Row>
        {s?.currentSignal?.status && s.currentSignal.status !== "NO_TRADE" ? (
          <Text style={styles.hint}>Status: {s.currentSignal.status.replace(/_/g, " ")}</Text>
        ) : null}
      </Card>

      <SectionTitle>Why this strategy</SectionTitle>
      <Card>
        {selection?.reasons?.length ? (
          <>
            {selection.reasons.slice(0, 4).map((r, i) => (
              <Text key={i} style={styles.reason}>
                • {r}
              </Text>
            ))}
            {componentEntries.length > 0 ? (
              <>
                <Text style={styles.explainTitle}>Component scores</Text>
                {componentEntries.slice(0, 8).map(([key, val]) => (
                  <Text key={key} style={styles.reason}>
                    {COMPONENT_LABELS[key] ?? key} {val >= 0 ? "+" : ""}
                    {fmt(val, 2)}
                  </Text>
                ))}
              </>
            ) : null}
            <Pressable onPress={() => setEvidenceOpen((o) => !o)} style={{ marginTop: spacing.sm }}>
              <Text style={styles.link}>{evidenceOpen ? "Hide evidence" : "Show evidence"}</Text>
            </Pressable>
            {evidenceOpen ? (
              evidence ? (
                <>
                  <Row style={{ marginTop: spacing.md }}>
                    <Metric label="Verdict" value={evidence.researchVerdict?.replace(/_/g, " ") ?? "—"} />
                    <Metric label="Sample" value={evidence.tradeCount != null ? String(evidence.tradeCount) : "—"} />
                  </Row>
                  <Row style={{ marginTop: spacing.md }}>
                    <Metric label="Expectancy R" value={fmt(evidence.expectancyR, 3)} />
                    <Metric label="Profit factor" value={fmt(evidence.profitFactor, 2)} />
                    <Metric label="Max DD %" value={fmt(evidence.maxDrawdownPercent, 1)} />
                  </Row>
                  <Row style={{ marginTop: spacing.md }}>
                    <Metric
                      label="Forward trades"
                      value={evidence.forwardTradeCount != null ? String(evidence.forwardTradeCount) : "—"}
                    />
                    <Metric label="Fwd E[R]" value={fmt(evidence.recentForwardExpectancyR, 3)} />
                    <Metric
                      label="Degrade %"
                      value={evidence.degradationPercent != null ? fmt(evidence.degradationPercent, 0) : "—"}
                    />
                  </Row>
                </>
              ) : (
                <Text style={styles.hint}>No validated CFD evidence yet — bootstrap / regime-fit selection.</Text>
              )
            ) : null}
          </>
        ) : (
          <Text style={styles.hint}>
            Strategy selection reasons appear when the live engine picks a strategy (BOOTSTRAP or VALIDATED).
          </Text>
        )}
      </Card>

      <SectionTitle>CFD proposal</SectionTitle>
      <Card>
        {proposal && (proposal.action === "BUY" || proposal.action === "SELL") && proposal.entry != null ? (
          <>
            <Row>
              <Metric label="Entry" value={fmt(proposal.entry)} />
              <Metric label="Stop loss" value={fmt(proposal.stopLoss)} />
              <Metric label="Take profit" value={fmt(proposal.takeProfit)} />
            </Row>
            <Row style={{ marginTop: spacing.md }}>
              <Metric label="Stop method" value={proposal.stopMethod ?? "—"} />
              <Metric label="Target method" value={proposal.targetMethod ?? "—"} />
              <Metric label="R:R" value={fmt(proposal.riskRewardRatio, 2)} />
            </Row>
            <Row style={{ marginTop: spacing.md }}>
              <Metric label="Lots" value={fmt(proposal.proposedVolume, 4)} />
              <Metric
                label="Risk $"
                value={proposal.riskAmount != null ? `$${fmt(proposal.riskAmount, 2)}` : "—"}
              />
              <Metric
                label="Risk %"
                value={proposal.riskPercent != null ? `${fmt(proposal.riskPercent, 2)}%` : "—"}
              />
            </Row>
          </>
        ) : (
          <Text style={styles.hint}>
            When the live CFD engine selects a strategy, proposed BUY/SELL levels, sizing, and risk appear
            here. HOLD and no-trade decisions stay in Explanation below.
          </Text>
        )}
      </Card>

      <SectionTitle>Explanation</SectionTitle>
      <Card>
        {explainReasons && explainTitle ? (
          <>
            <Text style={styles.explainTitle}>{explainTitle}</Text>
            {explainReasons.map((r, i) => (
              <Text key={i} style={styles.reason}>
                • {r}
              </Text>
            ))}
          </>
        ) : (
          <Text style={styles.reason}>
            Explanations appear here while the live engine runs: regime reasoning, strategy selection,
            and every no-trade decision.
          </Text>
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  selector: {
    color: colors.textDim,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: font.caption,
    marginRight: 8
  },
  selectorActive: { color: colors.text, borderColor: colors.accent },
  legend: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.sm },
  hint: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.sm },
  explainTitle: { color: colors.text, fontWeight: "600", marginBottom: spacing.sm, marginTop: spacing.md },
  reason: { color: colors.textDim, fontSize: font.caption, marginBottom: 4 },
  link: { color: colors.accent, fontSize: font.caption, fontWeight: "600" },
  warn: { color: colors.danger, marginTop: spacing.sm }
});
