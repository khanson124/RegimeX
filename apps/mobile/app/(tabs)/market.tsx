import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { ApiError } from "../../src/api/client";
import { useCandles, useDashboard, useDerivAccount, usePlaceManualTrade, useRiskProfile, useStrategies, useSymbols } from "../../src/api/hooks";
import { alertMessage, confirmAsync } from "../../src/lib/confirm";
import { useLiveEvents } from "../../src/ws/useLiveEvents";
import { CandleChart } from "../../src/components/CandleChart";
import { Button, Card, EmptyState, Metric, RegimeBadge, Row, SectionTitle, Skeleton } from "../../src/components/ui";
import { colors, font, spacing } from "../../src/theme";

/** Client-side EMA for chart overlays (display only, not trading logic). */
function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let seed = 0;
  values.forEach((v, i) => {
    if (prev === null) {
      seed += v;
      if (i === period - 1) {
        prev = seed / period;
        out[i] = prev;
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  });
  return out;
}

const INTERVALS = ["1m", "5m"] as const;
const DURATIONS = [
  { label: "1m", duration: 1, unit: "m" as const },
  { label: "5m", duration: 5, unit: "m" as const },
  { label: "15m", duration: 15, unit: "m" as const }
];

export default function MarketScreen() {
  const { data: symbolsData } = useSymbols();
  const [symbol, setSymbol] = useState<string | null>(null);
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>("1m");
  const [durationIdx, setDurationIdx] = useState(1);
  const [manualError, setManualError] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const { data: dashboard } = useDashboard();
  const { data: strategiesData } = useStrategies();
  const { data: derivAccount } = useDerivAccount();
  const { data: riskProfile } = useRiskProfile();
  const placeManual = usePlaceManualTrade();
  const { price, lastEvent } = useLiveEvents();

  const enabledSymbols = symbolsData?.symbols.filter((s) => s.enabled) ?? [];
  const activeSymbol = symbol ?? enabledSymbols[0]?.derivSymbol ?? null;

  const { data: candleData, isLoading, refetch, isRefetching } = useCandles(activeSymbol, interval);
  const candles = candleData?.candles ?? [];

  const overlays = useMemo(() => {
    if (candles.length === 0) return [];
    const closes = candles.map((c) => c.close);
    return [
      { color: colors.accent, values: emaSeries(closes, 9) },
      { color: colors.warning, values: emaSeries(closes, 21) }
    ];
  }, [candles]);

  const lastClose = candles[candles.length - 1]?.close ?? null;
  const displayPrice = price ?? lastClose;
  const s = dashboard?.summary;

  function strategyLabel(strategyId: string | null | undefined): string {
    if (!strategyId) return "None";
    const match = strategiesData?.strategies.find((st) => st.id === strategyId);
    return match?.name ?? strategyId;
  }

  const currentAction = s?.currentSignal?.action ?? null;
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
  const apiReasons = s?.currentSignal?.reasons?.length ? s.currentSignal.reasons : null;
  const explainReasons = signalReasons ?? noTradeReasons ?? apiReasons;
  const explainTitle = signalReasons
    ? "Why the last signal fired"
    : explainReasons
      ? "Why the engine is not trading"
      : null;

  const selectedDuration = DURATIONS[durationIdx] ?? DURATIONS[1]!;
  const stake = riskProfile?.profile?.fixedStake != null ? Number(riskProfile.profile.fixedStake) : 0.5;

  async function confirmManualTrade(direction: "CALL" | "PUT"): Promise<void> {
    if (!activeSymbol) return;
    if (!derivAccount?.account) {
      alertMessage("Deriv not connected", "Connect your demo account in Settings first.");
      return;
    }
    const ok = await confirmAsync(
      `Place manual ${direction}?`,
      `${activeSymbol} · ${selectedDuration.label} · stake $${stake.toFixed(2)} (from risk profile)`,
      "Place trade"
    );
    if (!ok) return;

    setManualError(null);
    placeManual.mutate(
      {
        symbol: activeSymbol,
        direction,
        duration: selectedDuration.duration,
        durationUnit: selectedDuration.unit
      },
      {
        onSuccess: (res) =>
          alertMessage(
            "Trade placed",
            `${res.trade.direction} opened · stake $${res.trade.stake.toFixed(2)} · payout $${res.trade.payout.toFixed(2)}`
          ),
        onError: (err) => setManualError(err instanceof ApiError ? err.message : "Manual trade failed")
      }
    );
  }

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
        <Text style={styles.legend}>EMA 9 (blue) · EMA 21 (amber) — direction is labeled, not color-only</Text>
      </Card>

      <SectionTitle>Regime & scores</SectionTitle>
      <Card>
        <RegimeBadge regime={s?.currentRegime ?? null} confidence={s?.regimeConfidence} />
        <Row style={{ marginTop: spacing.md }}>
          <Metric label="Active strategy" value={strategyLabel(s?.activeStrategy)} />
          <Metric label="Current signal" value={currentSignalLabel} tone={currentSignalTone} />
        </Row>
        {s?.currentSignal?.status && s.currentSignal.status !== "NO_TRADE" ? (
          <Text style={styles.hint}>Status: {s.currentSignal.status.replace(/_/g, " ")}</Text>
        ) : null}
      </Card>

      <SectionTitle>Manual test trade</SectionTitle>
      <Card>
        <Text style={styles.hint}>
          Place a one-off demo {activeSymbol ?? "—"} contract. Uses your risk profile stake and still runs all risk
          checks. Does not require the live engine to be running.
        </Text>
        <Text style={styles.label}>Contract duration</Text>
        <Row style={{ marginBottom: spacing.md }}>
          {DURATIONS.map((d, idx) => (
            <Pressable key={d.label} onPress={() => setDurationIdx(idx)}>
              <Text style={[styles.selector, durationIdx === idx && styles.selectorActive]}>{d.label}</Text>
            </Pressable>
          ))}
        </Row>
        <Row>
          <Button
            title="CALL (up)"
            onPress={() => void confirmManualTrade("CALL")}
            loading={placeManual.isPending}
            disabled={!activeSymbol || !derivAccount?.account}
          />
          <View style={{ width: spacing.sm }} />
          <Button
            title="PUT (down)"
            variant="secondary"
            onPress={() => void confirmManualTrade("PUT")}
            loading={placeManual.isPending}
            disabled={!activeSymbol || !derivAccount?.account}
          />
        </Row>
        {!derivAccount?.account ? (
          <Text style={styles.warn}>Connect Deriv demo account in Settings to enable manual trades.</Text>
        ) : null}
        {manualError ? <Text style={styles.warn}>{manualError}</Text> : null}
      </Card>

      <SectionTitle>Explanation</SectionTitle>
      <Card>
        {explainReasons && explainTitle ? (
          <>
            <Text style={styles.explainTitle}>{explainTitle}</Text>
            {explainReasons.map((r, i) => (
              <Text key={i} style={styles.reason}>• {r}</Text>
            ))}
          </>
        ) : (
          <Text style={styles.reason}>
            Explanations appear here while the live engine runs: regime reasoning, strategy
            selection, and every no-trade decision.
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
    fontWeight: "700",
    overflow: "hidden"
  },
  selectorActive: { color: colors.text, borderColor: colors.accent, backgroundColor: "#12283F" },
  legend: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm },
  label: { color: colors.textDim, fontSize: font.caption, marginBottom: spacing.xs },
  hint: { color: colors.textDim, fontSize: font.caption, marginBottom: spacing.sm, lineHeight: 18 },
  warn: { color: colors.warning, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  explainTitle: { color: colors.text, fontWeight: "700", marginBottom: spacing.sm, fontSize: font.body },
  reason: { color: colors.textDim, fontSize: font.body, marginBottom: 4, lineHeight: 20 }
});
