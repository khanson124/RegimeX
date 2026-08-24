import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useClosePosition, usePaperAccount, usePositions } from "../src/api/hooks";
import { alertMessage, confirmAsync } from "../src/lib/confirm";
import { Badge, Button, Card, EmptyState, ErrorView, Metric, Row, SectionTitle, Skeleton } from "../src/components/ui";
import { colors, font, spacing, REGIME_LABELS } from "../src/theme";

function n(v: unknown): number | null {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function money(v: unknown): string {
  const x = n(v);
  return x != null ? x.toFixed(2) : "—";
}

function durationLabel(openedAt: string | null): string {
  if (!openedAt) return "—";
  const ms = Date.now() - new Date(openedAt).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function venueLabel(item: Record<string, unknown>): string {
  const meta = (item.metadata ?? {}) as Record<string, unknown>;
  const model = String(meta.executionModel ?? "");
  if (model === "broker_demo_mt5" || String(item.idempotencyKey ?? "").startsWith("TEST:mt5:")) return "MT5 DEMO";
  if (model === "broker_demo_cfd") return "cTrader DEMO";
  return "PAPER CFD";
}

function currentR(item: Record<string, unknown>): string {
  const floating = n(item.floatingPnl);
  const risk = n(item.initialRiskAmount) ?? n(item.riskAmount);
  if (floating == null || risk == null || risk <= 0) return "—";
  return `${(floating / risk).toFixed(2)}R`;
}

export default function PositionsScreen() {
  const [tab, setTab] = useState<"OPEN" | "CLOSED">("OPEN");
  const { data: accountData, refetch: refetchAccount, isRefetching: acctRefetching } = usePaperAccount();
  const { data, isLoading, isError, error, refetch, isRefetching } = usePositions(tab);
  const closePos = useClosePosition();
  const account = accountData?.account;
  const items = data?.items ?? [];

  async function onClose(id: string): Promise<void> {
    const ok = await confirmAsync("Close position?", "Requests a broker/paper close. Status stays OPEN until confirmation.", "Close");
    if (!ok) return;
    try {
      const res = await closePos.mutateAsync(id);
      alertMessage("Close requested", res.message ?? "Worker will close the position.");
      void refetch();
      void refetchAccount();
    } catch (err) {
      alertMessage("Close failed", err instanceof Error ? err.message : "Unknown error");
    }
  }

  if (isLoading) {
    return (
      <View style={[styles.container, { padding: spacing.lg }]}>
        <Skeleton height={100} />
        <Skeleton height={160} />
      </View>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}
      data={items}
      keyExtractor={(item) => String(item.id)}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching || acctRefetching}
          onRefresh={() => {
            void refetch();
            void refetchAccount();
          }}
          tintColor={colors.accent}
        />
      }
      ListHeaderComponent={
        <>
          <SectionTitle>Paper CFD account</SectionTitle>
          <Card>
            {account ? (
              <>
                <Row>
                  <Metric label="Balance" value={money(account.balance)} large />
                  <Metric label="Equity" value={money(account.equity)} large />
                </Row>
                <Row>
                  <Metric
                    label="Floating P/L"
                    value={money(account.floatingPnl)}
                    tone={n(account.floatingPnl)! > 0 ? "up" : n(account.floatingPnl)! < 0 ? "down" : "neutral"}
                  />
                  <Metric
                    label="Realized P/L"
                    value={money(account.realizedPnl)}
                    tone={n(account.realizedPnl)! > 0 ? "up" : n(account.realizedPnl)! < 0 ? "down" : "neutral"}
                  />
                </Row>
                <Row>
                  <Metric label="Used margin" value={money(account.usedMargin)} />
                  <Metric label="Free margin" value={money(account.freeMargin)} />
                </Row>
              </>
            ) : (
              <Text style={styles.dim}>No paper account yet — start the live engine once to create it.</Text>
            )}
          </Card>

          <SectionTitle>Positions</SectionTitle>
          <Row style={{ marginBottom: spacing.md }}>
            {(["OPEN", "CLOSED"] as const).map((t) => (
              <Pressable key={t} onPress={() => setTab(t)}>
                <Text style={[styles.tab, tab === t && styles.tabActive]}>{t}</Text>
              </Pressable>
            ))}
          </Row>
        </>
      }
      ListEmptyComponent={
        <EmptyState
          title={tab === "OPEN" ? "No open positions" : "No closed positions"}
          hint="PAPER CFD, cTrader DEMO, and MT5 DEMO are separate venues. Paper is not broker state."
        />
      }
      renderItem={({ item }) => {
        const direction = String(item.direction);
        const regime = item.regime ? REGIME_LABELS[String(item.regime)] ?? String(item.regime) : "—";
        return (
          <Card>
            <Row>
              <Badge
                tone={direction === "BUY" ? "up" : "down"}
                text={`${direction} · ${String(item.symbol)}`}
              />
              <Badge tone="warning" text={venueLabel(item)} />
              <Text style={styles.meta}>{durationLabel(item.openedAt as string | null)}</Text>
            </Row>
            <Text style={styles.strategy}>
              {String(item.strategyId)} · {regime} · {String(item.origin ?? "ENGINE")}
            </Text>
            <Row>
              <Metric label="Volume" value={String(n(item.volume) ?? "—")} />
              <Metric label="Entry" value={String(n(item.entryPrice) ?? "—")} />
              <Metric label="Current" value={String(n(item.currentPrice) ?? "—")} />
            </Row>
            <Row>
              <Metric label="Initial SL" value={String(n(item.initialStopLoss) ?? n(item.stopLoss) ?? "—")} />
              <Metric label="Current SL" value={String(n(item.stopLoss) ?? "—")} />
            </Row>
            <Row>
              <Metric label="Initial TP" value={String(n(item.initialTakeProfit) ?? n(item.takeProfit) ?? "—")} />
              <Metric label="Current TP" value={String(n(item.takeProfit) ?? "—")} />
            </Row>
            <Row>
              <Metric label="Initial risk" value={money(item.initialRiskAmount ?? item.riskAmount)} />
              <Metric
                label={tab === "OPEN" ? "Floating P/L" : "Realized P/L"}
                value={money(tab === "OPEN" ? item.floatingPnl : item.realizedPnl)}
                tone={
                  (n(tab === "OPEN" ? item.floatingPnl : item.realizedPnl) ?? 0) > 0
                    ? "up"
                    : (n(tab === "OPEN" ? item.floatingPnl : item.realizedPnl) ?? 0) < 0
                      ? "down"
                      : "neutral"
                }
              />
              <Metric label="R" value={tab === "OPEN" ? currentR(item) : String(item.closeReason ?? "—")} />
            </Row>
            {item.brokerPositionId ? (
              <Text style={styles.meta}>Ticket {String(item.brokerPositionId)}</Text>
            ) : null}
            {tab === "OPEN" ? (
              <Button
                title="Close position"
                variant="secondary"
                loading={closePos.isPending}
                onPress={() => void onClose(String(item.id))}
              />
            ) : null}
          </Card>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  dim: { color: colors.textDim, fontSize: font.body },
  tab: {
    color: colors.textDim,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontWeight: "700",
    marginRight: spacing.sm,
    overflow: "hidden"
  },
  tabActive: { color: colors.text, borderColor: colors.accent, backgroundColor: "#12283F" },
  meta: { color: colors.textFaint, fontSize: font.caption },
  strategy: { color: colors.textDim, fontSize: font.caption, marginVertical: spacing.sm }
});
