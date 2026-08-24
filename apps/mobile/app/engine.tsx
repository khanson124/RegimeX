import React, { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text } from "react-native";
import { ApiError } from "../src/api/client";
import { useConfigureEngine, useEngine, useEngineAction, useMt5Status, useSymbols } from "../src/api/hooks";
import { Badge, Button, Card, ErrorView, Metric, Row, SectionTitle, Skeleton } from "../src/components/ui";
import { colors, font, spacing } from "../src/theme";

const INTERVALS = ["1m", "5m"] as const;
const MODES = [
  { value: "ANALYSIS_ONLY", label: "Analysis only" },
  { value: "DEMO_TRADING", label: "CFD demo trading" }
] as const;

function stateTone(state: string): "up" | "down" | "warning" | "neutral" {
  if (state.startsWith("RUNNING")) return "up";
  if (state === "EMERGENCY_STOPPED" || state === "ERROR") return "down";
  if (state === "PAUSED" || state === "DEGRADED") return "warning";
  return "neutral";
}

export default function EngineScreen() {
  const { data, isLoading, isError, error, refetch, isRefetching } = useEngine();
  const { data: symbolsData } = useSymbols();
  const { data: mt5Data } = useMt5Status();
  const action = useEngineAction();
  const configure = useConfigureEngine();

  const [symbol, setSymbol] = useState<string | null>(null);
  const [interval, setInterval] = useState<(typeof INTERVALS)[number] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <Skeleton height={140} />
        <Skeleton height={200} />
      </ScrollView>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const engine = data?.engine ?? null;
  const config = (engine?.configuration ?? {}) as Record<string, string | null>;
  const enabledSymbols = symbolsData?.symbols.filter((s) => s.enabled) ?? [];

  const activeSymbol = symbol ?? config.symbol ?? enabledSymbols[0]?.derivSymbol ?? null;
  const activeInterval = interval ?? (config.interval as (typeof INTERVALS)[number] | null) ?? "1m";
  const activeMode = mode ?? config.mode ?? "ANALYSIS_ONLY";
  const state = engine?.state ?? "STOPPED";
  const emergencyStop = engine?.emergencyStop ?? false;
  const running = state.startsWith("RUNNING") || state === "PAUSED";
  const demoAllowed = engine?.demoTradingGloballyEnabled ?? false;
  const mt5 = mt5Data?.status;
  const mt5EngineOn = Boolean(mt5?.engineAutomationEnabled ?? mt5?.config?.mt5EngineEnabled);

  function runAction(actionName: "start" | "pause" | "resume" | "stop" | "emergency-stop"): void {
    setActionError(null);
    action.mutate(actionName, {
      onError: (err) =>
        setActionError(err instanceof ApiError ? err.message : "Engine action failed")
    });
  }

  function saveConfig(): void {
    if (!activeSymbol) return;
    configure.mutate({
      symbol: activeSymbol,
      interval: activeInterval,
      mode: activeMode,
      selectionMode: "AUTO"
    });
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={colors.accent} />}
    >
      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Metric label="Engine state" value={state.replace(/_/g, " ")} tone={stateTone(state)} large />
          <Badge tone={stateTone(state)} text={state} />
        </Row>
        {engine?.stateReason ? <Text style={styles.reason}>{engine.stateReason}</Text> : null}
        {emergencyStop ? (
          <Text style={styles.emergency}>
            Emergency stop is latched. Tap &quot;Clear emergency stop&quot; below before starting again.
          </Text>
        ) : null}
        {engine?.lastTickAt ? (
          <Text style={styles.meta}>Last tick {new Date(engine.lastTickAt).toLocaleTimeString()}</Text>
        ) : null}
      </Card>

      <SectionTitle>Configuration</SectionTitle>
      <Card>
        <Text style={styles.label}>Symbol</Text>
        <Row style={{ marginBottom: spacing.md }}>
          {enabledSymbols.map((sym) => (
            <Pressable key={sym.id} onPress={() => setSymbol(sym.derivSymbol)}>
              <Text style={[styles.selector, activeSymbol === sym.derivSymbol && styles.selectorActive]}>
                {sym.derivSymbol}
              </Text>
            </Pressable>
          ))}
        </Row>
        <Text style={styles.label}>Interval</Text>
        <Row style={{ marginBottom: spacing.md }}>
          {INTERVALS.map((iv) => (
            <Pressable key={iv} onPress={() => setInterval(iv)}>
              <Text style={[styles.selector, activeInterval === iv && styles.selectorActive]}>{iv}</Text>
            </Pressable>
          ))}
        </Row>
        <Text style={styles.label}>Mode</Text>
        <Row style={{ marginBottom: spacing.md }}>
          {MODES.map((m) => {
            const disabled = m.value === "DEMO_TRADING" && !demoAllowed;
            return (
              <Pressable key={m.value} onPress={() => !disabled && setMode(m.value)} disabled={disabled}>
                <Text
                  style={[
                    styles.selector,
                    activeMode === m.value && styles.selectorActive,
                    disabled && styles.selectorDisabled
                  ]}
                >
                  {m.label}
                </Text>
              </Pressable>
            );
          })}
        </Row>
        {!demoAllowed ? (
          <Text style={styles.hint}>
            CFD demo trading is disabled server-side (DEMO_TRADING_ENABLED=false). Analysis-only mode still
            classifies regimes, selects strategies, and logs every decision without placing trades.
          </Text>
        ) : (
          <Text style={styles.hint}>
            CFD demo trading follows the server execution venue (MT5 DEMO, cTrader DEMO, or paper CFD).
            Engine-driven MT5 orders stay off unless MT5_ENGINE_ENABLED is true
            {mt5EngineOn ? " — currently ON." : " — currently OFF."}
            Empty symbol/strategy allowlists fail closed. This never enables live money.
          </Text>
        )}
        <Button title="Save configuration" variant="secondary" onPress={saveConfig} loading={configure.isPending} />
      </Card>

      <SectionTitle>Controls</SectionTitle>
      {emergencyStop ? (
        <Button
          title="Clear emergency stop"
          variant="secondary"
          onPress={() => runAction("stop")}
          loading={action.isPending}
        />
      ) : null}
      {!running ? (
        <Button
          title="Start engine"
          onPress={() => runAction("start")}
          loading={action.isPending}
          disabled={emergencyStop}
        />
      ) : (
        <>
          {state === "PAUSED" ? (
            <Button title="Resume" onPress={() => runAction("resume")} loading={action.isPending} />
          ) : (
            <Button title="Pause" variant="secondary" onPress={() => runAction("pause")} loading={action.isPending} />
          )}
          <Button title="Stop" variant="secondary" onPress={() => runAction("stop")} loading={action.isPending} />
        </>
      )}
      {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}
      <Button title="EMERGENCY STOP" variant="danger" onPress={() => runAction("emergency-stop")} loading={action.isPending} />

      <Text style={styles.disclaimer}>
        Experimental CFD research tool. MT5 DEMO / paper fallback only — live-money trading is blocked.
        Signals and backtests are not financial advice and no profitability is promised.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  reason: { color: colors.textDim, fontSize: font.body, marginTop: spacing.sm },
  emergency: { color: colors.warning, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  actionError: { color: colors.down, fontSize: font.caption, marginVertical: spacing.sm },
  meta: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.xs },
  label: { color: colors.textDim, fontSize: font.caption, marginBottom: spacing.xs },
  selector: {
    color: colors.textDim,
    backgroundColor: colors.bg,
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
  selectorDisabled: { opacity: 0.35 },
  hint: { color: colors.textFaint, fontSize: font.caption, marginBottom: spacing.sm, lineHeight: 18 },
  disclaimer: { color: colors.textFaint, fontSize: font.caption, textAlign: "center", marginTop: spacing.lg, lineHeight: 18 }
});
