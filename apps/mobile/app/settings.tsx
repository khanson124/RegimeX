import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ApiError } from "../src/api/client";
import {
  useArmLiveTrading,
  useConnectDeriv,
  useDashboard,
  useDerivAccount,
  useDisarmLiveTrading,
  useDisconnectDeriv,
  useDownloadMarketData,
  useLiveTradingStatus,
  useMt5Status,
  useTestDerivConnection
} from "../src/api/hooks";
import { useAuthStore } from "../src/stores/auth";
import {
  describeTradeMode,
  formatLiveConfirmationFacts,
  maskBrokerLogin,
  resolveLiveTradingSupported,
  type TradingEnvironment
} from "../src/lib/tradingEnvironment";
import { ErrorView, Skeleton } from "../src/components/ui";
import {
  ChipRow,
  Collapsible,
  InfoRow,
  PrimaryButton,
  SectionHeader,
  SegmentedChips,
  SoftCard,
  StatusChip,
  TicketField
} from "../src/components/design";
import { colors, font, spacing } from "../src/theme";

export default function SettingsScreen() {
  const { data, isLoading, isError, error, refetch } = useDerivAccount();
  const { data: mt5Data } = useMt5Status();
  const { data: dashboard } = useDashboard();
  const { data: liveTradingData, refetch: refetchLiveTrading } = useLiveTradingStatus();
  const armLive = useArmLiveTrading();
  const disarmLive = useDisarmLiveTrading();
  const connect = useConnectDeriv();
  const disconnect = useDisconnectDeriv();
  const testConn = useTestDerivConnection();
  const download = useDownloadMarketData();
  const clearSession = useAuthStore((s) => s.clearSession);
  const router = useRouter();

  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  /** UI preference only — Live selection does not rewrite .env. */
  const [tradingEnvironment, setTradingEnvironment] = useState<TradingEnvironment>("demo");
  const [armConfirmText, setArmConfirmText] = useState("");
  const [showArmConfirm, setShowArmConfirm] = useState(false);

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

  const account = data?.account ?? null;
  const mt5 = mt5Data?.status;
  const executionSource = dashboard?.summary.execution?.source;
  const executionMode = String(mt5?.config?.executionMode ?? mt5?.mode ?? executionSource ?? "—");
  const venueLabel =
    executionSource === "MT5_LIVE" || mt5?.config?.executionMode === "broker_real_mt5"
      ? "MT5 LIVE"
      : executionSource === "MT5_DEMO" || mt5?.enabled
        ? "MT5 DEMO"
        : executionSource === "CTRADER_DEMO" || mt5?.config?.executionMode === "broker_demo_cfd"
          ? "cTrader DEMO"
          : executionSource === "PAPER_CFD" || mt5?.config?.executionMode === "paper_cfd"
            ? "Paper CFD"
            : String(mt5?.config?.executionMode ?? "—");

  const mt5LinkTone = !mt5?.enabled
    ? "neutral"
    : mt5.connected
      ? "up"
      : mt5.error
        ? "down"
        : "warning";
  const mt5LinkLabel = !mt5?.enabled
    ? "MT5 off"
    : mt5.connected
      ? "MT5 connected"
      : mt5.error
        ? "MT5 error"
        : "MT5 offline";
  const marketTone = account ? "up" : "warning";

  const liveStatus = liveTradingData?.status;
  const liveTradingSupported = resolveLiveTradingSupported({
    liveTradingSupported:
      Boolean(liveStatus?.liveTradingSupported) ||
      Boolean(mt5?.liveTradingSupported) ||
      Boolean(mt5?.config?.liveTradingSupported) ||
      Boolean(dashboard?.summary.execution?.liveTradingSupported)
  });
  const liveTradingArmed = Boolean(liveStatus?.liveTradingArmed);
  const accountIsDemo = mt5?.isDemo === true || mt5?.demo === true || mt5?.tradeMode === "DEMO";
  const tradeModeLabel = describeTradeMode(mt5?.tradeMode, mt5?.isDemo ?? mt5?.demo);
  const cfg = (mt5?.config ?? {}) as Record<string, unknown>;

  function onSelectEnvironment(id: string): void {
    if (id === "live") {
      if (!liveTradingSupported) {
        Alert.alert(
          "Live trading not supported",
          "Server capability gates are off (REAL_MONEY_ENABLED / LIVE_MT5_ENABLED / live config). This app cannot edit .env."
        );
        return;
      }
      setTradingEnvironment("live");
      return;
    }
    setTradingEnvironment("demo");
    setShowArmConfirm(false);
    setArmConfirmText("");
  }

  function requestArm(): void {
    void refetchLiveTrading();
    setShowArmConfirm(true);
    setArmConfirmText("");
  }

  function confirmArm(): void {
    if (armConfirmText.trim() !== "ENABLE LIVE") {
      Alert.alert("Confirmation required", 'Type ENABLE LIVE exactly to arm live trading.');
      return;
    }
    armLive.mutate(undefined, {
      onSuccess: () => {
        setShowArmConfirm(false);
        setArmConfirmText("");
        Alert.alert("Live armed", "New live entries are now allowed (server policy still applies).");
      },
      onError: (err) =>
        Alert.alert("Arm failed", err instanceof ApiError ? err.message : "Could not arm live trading")
    });
  }

  function confirmDisarm(): void {
    Alert.alert(
      "Disarm live trading?",
      "No new live positions will open. Existing open live positions are not force-closed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disarm",
          style: "destructive",
          onPress: () =>
            disarmLive.mutate(undefined, {
              onError: (err) =>
                Alert.alert(
                  "Disarm failed",
                  err instanceof ApiError ? err.message : "Could not disarm live trading"
                )
            })
        }
      ]
    );
  }

  function connectToken(): void {
    setFormError(null);
    if (!token.trim()) {
      setFormError("Enter your Deriv demo API token (market data only)");
      return;
    }
    connect.mutate(token.trim(), {
      onSuccess: () => {
        setToken("");
        Alert.alert("Connected", "Market-data account linked. This token is not used for MT5 execution.");
      },
      onError: (err) => setFormError(err instanceof ApiError ? err.message : "Connection failed")
    });
  }

  function confirmDisconnect(): void {
    Alert.alert("Disconnect market data?", "The encrypted Deriv token will be revoked on the server.", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => disconnect.mutate() }
    ]);
  }

  function confirmLogout(): void {
    Alert.alert("Log out?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        onPress: () => {
          void clearSession();
          router.replace("/(auth)/login");
        }
      }
    ]);
  }

  function seedHistory(): void {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    download.mutate(
      { symbol: "R_10", interval: "1m", from, to },
      {
        onSuccess: () => Alert.alert("Queued", "Historical candle download job queued."),
        onError: (err) => Alert.alert("Failed", err instanceof ApiError ? err.message : "Download failed")
      }
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.pad}>
      <SoftCard>
        <Text style={styles.heroLabel}>Connection health</Text>
        <ChipRow>
          <StatusChip label={venueLabel} tone="accent" />
          <StatusChip label={mt5LinkLabel} tone={mt5LinkTone} />
          <StatusChip
            label={account ? "Market data OK" : "Market data off"}
            tone={marketTone}
          />
          {mt5?.enabled ? (
            <StatusChip
              label={mt5.engineAutomationEnabled ? "Engine MT5 ON" : "Engine MT5 OFF"}
              tone={mt5.engineAutomationEnabled ? "up" : "warning"}
            />
          ) : null}
        </ChipRow>
        <Text style={styles.hint}>
          Order routing is server-configured (EXECUTION_MODE). This app does not place real-money trades.
        </Text>
      </SoftCard>

      <SectionHeader title="Trading Environment" />
      <SoftCard>
        <SegmentedChips
          options={[
            { id: "demo", label: "Demo" },
            {
              id: "live",
              label: liveTradingSupported ? "Live" : "Live · not supported",
              disabled: !liveTradingSupported
            }
          ]}
          value={tradingEnvironment}
          onChange={onSelectEnvironment}
        />
        <View style={{ height: spacing.sm }} />
        <ChipRow>
          <StatusChip
            label={
              tradingEnvironment !== "live"
                ? "Demo · Active"
                : liveTradingArmed
                  ? "Live · Armed"
                  : "Live · Disarmed"
            }
            tone={
              tradingEnvironment !== "live" ? "up" : liveTradingArmed ? "down" : "warning"
            }
          />
          {!liveTradingSupported ? (
            <StatusChip label="Live capability gated off" tone="warning" />
          ) : null}
          {liveStatus && !liveStatus.accountEnvironmentValid ? (
            <StatusChip label="Account validation failed" tone="down" />
          ) : null}
        </ChipRow>
        <View style={{ height: spacing.sm }} />
        <InfoRow label="MT5 trade mode" value={tradeModeLabel} />
        <InfoRow
          label="Broker / server"
          value={liveStatus?.mt5.server ?? mt5?.server ?? mt5?.company ?? "—"}
        />
        <InfoRow
          label="Account / login"
          value={liveStatus?.mt5.loginMasked ?? maskBrokerLogin(mt5?.login)}
        />
        <InfoRow label="Engine execution env" value={executionMode} />
        {tradingEnvironment === "live" && liveTradingSupported ? (
          <>
            <View style={{ height: spacing.md }} />
            <Text style={styles.hint}>
              Arm/disarm is a server runtime flag. It does not edit .env, Docker, or restart services.
            </Text>
            {liveTradingArmed ? (
              <PrimaryButton
                title="Disarm live trading"
                variant="danger"
                onPress={confirmDisarm}
                loading={disarmLive.isPending}
              />
            ) : showArmConfirm ? (
              <>
                <Text style={styles.hint}>
                  {formatLiveConfirmationFacts({
                    server: liveStatus?.mt5.server ?? mt5?.server,
                    company: liveStatus?.mt5.company ?? mt5?.company,
                    login: mt5?.login,
                    liveAllowedSymbols: liveStatus?.allowedSymbols ?? (cfg.liveAllowedSymbols as string[] | undefined),
                    liveMaxConcurrentPositions:
                      liveStatus?.maxConcurrentLivePositions ?? Number(cfg.liveMaxConcurrentPositions ?? 1),
                    liveMaxRiskPerTradePercent:
                      liveStatus?.maxRiskPerTradePercent ?? Number(cfg.liveMaxRiskPerTradePercent ?? 0.25),
                    liveMaxDailyLoss: liveStatus?.maxDailyLoss ?? Number(cfg.liveMaxDailyLoss ?? 25),
                    liveMaxLotSize: liveStatus?.maxLotSize ?? Number(cfg.liveMaxLotSize ?? 0.01)
                  })}
                  {"\n"}Smoke test: {liveStatus?.smokeTestMode ? "ON" : "OFF"}
                  {"\n\n"}Type ENABLE LIVE to confirm.
                </Text>
                <TicketField
                  label="Confirmation phrase"
                  value={armConfirmText}
                  onChangeText={setArmConfirmText}
                  autoCapitalize="characters"
                  keyboardType="default"
                />
                <PrimaryButton
                  title="Arm live trading"
                  variant="danger"
                  onPress={confirmArm}
                  loading={armLive.isPending}
                  disabled={armConfirmText.trim() !== "ENABLE LIVE"}
                />
                <PrimaryButton
                  title="Cancel"
                  variant="secondary"
                  onPress={() => {
                    setShowArmConfirm(false);
                    setArmConfirmText("");
                  }}
                />
              </>
            ) : (
              <PrimaryButton title="Arm live trading…" variant="danger" onPress={requestArm} />
            )}
          </>
        ) : null}
        <Collapsible title="About Live trading" inline>
          <Text style={styles.hint}>
            liveTradingSupported comes only from server env gates and config. Arming persists on the
            server and is checked again before every new live order. Disarm blocks new entries
            immediately without force-closing open positions.
          </Text>
        </Collapsible>
      </SoftCard>

      <SectionHeader title="Market data" />
      <SoftCard>
        <Text style={styles.hint}>
          Deriv token is for candles and ticks only — not MT5 login, and cannot send broker orders.
        </Text>
        {account ? (
          <>
            <ChipRow>
              <StatusChip label="Connected" tone="up" />
              <StatusChip
                label={account.isVirtual ? "Virtual demo" : "Live blocked"}
                tone={account.isVirtual ? "neutral" : "down"}
              />
            </ChipRow>
            <View style={{ height: spacing.sm }} />
            <InfoRow label="Login ID" value={account.loginId} />
            <InfoRow label="Currency" value={account.currency} />
            <InfoRow
              label="Balance"
              value={account.balance != null ? account.balance.toFixed(2) : "—"}
            />
            <View style={{ height: spacing.md }} />
            <PrimaryButton
              title="Test connection"
              variant="secondary"
              onPress={() => testConn.mutate()}
              loading={testConn.isPending}
            />
            <PrimaryButton
              title="Disconnect"
              variant="danger"
              onPress={confirmDisconnect}
              loading={disconnect.isPending}
            />
          </>
        ) : (
          <>
            <TicketField
              label="Deriv demo API token"
              value={token}
              onChangeText={setToken}
              secureTextEntry
              autoCapitalize="none"
              keyboardType="default"
            />
            {formError ? <Text style={styles.error}>{formError}</Text> : null}
            <PrimaryButton title="Connect market data" onPress={connectToken} loading={connect.isPending} />
          </>
        )}
      </SoftCard>

      <SectionHeader title="MT5 / broker" />
      <SoftCard>
        <InfoRow label="Venue" value={venueLabel} />
        {mt5?.enabled ? (
          <>
            <InfoRow label="Link" value={mt5.connected ? "Connected" : mt5.error ? "Error" : "Offline"} />
            <InfoRow label="Server" value={mt5.server ?? "—"} />
            <InfoRow
              label="Engine orders"
              value={mt5.engineAutomationEnabled ? "ON" : "OFF"}
            />
            {mt5.config?.autonomous?.blocked && mt5.config.autonomous.reason ? (
              <InfoRow
                label="Block reason"
                value={String(mt5.config.autonomous.reason).replace(/_/g, " ")}
              />
            ) : null}
            <Collapsible title="Rollout details" inline>
              {mt5.config?.rollout?.allowedInternalSymbols?.length ? (
                <InfoRow
                  label="Allowlist"
                  value={(mt5.config.rollout.allowedInternalSymbols as string[]).join(", ")}
                />
              ) : (
                <Text style={styles.hint}>No symbol allowlist reported.</Text>
              )}
              {Array.isArray(mt5.config?.rollout?.resolvedBrokerSymbols) &&
              mt5.config.rollout.resolvedBrokerSymbols[0] ? (
                <InfoRow
                  label="Mapping"
                  value={`${mt5.config.rollout.resolvedBrokerSymbols[0].internalSymbol} → ${mt5.config.rollout.resolvedBrokerSymbols[0].brokerSymbol ?? "unmapped"} (${mt5.config.rollout.resolvedBrokerSymbols[0].verified ? "verified" : "unverified"})`}
                />
              ) : null}
              {mt5.config?.rollout?.engineMaxVolume != null ? (
                <InfoRow label="Max volume" value={String(mt5.config.rollout.engineMaxVolume)} />
              ) : null}
            </Collapsible>
          </>
        ) : (
          <Text style={styles.hint}>MT5 demo bridge is not enabled on this server.</Text>
        )}
      </SoftCard>

      <SectionHeader title="Connectivity" />
      <SoftCard>
        <InfoRow
          label="Bridge"
          value={mt5?.bridge === "online" || mt5?.connected ? "Online" : mt5?.enabled ? "Offline" : "n/a"}
        />
        <InfoRow
          label="EA"
          value={mt5?.ea === "online" || mt5?.eaConnected ? "Online" : mt5?.enabled ? "Offline" : "n/a"}
        />
        <InfoRow
          label="Reconciliation"
          value={
            mt5?.reconciliation === "fresh"
              ? "Fresh"
              : mt5?.reconciliation === "stale"
                ? "Stale"
                : "Unknown"
          }
        />
      </SoftCard>

      <SectionHeader title="Data management" />
      <SoftCard>
        <Text style={styles.hint}>Queue a 7-day historical candle download for R_10 (1m) from Deriv.</Text>
        <PrimaryButton
          title="Download sample history"
          variant="secondary"
          onPress={seedHistory}
          loading={download.isPending}
        />
      </SoftCard>

      <SectionHeader title="Account" />
      <SoftCard>
        <Pressable onPress={confirmLogout} style={styles.logoutBtn}>
          <Text style={styles.logout}>Log out</Text>
        </Pressable>
      </SoftCard>

      <Text style={styles.disclaimer}>
        RegimeX researches CFD on synthetic indices. Primary forward path is MT5 DEMO; paper CFD is fallback.
        Past performance does not guarantee future results.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 56 },
  heroLabel: {
    color: colors.textDim,
    fontSize: font.caption,
    fontWeight: "600",
    marginBottom: spacing.sm
  },
  hint: { color: colors.textDim, fontSize: font.caption, marginTop: spacing.sm, lineHeight: 18 },
  error: { color: colors.down, fontSize: font.caption, marginBottom: spacing.sm },
  logoutBtn: { paddingVertical: spacing.sm },
  logout: { color: colors.down, fontSize: font.body, fontWeight: "700", textAlign: "center" },
  disclaimer: {
    color: colors.textFaint,
    fontSize: font.caption,
    textAlign: "center",
    marginTop: spacing.lg,
    lineHeight: 18
  }
});
