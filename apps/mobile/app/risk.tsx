import React, { useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { ApiError } from "../src/api/client";
import { useRiskProfile, useRiskStatus, useUpdateRiskProfile } from "../src/api/hooks";
import { ErrorView, Skeleton } from "../src/components/ui";
import {
  ChipRow,
  Collapsible,
  PrimaryButton,
  SectionHeader,
  SoftCard,
  StatRow,
  StatTile,
  StatusChip,
  TicketField
} from "../src/components/design";
import { colors, font, spacing } from "../src/theme";

function numField(value: number | null | undefined): string {
  return value != null && Number.isFinite(Number(value)) ? String(Number(value)) : "";
}

function parseOptionalInt(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

function parseOptionalPositive(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

function ToggleRow({
  label,
  hint,
  enabled,
  onChange
}: {
  label: string;
  hint: string;
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={{ flex: 1, paddingRight: spacing.md }}>
        <Text style={styles.toggleLabel}>{label}</Text>
        <Text style={styles.toggleHint}>{hint}</Text>
      </View>
      <Switch
        value={enabled}
        onValueChange={onChange}
        trackColor={{ false: colors.border, true: colors.accent }}
        thumbColor={colors.text}
      />
    </View>
  );
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
  const [lotOverrideOn, setLotOverrideOn] = useState(false);
  const [lotOverride, setLotOverride] = useState("");
  const [slOverrideOn, setSlOverrideOn] = useState(false);
  const [slDistance, setSlDistance] = useState("");
  const [maxTotalOpenRisk, setMaxTotalOpenRisk] = useState("2");
  const [maxConcurrent, setMaxConcurrent] = useState("3");
  const [minRr, setMinRr] = useState("1.5");
  const [sessionStart, setSessionStart] = useState("");
  const [sessionEnd, setSessionEnd] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    const p = data?.profile as Record<string, number | null> | undefined;
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
    const lots = p.volumeOverrideLots != null ? Number(p.volumeOverrideLots) : null;
    setLotOverrideOn(lots != null && lots > 0);
    setLotOverride(lots != null && lots > 0 ? String(lots) : "");
    const dist = p.stopLossDistanceOverride != null ? Number(p.stopLossDistanceOverride) : null;
    setSlOverrideOn(dist != null && dist > 0);
    setSlDistance(dist != null && dist > 0 ? String(dist) : "");
    const openRisk =
      p.maxTotalOpenRiskPercent != null ? Number(p.maxTotalOpenRiskPercent) : null;
    setMaxTotalOpenRisk(openRisk != null && openRisk > 0 ? String(openRisk) : "2");
    const concurrent =
      p.maxConcurrentPositions != null ? Number(p.maxConcurrentPositions) : null;
    setMaxConcurrent(concurrent != null && concurrent > 0 ? String(concurrent) : "3");
    const rr = p.minRiskRewardRatio != null ? Number(p.minRiskRewardRatio) : null;
    setMinRr(rr != null && rr > 0 ? String(rr) : "1.5");
    setSessionStart(numField(p.sessionStartHourUtc));
    setSessionEnd(numField(p.sessionEndHourUtc));
  }, [data?.profile]);

  if (isLoading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.pad}>
        <Skeleton height={120} />
        <Skeleton height={280} />
      </ScrollView>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const s = status.data?.status as Record<string, number | boolean> | undefined;
  const cooldownMins =
    Number.isFinite(Number(cooldown)) && Number(cooldown) > 0
      ? `${(Number(cooldown) / 60).toFixed(Number(cooldown) % 60 === 0 ? 0 : 1)} min`
      : null;

  function save(): void {
    setFormError(null);
    setWarnings([]);
    const lots = lotOverrideOn ? Number(lotOverride) : null;
    const dist = slOverrideOn ? Number(slDistance) : null;
    const totalOpenRisk = Number(maxTotalOpenRisk);
    const concurrent = parseOptionalPositive(maxConcurrent);
    const rr = parseOptionalPositive(minRr);
    const startH = parseOptionalInt(sessionStart);
    const endH = parseOptionalInt(sessionEnd);

    if (lotOverrideOn && (!(lots != null && lots > 0) || !Number.isFinite(lots))) {
      setFormError("Lot override must be a positive number");
      return;
    }
    if (slOverrideOn && (!(dist != null && dist > 0) || !Number.isFinite(dist))) {
      setFormError("Stop distance override must be a positive number");
      return;
    }
    if (!(totalOpenRisk > 0) || !Number.isFinite(totalOpenRisk) || totalOpenRisk > 50) {
      setFormError("Max total open risk must be between 0 and 50%");
      return;
    }
    if (concurrent == null || !(concurrent >= 1) || !Number.isFinite(concurrent) || concurrent > 20) {
      setFormError("Max concurrent CFD positions must be 1–20");
      return;
    }
    if (rr == null || !(rr > 0) || !Number.isFinite(rr) || rr > 20) {
      setFormError("Min risk/reward must be a positive ratio (e.g. 1.5)");
      return;
    }
    if (Number.isNaN(startH) || (startH != null && (startH < 0 || startH > 23))) {
      setFormError("Session start hour must be 0–23 UTC, or blank");
      return;
    }
    if (Number.isNaN(endH) || (endH != null && (endH < 0 || endH > 24))) {
      setFormError("Session end hour must be 0–24 UTC, or blank");
      return;
    }

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
        sessionStartHourUtc: startH,
        sessionEndHourUtc: endH,
        volumeOverrideLots: lotOverrideOn ? lots : null,
        stopLossDistanceOverride: slOverrideOn ? dist : null,
        maxTotalOpenRiskPercent: totalOpenRisk,
        maxConcurrentPositions: Math.trunc(concurrent),
        minRiskRewardRatio: rr
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
      contentContainerStyle={styles.pad}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <SoftCard>
        <ChipRow>
          <StatusChip label="CFD demo only" tone="warning" />
          <StatusChip
            label={s?.emergencyStop ? "Emergency ACTIVE" : "Emergency off"}
            tone={s?.emergencyStop ? "down" : "neutral"}
          />
        </ChipRow>
        <View style={{ height: spacing.md }} />
        <StatRow>
          <StatTile
            label="Today P/L $"
            value={s?.dailyPnl != null ? Number(s.dailyPnl).toFixed(2) : "—"}
            tone={
              Number(s?.dailyPnl) > 0 ? "up" : Number(s?.dailyPnl) < 0 ? "down" : "neutral"
            }
          />
          <StatTile
            label="Opened today"
            value={
              s?.dailyTrades != null
                ? String(s.dailyTrades)
                : s?.todayTrades != null
                  ? String(s.todayTrades)
                  : "—"
            }
          />
          <StatTile
            label="Open now"
            value={
              s?.openPositions != null
                ? String(s.openPositions)
                : s?.openContracts != null
                  ? String(s.openContracts)
                  : "—"
            }
          />
        </StatRow>
      </SoftCard>

      <SectionHeader title="Per-trade risk" />
      <SoftCard>
        <TicketField
          label="Risk per trade"
          value={riskPct}
          onChangeText={setRiskPct}
          hint="% of equity per new entry"
        />
        <ToggleRow
          label="Fixed lot size"
          hint="Off = size from risk % · On = fixed lots"
          enabled={lotOverrideOn}
          onChange={setLotOverrideOn}
        />
        {lotOverrideOn ? (
          <TicketField
            label="Lots"
            value={lotOverride}
            onChangeText={setLotOverride}
            hint="Volume for next entries"
          />
        ) : null}
        <ToggleRow
          label="Stop distance override"
          hint="Off = strategy SL · On = entry ± distance"
          enabled={slOverrideOn}
          onChange={setSlOverrideOn}
        />
        {slOverrideOn ? (
          <TicketField
            label="Stop distance"
            value={slDistance}
            onChangeText={setSlDistance}
            hint="Absolute price units from entry"
          />
        ) : null}
      </SoftCard>

      <SectionHeader title="Position limits" />
      <SoftCard>
        <View style={styles.fieldRow}>
          <TicketField
            label="Max concurrent CFD"
            value={maxConcurrent}
            onChangeText={setMaxConcurrent}
            keyboardType="number-pad"
            hint="Open CFD positions (default 3)"
          />
          <TicketField
            label="Max per day"
            value={maxDailyTrades}
            onChangeText={setMaxDailyTrades}
            keyboardType="number-pad"
            hint="New positions / day"
          />
        </View>
        <TicketField
          label="Max consecutive losses"
          value={maxConsecLosses}
          onChangeText={setMaxConsecLosses}
          keyboardType="number-pad"
          hint="Pause after this streak"
        />
        <TicketField
          label="Max total open risk"
          value={maxTotalOpenRisk}
          onChangeText={setMaxTotalOpenRisk}
          hint="% of equity across all open positions"
        />
        <TicketField
          label="Min risk / reward"
          value={minRr}
          onChangeText={setMinRr}
          hint="Reject new entries below this R:R (e.g. 1.5)"
        />
      </SoftCard>

      <SectionHeader title="Daily loss & drawdown" />
      <SoftCard>
        <View style={styles.fieldRow}>
          <TicketField
            label="Max daily loss"
            value={maxDailyLoss}
            onChangeText={setMaxDailyLoss}
            hint="$ account currency"
          />
          <TicketField
            label="Max drawdown"
            value={maxDrawdown}
            onChangeText={setMaxDrawdown}
            hint="% from peak"
          />
        </View>
        <TicketField
          label="Min equity"
          value={minBalance}
          onChangeText={setMinBalance}
          hint="$ threshold to keep trading"
        />
      </SoftCard>

      <SectionHeader title="Cooldown" />
      <SoftCard>
        <TicketField
          label="Cooldown after loss"
          value={cooldown}
          onChangeText={setCooldown}
          keyboardType="number-pad"
          hint={cooldownMins ? `Seconds (${cooldownMins})` : "Seconds"}
        />
      </SoftCard>

      {formError ? <Text style={styles.error}>{formError}</Text> : null}
      {warnings.map((w) => (
        <Text key={w} style={styles.warning}>
          {w}
        </Text>
      ))}
      <PrimaryButton title="Save risk settings" onPress={save} loading={update.isPending} />

      <Collapsible title="Advanced risk controls">
        <Text style={styles.hint}>
          Session hours use UTC. Leave blank for no session window. Clearing a field and saving removes that bound.
        </Text>
        <View style={styles.fieldRow}>
          <TicketField
            label="Session start (UTC hour)"
            value={sessionStart}
            onChangeText={setSessionStart}
            keyboardType="number-pad"
            hint="0–23 · blank = none"
          />
          <TicketField
            label="Session end (UTC hour)"
            value={sessionEnd}
            onChangeText={setSessionEnd}
            keyboardType="number-pad"
            hint="0–24 · blank = none"
          />
        </View>
        <TicketField
          label="Max simultaneous (legacy binary)"
          value={maxSimultaneous}
          onChangeText={setMaxSimultaneous}
          keyboardType="number-pad"
          hint="Rise/fall contracts — not the CFD concurrent cap above"
        />
      </Collapsible>

      <Collapsible title="Legacy binary stakes">
        <Text style={styles.hint}>
          Unused for CFD sizing — kept for archived rise/fall contracts.
        </Text>
        <View style={styles.fieldRow}>
          <TicketField label="Fixed stake $" value={fixedStake} onChangeText={setFixedStake} />
          <TicketField label="Max stake $" value={maxStake} onChangeText={setMaxStake} />
        </View>
      </Collapsible>

      <Text style={styles.disclaimer}>
        Defaults stay automatic until you enable an override. Live money is blocked.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 56 },
  fieldRow: { flexDirection: "row", gap: spacing.md, flexWrap: "wrap" },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border
  },
  toggleLabel: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  toggleHint: { color: colors.textFaint, fontSize: font.caption, marginTop: 2 },
  hint: { color: colors.textDim, fontSize: font.caption, marginBottom: spacing.md, lineHeight: 18 },
  error: { color: colors.down, fontSize: font.caption, marginBottom: spacing.sm },
  warning: { color: colors.warning, fontSize: font.caption, marginBottom: 4 },
  disclaimer: {
    color: colors.textFaint,
    fontSize: font.micro,
    textAlign: "center",
    marginTop: spacing.xl,
    lineHeight: 16
  }
});
