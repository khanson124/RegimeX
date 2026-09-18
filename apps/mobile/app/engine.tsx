import React, { useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { ApiError } from "../src/api/client";
import {
  useConfigureEngine,
  useEngine,
  useEngineAction,
  useMt5Status,
  useStrategies,
  useSymbols
} from "../src/api/hooks";
import { ErrorView, Skeleton } from "../src/components/ui";
import {
  ChipRow,
  Collapsible,
  PrimaryButton,
  SectionHeader,
  SegmentedChips,
  SoftCard,
  StatusChip,
  TicketField
} from "../src/components/design";
import { colors, font, spacing } from "../src/theme";

const INTERVALS = ["1m", "5m", "15m"] as const;
const MODES = [
  { value: "ANALYSIS_ONLY", label: "Analysis only" },
  { value: "DEMO_TRADING", label: "CFD demo" },
  { value: "LIVE_TRADING", label: "CFD live" }
] as const;
const SELECTION_MODES = [
  { id: "AUTO", label: "Auto" },
  { id: "SINGLE", label: "Single" },
  { id: "ENSEMBLE", label: "Ensemble" }
] as const;

function stateTone(state: string): "up" | "down" | "warning" | "neutral" | "accent" {
  if (state.startsWith("RUNNING")) return "up";
  if (state === "EMERGENCY_STOPPED" || state === "ERROR") return "down";
  if (state === "PAUSED" || state === "DEGRADED") return "warning";
  return "neutral";
}

function stateLabel(state: string): string {
  if (state.startsWith("RUNNING")) return "Running";
  if (state === "PAUSED") return "Paused";
  if (state === "STOPPED") return "Stopped";
  if (state === "EMERGENCY_STOPPED") return "Emergency stopped";
  return state.replace(/_/g, " ");
}

export default function EngineScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useEngine();
  const { data: symbolsData } = useSymbols();
  const { data: strategiesData } = useStrategies();
  const { data: mt5Data } = useMt5Status();
  const action = useEngineAction();
  const configure = useConfigureEngine();

  const [symbol, setSymbol] = useState<string | null>(null);
  const [interval, setInterval] = useState<(typeof INTERVALS)[number] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState<"AUTO" | "SINGLE" | "ENSEMBLE" | null>(null);
  const [fixedStrategyId, setFixedStrategyId] = useState<string | null>(null);
  const [resumeAfterRestart, setResumeAfterRestart] = useState<boolean | null>(null);
  const [advancedHydrated, setAdvancedHydrated] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const engine = data?.engine ?? null;
  const config = (engine?.configuration ?? {}) as Record<string, string | boolean | null>;

  useEffect(() => {
    if (!engine?.configuration || advancedHydrated) return;
    setSelectionMode((config.selectionMode as "AUTO" | "SINGLE" | "ENSEMBLE" | null) ?? "AUTO");
    setFixedStrategyId((config.fixedStrategyId as string | null) ?? null);
    setResumeAfterRestart(Boolean(config.resumeTradingAfterRestart));
    setAdvancedHydrated(true);
  }, [engine?.configuration, advancedHydrated]);

  if (isLoading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.pad}>
        <Skeleton height={140} />
        <Skeleton height={200} />
      </ScrollView>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const enabledSymbols = symbolsData?.symbols.filter((s) => s.enabled) ?? [];
  const strategies = strategiesData?.strategies ?? [];

  const activeSymbol = symbol ?? (config.symbol as string | null) ?? enabledSymbols[0]?.derivSymbol ?? null;
  const activeInterval = interval ?? (config.interval as (typeof INTERVALS)[number] | null) ?? "1m";
  const activeMode = mode ?? (config.mode as string | null) ?? "ANALYSIS_ONLY";
  const activeSelection = selectionMode ?? "AUTO";
  const activeFixedId =
    fixedStrategyId !== null
      ? fixedStrategyId
      : ((config.fixedStrategyId as string | null) ?? null);
  const activeResume =
    resumeAfterRestart != null
      ? resumeAfterRestart
      : Boolean(config.resumeTradingAfterRestart);

  const state = engine?.state ?? "STOPPED";
  const emergencyStop = engine?.emergencyStop ?? false;
  const running = state.startsWith("RUNNING") || state === "PAUSED";
  const demoAllowed = engine?.demoTradingGloballyEnabled ?? false;
  const liveAllowed =
    (engine?.liveTradingArmed ?? engine?.liveTradingGloballyEnabled ?? false) === true;
  const mt5 = mt5Data?.status;
  const mt5EngineOn = Boolean(mt5?.engineAutomationEnabled ?? mt5?.config?.mt5EngineEnabled);
  const mt5Active = Boolean(mt5?.enabled);
  const bridgeOnline = mt5?.bridge === "online" || Boolean(mt5?.connected);
  const eaOnline = mt5?.ea === "online" || Boolean(mt5?.eaConnected);
  const reconcile =
    mt5?.reconciliation === "fresh" ? "Fresh" : mt5?.reconciliation === "stale" ? "Stale" : "Unknown";

  function runAction(actionName: "start" | "pause" | "resume" | "stop" | "emergency-stop"): void {
    setActionError(null);
    action.mutate(actionName, {
      onError: (err) => setActionError(err instanceof ApiError ? err.message : "Engine action failed")
    });
  }

  function saveConfig(): void {
    if (!activeSymbol) return;
    setActionError(null);
    configure.mutate(
      {
        symbol: activeSymbol,
        interval: activeInterval,
        mode: activeMode,
        selectionMode: activeSelection,
        fixedStrategyId: activeSelection === "SINGLE" ? activeFixedId : null,
        resumeTradingAfterRestart: activeResume,
        // Preserve risk profile link if present
        ...(config.riskProfileId != null ? { riskProfileId: config.riskProfileId } : {})
      },
      {
        onError: (err) => setActionError(err instanceof ApiError ? err.message : "Failed to save configuration")
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
        <Text style={styles.stateHero}>{stateLabel(state)}</Text>
        {engine?.stateReason ? <Text style={styles.reason}>{engine.stateReason}</Text> : null}
        <View style={{ height: spacing.md }} />
        <ChipRow>
          <StatusChip label={stateLabel(state)} tone={stateTone(state)} />
          {mt5Active ? <StatusChip label="MT5 DEMO" tone="accent" /> : <StatusChip label="Paper / analysis" tone="neutral" />}
          {mt5Active ? (
            <>
              <StatusChip label={`Bridge ${bridgeOnline ? "online" : "offline"}`} tone={bridgeOnline ? "up" : "warning"} />
              <StatusChip label={`EA ${eaOnline ? "online" : "offline"}`} tone={eaOnline ? "up" : "warning"} />
              <StatusChip
                label={`Reconcile ${reconcile}`}
                tone={reconcile === "Fresh" ? "up" : reconcile === "Stale" ? "warning" : "neutral"}
              />
              <StatusChip
                label={mt5EngineOn ? "Autonomous on" : "Autonomous off"}
                tone={mt5EngineOn ? "accent" : "neutral"}
              />
            </>
          ) : null}
          {emergencyStop ? <StatusChip label="Emergency latched" tone="down" /> : null}
          {!demoAllowed ? <StatusChip label="Demo trading off" tone="warning" /> : null}
        </ChipRow>
        {emergencyStop ? (
          <Text style={styles.emergency}>
            Clear the emergency stop before starting again.
          </Text>
        ) : null}
      </SoftCard>

      <SectionHeader title="Configuration" />
      <SoftCard>
        <Text style={styles.fieldLabel}>Symbol</Text>
        <SegmentedChips
          options={enabledSymbols.map((sym) => ({ id: sym.derivSymbol, label: sym.derivSymbol }))}
          value={activeSymbol}
          onChange={setSymbol}
        />
        <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>Interval</Text>
        <SegmentedChips
          options={INTERVALS.map((iv) => ({ id: iv, label: iv }))}
          value={activeInterval}
          onChange={(id) => setInterval(id as (typeof INTERVALS)[number])}
        />
        <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>Mode</Text>
        <SegmentedChips
          options={MODES.filter((m) => {
            if (m.value === "DEMO_TRADING" && !demoAllowed) return false;
            if (m.value === "LIVE_TRADING" && !liveAllowed) return false;
            return true;
          }).map((m) => ({
            id: m.value,
            label: m.label
          }))}
          value={activeMode}
          onChange={(id) => {
            setMode(id);
            if (id === "LIVE_TRADING") setResumeAfterRestart(false);
          }}
        />
        <View style={{ height: spacing.md }} />
        <PrimaryButton
          title="Save configuration"
          variant="secondary"
          onPress={saveConfig}
          loading={configure.isPending}
        />
      </SoftCard>

      <Collapsible title="Advanced / engine configuration">
        <Text style={styles.fieldLabel}>Strategy selection</Text>
        <SegmentedChips
          options={[...SELECTION_MODES]}
          value={activeSelection}
          onChange={(id) => {
            setSelectionMode(id as "AUTO" | "SINGLE" | "ENSEMBLE");
            if (id !== "SINGLE") setFixedStrategyId(null);
          }}
        />
        <Text style={styles.hint}>
          Auto picks by regime. Single pins one strategy. Ensemble aggregates votes.
        </Text>
        {activeSelection === "SINGLE" ? (
          <>
            <Text style={[styles.fieldLabel, { marginTop: spacing.md }]}>Fixed strategy</Text>
            <SegmentedChips
              options={strategies.slice(0, 12).map((s) => ({ id: s.id, label: s.name }))}
              value={activeFixedId}
              onChange={setFixedStrategyId}
            />
            <TicketField
              label="Or paste strategy ID"
              value={activeFixedId ?? ""}
              onChangeText={(t) => setFixedStrategyId(t.trim() || null)}
              keyboardType="default"
              hint="Required when selection is Single"
            />
          </>
        ) : null}
        <View style={styles.toggleRow}>
          <View style={{ flex: 1, paddingRight: spacing.md }}>
            <Text style={styles.toggleLabel}>Resume trading after restart</Text>
            <Text style={styles.toggleHint}>
              {activeMode === "LIVE_TRADING"
                ? "Disabled for live — worker restarts always stay analysis-only until you explicitly start again."
                : "When off, worker restarts stay analysis-only until you start demo trading again."}
            </Text>
          </View>
          <Switch
            value={activeMode === "LIVE_TRADING" ? false : activeResume}
            onValueChange={(v) => setResumeAfterRestart(v)}
            disabled={activeMode === "LIVE_TRADING"}
            trackColor={{ false: colors.border, true: colors.accent }}
            thumbColor={colors.text}
          />
        </View>
        <PrimaryButton
          title="Save advanced configuration"
          variant="secondary"
          onPress={saveConfig}
          loading={configure.isPending}
        />
      </Collapsible>

      <SectionHeader title="Controls" />
      <SoftCard>
        {emergencyStop ? (
          <PrimaryButton
            title="Clear emergency stop"
            variant="secondary"
            onPress={() => runAction("stop")}
            loading={action.isPending}
          />
        ) : null}
        {!running ? (
          <PrimaryButton
            title="Start"
            onPress={() => runAction("start")}
            loading={action.isPending}
            disabled={emergencyStop}
          />
        ) : (
          <>
            {state === "PAUSED" ? (
              <PrimaryButton title="Resume" onPress={() => runAction("resume")} loading={action.isPending} />
            ) : (
              <PrimaryButton
                title="Pause"
                variant="secondary"
                onPress={() => runAction("pause")}
                loading={action.isPending}
              />
            )}
            <PrimaryButton
              title="Stop"
              variant="secondary"
              onPress={() => runAction("stop")}
              loading={action.isPending}
            />
          </>
        )}
        {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
        <View style={styles.emergencyWrap}>
          <PrimaryButton
            title="Emergency stop"
            variant="danger"
            onPress={() => runAction("emergency-stop")}
            loading={action.isPending}
          />
        </View>
      </SoftCard>

      <Collapsible title="Runtime details">
        <Text style={styles.detail}>
          Symbol {activeSymbol ?? "—"} · {activeInterval} · {activeMode.replace(/_/g, " ")} ·{" "}
          {activeSelection}
          {activeSelection === "SINGLE" && activeFixedId ? ` · ${activeFixedId.slice(0, 8)}…` : ""}
        </Text>
        <Text style={styles.detail}>
          Resume after restart: {activeResume ? "yes" : "no"}
        </Text>
        <Text style={styles.detail}>
          Last tick{" "}
          {engine?.lastTickAt ? new Date(engine.lastTickAt).toLocaleTimeString() : "—"}
        </Text>
        {mt5Active ? (
          <Text style={styles.detail}>
            {mt5?.server ?? "MT5"}
            {mt5?.login ? ` · login ${mt5.login}` : ""}
            {mt5EngineOn ? " · engine automation ON" : " · engine automation OFF"}
          </Text>
        ) : null}
        <Text style={styles.hint}>
          {liveAllowed
            ? "LIVE_TRADING is armed on the server. Live never auto-resumes after restart."
            : demoAllowed
              ? "CFD demo follows the server execution venue. Engine-driven MT5 orders stay off unless MT5_ENGINE_ENABLED is true."
              : "DEMO_TRADING_ENABLED=false — analysis-only still classifies regimes and logs decisions without placing trades."}
        </Text>
      </Collapsible>

      <Text style={styles.disclaimer}>
        Experimental CFD research · Live money requires explicit server gates (off by default)
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 56 },
  stateHero: {
    color: colors.text,
    fontSize: font.metricLarge,
    fontWeight: "800",
    letterSpacing: -0.3
  },
  reason: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  emergency: { color: colors.warning, fontSize: font.caption, marginTop: spacing.md, lineHeight: 18 },
  emergencyWrap: { marginTop: spacing.lg },
  actionError: { color: colors.down, fontSize: font.caption, marginTop: spacing.sm },
  fieldLabel: {
    color: colors.textFaint,
    fontSize: font.micro,
    fontWeight: "700",
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
    textTransform: "uppercase"
  },
  detail: { color: colors.textDim, fontSize: font.caption, marginBottom: 6, lineHeight: 18 },
  hint: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.lg,
    marginBottom: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border
  },
  toggleLabel: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  toggleHint: { color: colors.textFaint, fontSize: font.caption, marginTop: 2 },
  disclaimer: {
    color: colors.textFaint,
    fontSize: font.micro,
    textAlign: "center",
    marginTop: spacing.xl,
    lineHeight: 16
  }
});
