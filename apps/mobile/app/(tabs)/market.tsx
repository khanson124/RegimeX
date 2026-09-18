import React, { useEffect, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from "react-native";
import { useRouter } from "expo-router";
import {
  useCandles,
  useDashboard,
  useRiskProfile,
  useStrategies,
  useSymbols,
  useUpdateRiskProfile
} from "../../src/api/hooks";
import { useLiveEvents } from "../../src/ws/useLiveEvents";
import { CandleChart } from "../../src/components/CandleChart";
import { EmptyState, RegimeBadge, Skeleton } from "../../src/components/ui";
import {
  ChipRow,
  Collapsible,
  PrimaryButton,
  SectionHeader,
  SegmentedChips,
  SoftCard,
  StatRow,
  StatTile,
  StatusChip,
  TicketField
} from "../../src/components/design";
import { colors, font, spacing } from "../../src/theme";
import { ApiError } from "../../src/api/client";
import { alertMessage } from "../../src/lib/confirm";

function fmt(n: number | null | undefined, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

const INTERVALS = ["1m", "5m", "15m"] as const;

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
  const { width } = useWindowDimensions();
  const { data: dashboard } = useDashboard();
  const { data: strategiesData } = useStrategies();
  const { data: riskData, refetch: refetchRisk } = useRiskProfile();
  const updateRisk = useUpdateRiskProfile();
  const { price, lastEvent } = useLiveEvents();
  const router = useRouter();

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
  const profile = riskData?.profile as Record<string, number | null | string> | undefined;

  const [riskPct, setRiskPct] = useState("0.5");
  const [lots, setLots] = useState("");
  const [lotsAuto, setLotsAuto] = useState(true);
  const [slDistance, setSlDistance] = useState("");
  const [slAuto, setSlAuto] = useState(true);
  const [ticketMsg, setTicketMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    setRiskPct(String(Number(profile.riskPerTradePercent ?? 0.5)));
    const vol = profile.volumeOverrideLots != null ? Number(profile.volumeOverrideLots) : null;
    setLotsAuto(!(vol != null && vol > 0));
    setLots(vol != null && vol > 0 ? String(vol) : "");
    const dist = profile.stopLossDistanceOverride != null ? Number(profile.stopLossDistanceOverride) : null;
    setSlAuto(!(dist != null && dist > 0));
    setSlDistance(dist != null && dist > 0 ? String(dist) : "");
  }, [profile]);

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

  function saveTicket(): void {
    setTicketMsg(null);
    if (!profile) {
      setTicketMsg("Risk profile not loaded");
      return;
    }
    const pct = Number(riskPct);
    const lotVal = lotsAuto ? null : Number(lots);
    const distVal = slAuto ? null : Number(slDistance);
    if (!(pct > 0) || !Number.isFinite(pct)) {
      setTicketMsg("Risk % must be a positive number");
      return;
    }
    if (!lotsAuto && (!(lotVal != null && lotVal > 0) || !Number.isFinite(lotVal))) {
      setTicketMsg("Lots must be a positive number when override is on");
      return;
    }
    if (!slAuto && (!(distVal != null && distVal > 0) || !Number.isFinite(distVal))) {
      setTicketMsg("Stop distance must be a positive number when override is on");
      return;
    }

    updateRisk.mutate(
      {
        riskPerTradePercent: pct,
        fixedStake: Number(profile.fixedStake ?? 0.5),
        maxStakePerTrade: Number(profile.maxStakePerTrade ?? 1),
        maxDailyLoss: Number(profile.maxDailyLoss ?? 5),
        maxDailyTrades: Number(profile.maxDailyTrades ?? 10),
        maxConsecutiveLosses: Number(profile.maxConsecutiveLosses ?? 3),
        minCooldownSeconds: Number(profile.minCooldownSeconds ?? 120),
        maxSimultaneousContracts: Number(profile.maxSimultaneousContracts ?? 1),
        maxDrawdownPercent: Number(profile.maxDrawdownPercent ?? 10),
        minBalance: Number(profile.minBalance ?? 100),
        // Preserve session / CFD caps — Trade ticket only edits sizing overrides.
        ...(profile.sessionStartHourUtc != null
          ? { sessionStartHourUtc: Number(profile.sessionStartHourUtc) }
          : {}),
        ...(profile.sessionEndHourUtc != null
          ? { sessionEndHourUtc: Number(profile.sessionEndHourUtc) }
          : {}),
        ...(profile.maxTotalOpenRiskPercent != null
          ? { maxTotalOpenRiskPercent: Number(profile.maxTotalOpenRiskPercent) }
          : {}),
        ...(profile.maxConcurrentPositions != null
          ? { maxConcurrentPositions: Number(profile.maxConcurrentPositions) }
          : {}),
        ...(profile.minRiskRewardRatio != null
          ? { minRiskRewardRatio: Number(profile.minRiskRewardRatio) }
          : {}),
        volumeOverrideLots: lotVal,
        stopLossDistanceOverride: distVal
      },
      {
        onSuccess: () => {
          setTicketMsg("Saved — applies to next entries");
          void refetchRisk();
          alertMessage("Trade defaults saved", "Risk %, lots, and stop override updated for new entries.");
        },
        onError: (err) =>
          setTicketMsg(err instanceof ApiError ? err.message : "Failed to save trade defaults")
      }
    );
  }

  const displaySl =
    !slAuto && slDistance && proposal?.entry != null && (currentAction === "BUY" || currentAction === "SELL")
      ? currentAction === "BUY"
        ? Number(proposal.entry) - Number(slDistance)
        : Number(proposal.entry) + Number(slDistance)
      : proposal?.stopLoss;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.pad}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />
      }
    >
      <SegmentedChips
        options={enabledSymbols.map((sym) => ({ id: sym.derivSymbol, label: sym.derivSymbol }))}
        value={activeSymbol}
        onChange={setSymbol}
      />
      <View style={{ height: spacing.sm }} />
      <SegmentedChips
        options={INTERVALS.map((iv) => ({ id: iv, label: iv }))}
        value={interval}
        onChange={(id) => setInterval(id as (typeof INTERVALS)[number])}
      />

      <SectionHeader title="Chart" />
      <SoftCard>
        <Text style={styles.priceLabel}>{activeSymbol ?? "—"}</Text>
        <Text style={styles.priceValue}>{displayPrice != null ? String(displayPrice) : "—"}</Text>
        {isLoading ? (
          <Skeleton height={220} />
        ) : candles.length === 0 ? (
          <EmptyState
            title="No candles"
            hint="Download historical data in Settings, or start the live engine."
          />
        ) : (
          <CandleChart candles={candles} width={Math.min(width - spacing.lg * 4, 880)} />
        )}
      </SoftCard>

      <SectionHeader title="Signal" />
      <SoftCard>
        <RegimeBadge regime={s?.currentRegime ?? proposal?.regime ?? null} confidence={s?.regimeConfidence} />
        <View style={{ height: spacing.md }} />
        <StatRow>
          <StatTile
            label="Strategy"
            value={strategyLabel(proposal?.strategyId ?? selection?.strategyId ?? s?.activeStrategy)}
          />
          <StatTile label="Action" value={currentSignalLabel} tone={currentSignalTone} />
          <StatTile
            label="Score"
            value={selection?.selectionScore != null ? String(selection.selectionScore) : "—"}
          />
        </StatRow>
      </SoftCard>

      <SectionHeader title="Trade ticket" />
      <SoftCard>
        <ChipRow>
          {!lotsAuto ? <StatusChip label={`Lots override ${lots || "—"}`} tone="accent" /> : null}
          {!slAuto ? <StatusChip label={`SL distance ${slDistance || "—"}`} tone="warning" /> : null}
          {lotsAuto && slAuto ? <StatusChip label="Auto sizing · strategy SL" tone="neutral" /> : null}
        </ChipRow>

        {proposal && (proposal.action === "BUY" || proposal.action === "SELL") && proposal.entry != null ? (
          <View style={{ marginTop: spacing.md }}>
            <StatRow>
              <StatTile label="Entry" value={fmt(proposal.entry)} />
              <StatTile label="Stop" value={fmt(displaySl)} />
              <StatTile label="Take profit" value={fmt(proposal.takeProfit)} />
            </StatRow>
            <Text style={styles.hint}>
              R:R {fmt(proposal.riskRewardRatio, 2)} · proposed lots {fmt(proposal.proposedVolume, 4)} · risk $
              {proposal.riskAmount != null ? fmt(proposal.riskAmount, 2) : "—"}
            </Text>
          </View>
        ) : (
          <Text style={styles.hint}>
            Proposed levels appear when the engine selects BUY/SELL. Defaults below still apply to next entries.
          </Text>
        )}

        <View style={styles.ticketGrid}>
          <TicketField label="Risk %" value={riskPct} onChangeText={setRiskPct} hint="% of equity" />
          <TicketField
            label={lotsAuto ? "Lots (auto)" : "Lots (fixed)"}
            value={lotsAuto ? fmt(proposal?.proposedVolume, 4) : lots}
            onChangeText={setLots}
            editable={!lotsAuto}
            hint={lotsAuto ? "Tap Override lots to set" : "Fixed volume for next entries"}
          />
        </View>
        <View style={styles.ticketGrid}>
          <TicketField
            label={slAuto ? "Stop distance (auto)" : "Stop distance"}
            value={
              slAuto
                ? proposal?.entry != null && proposal?.stopLoss != null
                  ? fmt(Math.abs(Number(proposal.entry) - Number(proposal.stopLoss)))
                  : "—"
                : slDistance
            }
            onChangeText={setSlDistance}
            editable={!slAuto}
            hint={slAuto ? "Strategy stop" : "Absolute price units from entry"}
          />
          <TicketField
            label="Take profit"
            value={fmt(proposal?.takeProfit)}
            editable={false}
            hint="Follows strategy (unchanged)"
          />
        </View>

        <View style={styles.ticketActions}>
          <PrimaryButton
            title={lotsAuto ? "Override lots" : "Use auto lots"}
            variant="secondary"
            onPress={() => {
              if (lotsAuto) {
                setLotsAuto(false);
                setLots(proposal?.proposedVolume != null ? String(proposal.proposedVolume) : "0.1");
              } else {
                setLotsAuto(true);
                setLots("");
              }
            }}
          />
          <PrimaryButton
            title={slAuto ? "Override stop" : "Use strategy stop"}
            variant="secondary"
            onPress={() => {
              if (slAuto) {
                setSlAuto(false);
                if (proposal?.entry != null && proposal?.stopLoss != null) {
                  setSlDistance(String(Math.abs(Number(proposal.entry) - Number(proposal.stopLoss))));
                }
              } else {
                setSlAuto(true);
                setSlDistance("");
              }
            }}
          />
        </View>
        <PrimaryButton title="Save trade defaults" onPress={saveTicket} loading={updateRisk.isPending} />
        {ticketMsg ? <Text style={styles.ticketMsg}>{ticketMsg}</Text> : null}
        <Pressable onPress={() => router.push("/risk")}>
          <Text style={styles.link}>Open full risk settings for limits →</Text>
        </Pressable>
      </SoftCard>

      <Collapsible title="Why this strategy" defaultOpen={false}>
        {selection?.reasons?.length ? (
          <>
            {selection.reasons.slice(0, 4).map((r, i) => (
              <Text key={i} style={styles.bullet}>
                • {r}
              </Text>
            ))}
            {componentEntries.slice(0, 6).map(([key, val]) => (
              <Text key={key} style={styles.bullet}>
                {COMPONENT_LABELS[key] ?? key} {val >= 0 ? "+" : ""}
                {fmt(val, 2)}
              </Text>
            ))}
            {evidence ? (
              <Text style={styles.hint}>
                Verdict {evidence.researchVerdict?.replace(/_/g, " ") ?? "—"} · sample{" "}
                {evidence.tradeCount ?? "—"} · E[R] {fmt(evidence.expectancyR, 3)}
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.hint}>Selection reasons appear when the live engine picks a strategy.</Text>
        )}
      </Collapsible>

      <Collapsible title="Explanation" defaultOpen={Boolean(explainReasons)}>
        {explainReasons && explainTitle ? (
          <>
            <Text style={styles.explainTitle}>{explainTitle}</Text>
            {explainReasons.map((r, i) => (
              <Text key={i} style={styles.bullet}>
                • {r}
              </Text>
            ))}
          </>
        ) : (
          <Text style={styles.hint}>
            Regime reasoning, selection, and no-trade decisions appear here while the engine runs.
          </Text>
        )}
      </Collapsible>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 56 },
  priceLabel: { color: colors.textDim, fontSize: font.caption, fontWeight: "600" },
  priceValue: { color: colors.text, fontSize: font.metricLarge, fontWeight: "800", marginBottom: spacing.md },
  hint: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.md, lineHeight: 18 },
  ticketGrid: { flexDirection: "row", gap: spacing.md, marginTop: spacing.md, flexWrap: "wrap" },
  ticketActions: { gap: spacing.xs, marginTop: spacing.sm },
  ticketMsg: { color: colors.accent, fontSize: font.caption, marginTop: spacing.sm, textAlign: "center" },
  link: { color: colors.accent, fontSize: font.caption, fontWeight: "600", textAlign: "center", marginTop: spacing.md },
  bullet: { color: colors.textDim, fontSize: font.caption, marginBottom: 6, lineHeight: 18 },
  explainTitle: { color: colors.text, fontWeight: "600", marginBottom: spacing.sm }
});
