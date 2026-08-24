import React, { useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { ApiError } from "../src/api/client";
import { useRiskProfile, useRiskStatus, useUpdateRiskProfile } from "../src/api/hooks";
import { Button, Card, ErrorView, Input, KeyValue, Metric, Row, SectionTitle, Skeleton } from "../src/components/ui";
import { colors, font, spacing } from "../src/theme";

function numField(value: number | undefined): string {
  return value != null ? String(value) : "";
}

export default function RiskScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useRiskProfile();
  const status = useRiskStatus();
  const update = useUpdateRiskProfile();

  const [riskPct, setRiskPct] = useState("0.5");
  const [fixedStake, setFixedStake] = useState("0.5");
  const [maxStake, setMaxStake] = useState("1");
  const [maxDailyLoss, setMaxDailyLoss] = useState("5");
  const [maxDailyTrades, setMaxDailyTrades] = useState("10");
  const [maxConsecLosses, setMaxConsecLosses] = useState("3");
  const [cooldown, setCooldown] = useState("120");
  const [maxSimultaneous, setMaxSimultaneous] = useState("1");
  const [maxDrawdown, setMaxDrawdown] = useState("10");
  const [minBalance, setMinBalance] = useState("100");
  const [formError, setFormError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    const p = data?.profile as Record<string, number> | undefined;
    if (!p) return;
    setRiskPct(numField(Number(p.riskPerTradePercent ?? 0.5)));
    setFixedStake(numField(p.fixedStake));
    setMaxStake(numField(p.maxStakePerTrade));
    setMaxDailyLoss(numField(p.maxDailyLoss));
    setMaxDailyTrades(numField(p.maxDailyTrades));
    setMaxConsecLosses(numField(p.maxConsecutiveLosses));
    setCooldown(numField(p.minCooldownSeconds));
    setMaxSimultaneous(numField(p.maxSimultaneousContracts));
    setMaxDrawdown(numField(p.maxDrawdownPercent));
    setMinBalance(numField(p.minBalance));
  }, [data?.profile]);

  if (isLoading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <Skeleton height={120} />
        <Skeleton height={280} />
      </ScrollView>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const s = status.data?.status as Record<string, number | boolean> | undefined;

  function save(): void {
    setFormError(null);
    setWarnings([]);
    update.mutate(
      {
        riskPerTradePercent: Number(riskPct),
        fixedStake: Number(fixedStake),
        maxStakePerTrade: Number(maxStake),
        maxDailyLoss: Number(maxDailyLoss),
        maxDailyTrades: Number(maxDailyTrades),
        maxConsecutiveLosses: Number(maxConsecLosses),
        minCooldownSeconds: Number(cooldown),
        maxSimultaneousContracts: Number(maxSimultaneous),
        maxDrawdownPercent: Number(maxDrawdown),
        minBalance: Number(minBalance),
        sessionStartHourUtc: null,
        sessionEndHourUtc: null
      },
      {
        onSuccess: (res) => setWarnings(res.warnings ?? []),
        onError: (err) => setFormError(err instanceof ApiError ? err.message : "Failed to save")
      }
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <Card>
        <Text style={styles.badge}>CFD demo only — live-money trading is blocked</Text>
        <Row>
          <Metric label="Today P/L" value={s?.dailyPnl != null ? Number(s.dailyPnl).toFixed(2) : "—"} />
          <Metric
            label="Opened today"
            value={s?.dailyTrades != null ? String(s.dailyTrades) : s?.todayTrades != null ? String(s.todayTrades) : "—"}
          />
          <Metric
            label="Consec. losses"
            value={s?.consecutiveLosses != null ? String(s.consecutiveLosses) : "—"}
            tone={Number(s?.consecutiveLosses) >= 2 ? "warning" : "neutral"}
          />
        </Row>
        <KeyValue
          k="Open positions"
          v={s?.openPositions != null ? String(s.openPositions) : s?.openContracts != null ? String(s.openContracts) : "—"}
        />
        <KeyValue k="Emergency stop" v={s?.emergencyStop ? "ACTIVE" : "Off"} />
      </Card>

      <SectionTitle>CFD risk</SectionTitle>
      <Card>
        <Text style={styles.hint}>
          Lot size is derived from this percent of equity, stop distance, and instrument metadata — not a fixed stake.
        </Text>
        <Input
          label="Risk per trade (% of equity)"
          value={riskPct}
          onChangeText={setRiskPct}
          keyboardType="decimal-pad"
        />
        <Input label="Max daily loss" value={maxDailyLoss} onChangeText={setMaxDailyLoss} keyboardType="decimal-pad" />
        <Input label="Max positions per day" value={maxDailyTrades} onChangeText={setMaxDailyTrades} keyboardType="number-pad" />
        <Input
          label="Max consecutive losses"
          value={maxConsecLosses}
          onChangeText={setMaxConsecLosses}
          keyboardType="number-pad"
        />
        <Input label="Cooldown (seconds)" value={cooldown} onChangeText={setCooldown} keyboardType="number-pad" />
        <Input
          label="Max simultaneous positions"
          value={maxSimultaneous}
          onChangeText={setMaxSimultaneous}
          keyboardType="number-pad"
        />
        <Input label="Max drawdown %" value={maxDrawdown} onChangeText={setMaxDrawdown} keyboardType="decimal-pad" />
        <Input label="Min equity threshold" value={minBalance} onChangeText={setMinBalance} keyboardType="decimal-pad" />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        {warnings.map((w) => (
          <Text key={w} style={styles.warning}>
            ⚠ {w}
          </Text>
        ))}
        <Button title="Save risk profile" onPress={save} loading={update.isPending} />
      </Card>

      <SectionTitle>Legacy binary (unused for CFD)</SectionTitle>
      <Card>
        <Text style={styles.hint}>
          Fixed stake fields remain for archived rise/fall contracts. CFD sizing ignores them.
        </Text>
        <Input label="Fixed stake (per trade)" value={fixedStake} onChangeText={setFixedStake} keyboardType="decimal-pad" />
        <Input label="Max stake per trade" value={maxStake} onChangeText={setMaxStake} keyboardType="decimal-pad" />
      </Card>

      <Text style={styles.disclaimer}>
            Conservative defaults are intentional. CFD uses percent-of-equity risk, not Martingale or recovery staking.
            Backtest and live results are experimental — no profitability is guaranteed.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  badge: { color: colors.warning, fontSize: font.caption, marginBottom: spacing.sm },
  hint: { color: colors.textDim, fontSize: font.caption, marginBottom: spacing.sm, lineHeight: 18 },
  error: { color: colors.down, fontSize: font.caption, marginBottom: spacing.sm },
  warning: { color: colors.warning, fontSize: font.caption, marginBottom: 4 },
  disclaimer: { color: colors.textFaint, fontSize: font.caption, textAlign: "center", marginTop: spacing.lg, lineHeight: 18 }
});
