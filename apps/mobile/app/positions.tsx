import React, { useState } from "react";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useClosePosition, useModifyPosition, useMt5Status, usePaperAccount, usePositions } from "../src/api/hooks";
import { alertMessage, confirmAsync } from "../src/lib/confirm";
import { EmptyState, ErrorView, Skeleton } from "../src/components/ui";
import {
  ChipRow,
  Collapsible,
  HeroStat,
  PrimaryButton,
  ProgressBar,
  SectionHeader,
  SegmentedChips,
  SoftCard,
  StatRow,
  StatTile,
  StatusChip,
  TicketField
} from "../src/components/design";
import { colors, font, spacing, REGIME_LABELS } from "../src/theme";

function n(v: unknown): number | null {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function money(v: unknown): string {
  const x = n(v);
  return x != null ? `${x >= 0 ? "" : ""}${x.toFixed(2)}` : "—";
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

function currentR(item: Record<string, unknown>): number | null {
  const floating = n(item.floatingPnl);
  const risk = n(item.initialRiskAmount) ?? n(item.riskAmount);
  if (floating == null || risk == null || risk <= 0) return null;
  return floating / risk;
}

/**
 * Infer SL lock state from initial vs current stop (no dedicated backend flag).
 * Labels say "SL at …" so we don't imply a guaranteed broker OCO lock.
 */
function profitLockChip(
  item: Record<string, unknown>
): { label: string; tone: "accent" | "up" | "warning"; hint: string } | null {
  const entry = n(item.entryPrice);
  const initial = n(item.initialStopLoss);
  const current = n(item.stopLoss);
  const direction = String(item.direction);
  if (entry == null || initial == null || current == null) return null;
  const tightened = direction === "BUY" ? current > initial + 1e-12 : current < initial - 1e-12;
  if (!tightened) return null;
  const risk = Math.abs(entry - initial);
  const hint = "Inferred from stop move vs initial SL — not a separate broker lock order.";
  if (!(risk > 0)) return { label: "SL moved", tone: "accent", hint };
  const protectedR = direction === "BUY" ? (current - entry) / risk : (entry - current) / risk;
  if (protectedR >= 0.99) return { label: "SL at +1.0R", tone: "up", hint };
  if (protectedR >= 0.49) return { label: "SL at +0.5R", tone: "up", hint };
  if (protectedR >= 0.19) return { label: "SL at +0.2R", tone: "accent", hint };
  if (protectedR >= -0.05) return { label: "SL at breakeven", tone: "accent", hint };
  return { label: "SL tightened", tone: "warning", hint };
}

/** Progress from entry toward TP (0–100), if levels exist. */
function tpProgress(item: Record<string, unknown>): number | null {
  const entry = n(item.entryPrice);
  const current = n(item.currentPrice);
  const tp = n(item.takeProfit);
  if (entry == null || current == null || tp == null) return null;
  const direction = String(item.direction);
  if (direction === "BUY") {
    const range = tp - entry;
    if (!(range > 0)) return null;
    return Math.max(0, Math.min(100, ((current - entry) / range) * 100));
  }
  const range = entry - tp;
  if (!(range > 0)) return null;
  return Math.max(0, Math.min(100, ((entry - current) / range) * 100));
}

function PositionCard({
  item,
  tab,
  onClose,
  onModify,
  closePending,
  modifyPending
}: {
  item: Record<string, unknown>;
  tab: "OPEN" | "CLOSED";
  onClose: (id: string) => void;
  onModify: (id: string, stopLoss: number, takeProfit: number | null) => void;
  closePending: boolean;
  modifyPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [slDraft, setSlDraft] = useState(String(n(item.stopLoss) ?? ""));
  const [tpDraft, setTpDraft] = useState(String(n(item.takeProfit) ?? ""));
  const direction = String(item.direction);
  const regime = item.regime ? REGIME_LABELS[String(item.regime)] ?? String(item.regime) : null;
  const pnl = n(tab === "OPEN" ? item.floatingPnl : item.realizedPnl) ?? 0;
  const rMult = currentR(item);
  const lock = tab === "OPEN" ? profitLockChip(item) : null;
  const progress = tab === "OPEN" ? tpProgress(item) : null;
  const strategy = String(item.strategyId ?? "—");
  const initialSl = n(item.initialStopLoss);
  const currentSl = n(item.stopLoss);
  const currentTp = n(item.takeProfit);

  return (
    <SoftCard>
      <View style={styles.cardTop}>
        <View style={{ flex: 1 }}>
          <ChipRow>
            <StatusChip
              label={`${direction} · ${String(item.symbol)}`}
              tone={direction === "BUY" ? "up" : "down"}
            />
            <StatusChip label={venueLabel(item)} tone="warning" />
            {lock ? <StatusChip label={lock.label} tone={lock.tone} /> : null}
          </ChipRow>
          {lock ? <Text style={styles.lockHint}>{lock.hint}</Text> : null}
          <Text style={styles.strategyLine}>
            {strategy}
            {regime ? ` · ${regime}` : ""}
            {` · ${durationLabel(item.openedAt as string | null)}`}
          </Text>
        </View>
        <View style={styles.pnlBlock}>
          <Text
            style={[
              styles.pnlValue,
              { color: pnl > 0 ? colors.up : pnl < 0 ? colors.down : colors.text }
            ]}
          >
            {pnl > 0 ? "+" : ""}
            {money(pnl)}
          </Text>
          <Text style={styles.pnlLabel}>
            {tab === "OPEN"
              ? rMult != null
                ? `${rMult >= 0 ? "+" : ""}${rMult.toFixed(2)}R`
                : "Floating"
              : String(item.closeReason ?? "Closed")}
          </Text>
        </View>
      </View>

      <StatRow>
        <StatTile label="Lots" value={String(n(item.volume) ?? "—")} />
        <StatTile label="Entry" value={String(n(item.entryPrice) ?? "—")} />
        <StatTile label="Current" value={String(n(item.currentPrice) ?? "—")} />
      </StatRow>
      <View style={{ height: spacing.sm }} />
      <StatRow>
        <StatTile label="Initial SL" value={String(initialSl ?? "—")} />
        <StatTile label="Current SL" value={String(currentSl ?? "—")} />
        <StatTile label="Current TP" value={String(currentTp ?? "—")} />
      </StatRow>
      <Text style={styles.meta}>Risk $ {money(item.initialRiskAmount ?? item.riskAmount)}</Text>

      {progress != null ? (
        <ProgressBar
          progress={progress}
          tone={pnl >= 0 ? "up" : "down"}
          label={`Toward TP · ${progress.toFixed(0)}%`}
        />
      ) : null}

      {item.brokerPositionId ? (
        <Text style={styles.meta}>Ticket {String(item.brokerPositionId)}</Text>
      ) : null}

      {tab === "OPEN" ? (
        editing ? (
          <View style={styles.editBlock}>
            <Text style={styles.editTitle}>Edit trade</Text>
            <TicketField label="Stop loss" value={slDraft} onChangeText={setSlDraft} />
            <TicketField
              label="Take profit"
              value={tpDraft}
              onChangeText={setTpDraft}
              hint="Blank removes TP. Manual TP overrides the original strategy target / R:R."
            />
            <Text style={styles.tpWarn}>
              Changing TP does not preserve the strategy’s planned risk/reward.
            </Text>
            <PrimaryButton
              title="Update SL / TP"
              loading={modifyPending}
              onPress={() => {
                const nextSl = Number(slDraft);
                if (!Number.isFinite(nextSl) || !(nextSl > 0)) {
                  alertMessage("Invalid stop", "Enter a valid stop loss price.");
                  return;
                }
                const tpTrim = tpDraft.trim();
                let nextTp: number | null = null;
                if (tpTrim) {
                  nextTp = Number(tpTrim);
                  if (!Number.isFinite(nextTp) || !(nextTp > 0)) {
                    alertMessage("Invalid take profit", "Enter a valid TP price, or leave blank to clear.");
                    return;
                  }
                }
                onModify(String(item.id), nextSl, nextTp);
                setEditing(false);
              }}
            />
            <PrimaryButton
              title="Cancel"
              variant="secondary"
              onPress={() => {
                setEditing(false);
                setSlDraft(String(n(item.stopLoss) ?? ""));
                setTpDraft(String(n(item.takeProfit) ?? ""));
              }}
            />
          </View>
        ) : (
          <View style={styles.actions}>
            <PrimaryButton
              title="Edit trade"
              variant="secondary"
              onPress={() => {
                setSlDraft(String(n(item.stopLoss) ?? ""));
                setTpDraft(String(n(item.takeProfit) ?? ""));
                setEditing(true);
              }}
            />
            <PrimaryButton
              title="Close position"
              variant="danger"
              loading={closePending}
              onPress={() => onClose(String(item.id))}
            />
          </View>
        )
      ) : null}
    </SoftCard>
  );
}

export default function PositionsScreen() {
  const [tab, setTab] = useState<"OPEN" | "CLOSED">("OPEN");
  const { data: accountData, refetch: refetchAccount, isRefetching: acctRefetching } = usePaperAccount();
  const { data: mt5Data, refetch: refetchMt5, isRefetching: mt5Refetching } = useMt5Status();
  const { data, isLoading, isError, error, refetch, isRefetching } = usePositions(tab);
  const closePos = useClosePosition();
  const modifyPos = useModifyPosition();
  const account = accountData?.account;
  const items = data?.items ?? [];
  const mt5 = mt5Data?.status;
  const mt5Active = Boolean(mt5?.enabled);

  async function onClose(id: string): Promise<void> {
    const ok = await confirmAsync(
      "Close position?",
      "Requests a broker/paper close. Status stays OPEN until confirmation.",
      "Close"
    );
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

  async function onModify(id: string, stopLoss: number, takeProfit: number | null): Promise<void> {
    const ok = await confirmAsync(
      "Update trade levels?",
      takeProfit == null
        ? `SL → ${stopLoss}, TP cleared. Manual levels override the original strategy target.`
        : `SL → ${stopLoss}, TP → ${takeProfit}. Manual TP overrides the original strategy R:R.`,
      "Update"
    );
    if (!ok) return;
    try {
      const res = await modifyPos.mutateAsync({ id, stopLoss, takeProfit });
      alertMessage("Modify requested", res.message ?? "Worker will update stop / take profit.");
      void refetch();
    } catch (err) {
      alertMessage("Modify failed", err instanceof Error ? err.message : "Unknown error");
    }
  }

  if (isLoading) {
    return (
      <View style={[styles.container, styles.pad]}>
        <Skeleton height={100} />
        <Skeleton height={160} />
      </View>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const equity = mt5Active ? mt5?.account?.equity : account?.equity;
  const balance = mt5Active ? mt5?.account?.balance : account?.balance;
  const openCount = mt5Active
    ? Array.isArray(mt5?.openPositions)
      ? mt5.openPositions.length
      : "—"
    : items.length;

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.pad}
      data={items}
      keyExtractor={(item) => String(item.id)}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching || acctRefetching || mt5Refetching}
          onRefresh={() => {
            void refetch();
            void refetchAccount();
            void refetchMt5();
          }}
          tintColor={colors.accent}
        />
      }
      ListHeaderComponent={
        <>
          <SoftCard>
            <HeroStat
              label={mt5Active ? "Equity · MT5 DEMO" : "Equity · Paper"}
              value={money(equity)}
              subtitle={`Balance ${money(balance)} · Open ${openCount}`}
            />
            {mt5Active ? (
              <ChipRow>
                <StatusChip
                  label={mt5?.connected ? "Connected" : "Offline"}
                  tone={mt5?.connected ? "up" : "warning"}
                />
              </ChipRow>
            ) : null}
          </SoftCard>

          <SectionHeader title="Positions" />
          <SegmentedChips
            options={[
              { id: "OPEN", label: "Open" },
              { id: "CLOSED", label: "Closed" }
            ]}
            value={tab}
            onChange={(id) => setTab(id as "OPEN" | "CLOSED")}
          />
          <View style={{ height: spacing.md }} />
        </>
      }
      ListEmptyComponent={
        <EmptyState
          title={tab === "OPEN" ? "No open positions" : "No closed positions"}
          hint="Edit stop or close from an open card. Lot size is set at entry."
        />
      }
      renderItem={({ item }) => (
        <PositionCard
          item={item}
          tab={tab}
          onClose={(id) => void onClose(id)}
          onModify={(id, sl, tp) => void onModify(id, sl, tp)}
          closePending={closePos.isPending}
          modifyPending={modifyPos.isPending}
        />
      )}
      ListFooterComponent={
        mt5Active ? (
          <Collapsible title="Paper account (fallback)">
            {account ? (
              <StatRow>
                <StatTile label="Balance" value={money(account.balance)} />
                <StatTile label="Equity" value={money(account.equity)} />
                <StatTile label="Floating" value={money(account.floatingPnl)} />
              </StatRow>
            ) : (
              <Text style={styles.dim}>No local paper account yet.</Text>
            )}
          </Collapsible>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 56 },
  cardTop: { flexDirection: "row", gap: spacing.md, marginBottom: spacing.md },
  strategyLine: { color: colors.textFaint, fontSize: font.caption, marginTop: spacing.sm },
  lockHint: { color: colors.textFaint, fontSize: font.micro, marginTop: 4, lineHeight: 14 },
  pnlBlock: { alignItems: "flex-end", minWidth: 88 },
  pnlValue: { fontSize: font.metric, fontWeight: "800" },
  pnlLabel: { color: colors.textFaint, fontSize: font.micro, marginTop: 2, fontWeight: "600" },
  meta: { color: colors.textFaint, fontSize: font.micro, marginTop: spacing.md },
  editBlock: { marginTop: spacing.md },
  editTitle: {
    color: colors.text,
    fontSize: font.title,
    fontWeight: "700",
    marginBottom: spacing.sm
  },
  tpWarn: {
    color: colors.warning,
    fontSize: font.caption,
    marginBottom: spacing.md,
    lineHeight: 17
  },
  actions: { marginTop: spacing.md, gap: spacing.xs },
  dim: { color: colors.textDim, fontSize: font.body }
});
