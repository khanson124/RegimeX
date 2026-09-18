import React, { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError } from "../../src/api/client";
import { useCreateBacktest, useSymbols } from "../../src/api/hooks";
import {
  PrimaryButton,
  SectionHeader,
  SegmentedChips,
  SoftCard,
  TicketField
} from "../../src/components/design";
import { colors, font, spacing } from "../../src/theme";

const INTERVALS = ["1m", "5m", "15m"] as const;
const MODES = ["AUTO", "ENSEMBLE"] as const;

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
    <ScrollView style={styles.container} contentContainerStyle={styles.pad}>
      <SectionHeader title="Symbol" />
      <SoftCard>
        <SegmentedChips
          options={enabledSymbols.map((s) => ({ id: s.derivSymbol, label: s.derivSymbol }))}
          value={activeSymbol}
          onChange={setSymbol}
        />
      </SoftCard>

      <SectionHeader title="Interval & selection" />
      <SoftCard>
        <SegmentedChips
          options={INTERVALS.map((iv) => ({ id: iv, label: iv }))}
          value={interval}
          onChange={(id) => setInterval(id as (typeof INTERVALS)[number])}
        />
        <View style={{ height: spacing.md }} />
        <SegmentedChips
          options={MODES.map((m) => ({ id: m, label: m }))}
          value={mode}
          onChange={(id) => setMode(id as (typeof MODES)[number])}
        />
        <Text style={styles.hint}>
          AUTO picks the best eligible strategy per regime. ENSEMBLE aggregates weighted votes.
        </Text>
      </SoftCard>

      <SectionHeader title="Execution model" />
      <SoftCard>
        <SegmentedChips
          options={[
            { id: "cfd_v1", label: "CFD" },
            { id: "rise_fall_v1", label: "Legacy binary" }
          ]}
          value={executionModel}
          onChange={(id) => setExecutionModel(id as "cfd_v1" | "rise_fall_v1")}
        />
        <Text style={styles.hint}>
          CFD uses SL/TP and lot sizing (live model). Legacy binary is historical comparison only.
        </Text>
      </SoftCard>

      <SectionHeader title="Configuration" />
      <SoftCard>
        <View style={styles.fieldRow}>
          <TicketField label="From" value={from} onChangeText={setFrom} keyboardType="default" />
          <TicketField label="To" value={to} onChangeText={setTo} keyboardType="default" />
        </View>
        <TicketField
          label="Starting balance"
          value={balance}
          onChangeText={setBalance}
        />
        {executionModel === "cfd_v1" ? (
          <View style={styles.fieldRow}>
            <TicketField label="Risk per trade %" value={riskPct} onChangeText={setRiskPct} />
            <TicketField
              label="Max hold bars"
              value={maxHold}
              onChangeText={setMaxHold}
              keyboardType="number-pad"
            />
          </View>
        ) : (
          <View style={styles.fieldRow}>
            <TicketField label="Fixed stake" value={stake} onChangeText={setStake} />
            <TicketField
              label="Duration (candles)"
              value={duration}
              onChangeText={setDuration}
              keyboardType="number-pad"
            />
          </View>
        )}
      </SoftCard>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <PrimaryButton
        title="Run backtest"
        onPress={submit}
        loading={createBacktest.isPending}
        disabled={!activeSymbol}
      />
      <Text style={styles.hint}>
        Final 30% of the range is out-of-sample. Download candles first (Settings → Data management).
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 48 },
  fieldRow: { flexDirection: "row", gap: spacing.md, flexWrap: "wrap" },
  hint: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  error: { color: colors.down, fontSize: font.body, marginBottom: spacing.sm }
});
