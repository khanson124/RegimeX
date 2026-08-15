import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useCandles, useDashboard, useSymbols } from "../../src/api/hooks";
import { useLiveEvents } from "../../src/ws/useLiveEvents";
import { CandleChart } from "../../src/components/CandleChart";
import { Card, EmptyState, Metric, RegimeBadge, Row, SectionTitle, Skeleton } from "../../src/components/ui";
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

export default function MarketScreen() {
  const { data: symbolsData } = useSymbols();
  const [symbol, setSymbol] = useState<string | null>(null);
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>("1m");
  const { width } = useWindowDimensions();
  const { data: dashboard } = useDashboard();
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

  const noTradeReasons =
    lastEvent?.type === "strategy.noTrade" ? ((lastEvent.payload.reasons as string[]) ?? []) : null;
  const signalReasons =
    lastEvent?.type === "strategy.signal" ? ((lastEvent.payload.entryReason as string[]) ?? []) : null;

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
          <Metric label="Active strategy" value={s?.activeStrategy ?? "None"} />
          <Metric
            label="Current signal"
            value={s?.latestSignal ? `${s.latestSignal.action}` : "—"}
            tone={s?.latestSignal?.action === "BUY" ? "up" : s?.latestSignal?.action === "SELL" ? "down" : "neutral"}
          />
        </Row>
      </Card>

      <SectionTitle>Explanation</SectionTitle>
      <Card>
        {signalReasons ? (
          <>
            <Text style={styles.explainTitle}>Why the last signal fired</Text>
            {signalReasons.map((r, i) => (
              <Text key={i} style={styles.reason}>• {r}</Text>
            ))}
          </>
        ) : noTradeReasons ? (
          <>
            <Text style={styles.explainTitle}>Why the engine is not trading</Text>
            {noTradeReasons.map((r, i) => (
              <Text key={i} style={styles.reason}>• {r}</Text>
            ))}
          </>
        ) : (
          <Text style={styles.reason}>
            Explanations appear here in real time while the live engine runs: regime reasoning, strategy
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
  explainTitle: { color: colors.text, fontWeight: "700", marginBottom: spacing.sm, fontSize: font.body },
  reason: { color: colors.textDim, fontSize: font.body, marginBottom: 4, lineHeight: 20 }
});
