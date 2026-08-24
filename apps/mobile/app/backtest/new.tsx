import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { ApiError } from "../../src/api/client";
import { useCreateBacktest, useSymbols } from "../../src/api/hooks";
import { Button, Card, Input, Row, SectionTitle } from "../../src/components/ui";
import { colors, font, spacing } from "../../src/theme";

const INTERVALS = ["1m", "5m"] as const;
const MODES = ["AUTO", "ENSEMBLE"] as const;
const EXEC_MODELS = [
  { value: "cfd_v1" as const, label: "CFD (cfd_v1)" },
  { value: "rise_fall_v1" as const, label: "Legacy binary" }
];

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export default function NewBacktestScreen() {
  const { data: symbolsData } = useSymbols();
  const createBacktest = useCreateBacktest();
  const router = useRouter();

  const enabledSymbols = symbolsData?.symbols.filter((s) => s.enabled) ?? [];
  const [symbol, setSymbol] = useState<string | null>(null);
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>("1m");
  const [mode, setMode] = useState<(typeof MODES)[number]>("AUTO");
  const [executionModel, setExecutionModel] = useState<"cfd_v1" | "rise_fall_v1">("cfd_v1");
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [stake, setStake] = useState("1");
  const [balance, setBalance] = useState("10000");
  const [duration, setDuration] = useState("5");
  const [riskPct, setRiskPct] = useState("0.5");
  const [maxHold, setMaxHold] = useState("60");
  const [error, setError] = useState<string | null>(null);

  const activeSymbol = symbol ?? enabledSymbols[0]?.derivSymbol ?? null;

  function submit(): void {
    setError(null);
    if (!activeSymbol) {
      setError("Select a symbol first");
      return;
    }
    createBacktest.mutate(
      {
        symbol: activeSymbol,
        interval,
        from,
        to,
        startingBalance: Number(balance),
        stakeType: "FIXED",
        stakeAmount: Number(stake),
        selectionMode: mode,
        contractDurationCandles: Number(duration),
        executionModel,
        riskPerTradePercent: Number(riskPct),
        maxHoldBars: Number(maxHold),
        testSplit: 0.3
      },
      {
        onSuccess: () => router.back(),
        onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to create backtest")
      }
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}>
      <SectionTitle>Symbol</SectionTitle>
      <Row style={{ marginBottom: spacing.sm }}>
        {enabledSymbols.map((sym) => (
          <Pressable key={sym.id} onPress={() => setSymbol(sym.derivSymbol)}>
            <Text style={[styles.selector, activeSymbol === sym.derivSymbol && styles.selectorActive]}>
              {sym.derivSymbol}
            </Text>
          </Pressable>
        ))}
      </Row>

      <SectionTitle>Interval & selection mode</SectionTitle>
      <Row style={{ marginBottom: spacing.sm }}>
        {INTERVALS.map((iv) => (
          <Pressable key={iv} onPress={() => setInterval(iv)}>
            <Text style={[styles.selector, interval === iv && styles.selectorActive]}>{iv}</Text>
          </Pressable>
        ))}
        {MODES.map((m) => (
          <Pressable key={m} onPress={() => setMode(m)}>
            <Text style={[styles.selector, mode === m && styles.selectorActive]}>{m}</Text>
          </Pressable>
        ))}
      </Row>
      <Text style={styles.hint}>
        AUTO picks the best eligible strategy per regime, candle by candle. ENSEMBLE aggregates weighted votes.
      </Text>

      <SectionTitle>Execution model</SectionTitle>
      <Row style={{ marginBottom: spacing.sm }}>
        {EXEC_MODELS.map((m) => (
          <Pressable key={m.value} onPress={() => setExecutionModel(m.value)}>
            <Text style={[styles.selector, executionModel === m.value && styles.selectorActive]}>{m.label}</Text>
          </Pressable>
        ))}
      </Row>
      <Text style={styles.hint}>
        CFD uses SL/TP, lot sizing, and variable hold time (cfd_v1). Requires verified InstrumentMetadata.
      </Text>

      <SectionTitle>Configuration</SectionTitle>
      <Card>
        <Input label="From (YYYY-MM-DD)" value={from} onChangeText={setFrom} placeholder="2026-06-01" />
        <Input label="To (YYYY-MM-DD)" value={to} onChangeText={setTo} placeholder="2026-07-01" />
        <Input label="Starting balance" value={balance} onChangeText={setBalance} keyboardType="numeric" />
        {executionModel === "cfd_v1" ? (
          <>
            <Input label="Risk per trade (%)" value={riskPct} onChangeText={setRiskPct} keyboardType="numeric" />
            <Input label="Max hold (bars)" value={maxHold} onChangeText={setMaxHold} keyboardType="numeric" />
          </>
        ) : (
          <>
            <Input label="Fixed stake per trade" value={stake} onChangeText={setStake} keyboardType="numeric" />
            <Input label="Contract duration (candles)" value={duration} onChangeText={setDuration} keyboardType="numeric" />
          </>
        )}
      </Card>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button title="Run backtest" onPress={submit} loading={createBacktest.isPending} disabled={!activeSymbol} />
      <Text style={styles.hint}>
        The final 30% of the range is reserved as out-of-sample test data. Make sure historical candles are
        downloaded for this range first (Settings → Market data).
      </Text>
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
  hint: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  error: { color: colors.down, fontSize: font.body, marginBottom: spacing.sm }
});
