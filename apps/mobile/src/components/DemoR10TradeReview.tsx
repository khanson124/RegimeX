import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { DemoR10Review, DemoR10ReviewGroup, DemoR10ReviewMetrics } from "../api/hooks";
import { Collapsible, SoftCard, StatRow, StatTile } from "./design";
import { colors, font, spacing } from "../theme";
import { DemoR10SqueezeEntryAudit } from "./DemoR10SqueezeEntryAudit";
const fixed = (n: number | null, digits = 2) => n == null ? "—" : n.toFixed(digits);
const labels: Record<string, string> = { MANUAL: "Recorded manual closes", AUTOMATIC: "Recorded automatic exits",
  SAFETY: "Safety exits", UNKNOWN: "Unclassified", AUTO_ORIGINAL: "AUTO original selection",
  AUTO_FALLBACK: "AUTO HOLD fallback", SINGLE: "Single strategy", ENSEMBLE: "Ensemble",
  ENABLED: "Recorded enabled", DISABLED: "Recorded disabled", UNRECORDED: "Not recorded" };
function Outcome({ title, value }: { title: string; value: DemoR10ReviewMetrics }) {
  return <View style={styles.outcome}>
    <Text style={styles.label}>{title} · {value.trades} closed</Text>
    <StatRow>
      <StatTile label="Stored P&L" value={fixed(value.netPnl)} tone={value.netPnl == null ? "neutral" : value.netPnl >= 0 ? "up" : "down"} />
      <StatTile label="Win rate" value={value.winRate == null ? "—" : `${(value.winRate * 100).toFixed(1)}%`} />
      <StatTile label="Profit factor" value={fixed(value.profitFactor)} />
    </StatRow>
    <Text style={styles.note}>{value.wins} wins · {value.losses} losses · {value.pushes} flat · Average P&L {fixed(value.expectancy)} · Average R {fixed(value.expectancyR)}</Text>
    {value.missingPnl > 0 ? <Text style={styles.note}>{value.missingPnl} missing P&L excluded.</Text> : null}
    {value.riskValuedTrades < value.valuedTrades ? <Text style={styles.note}>R available for {value.riskValuedTrades}/{value.valuedTrades} valued trades.</Text> : null}
  </View>;
}
function Breakdown({ title, groups }: { title: string; groups: DemoR10ReviewGroup[] }) {
  return <Collapsible title={title} inline>
    {groups.filter(g => g.trades > 0).map(g => <View key={g.key}>
      <Outcome title={labels[g.key] ?? g.key} value={g} />
      <Text style={styles.note}>{g.exits.map(e => `${labels[e.key] ?? e.key}: ${e.trades} / P&L ${fixed(e.netPnl)}`).join(" · ")}</Text>
    </View>)}
  </Collapsible>;
}
export function DemoR10TradeReview({ review, asOf }: { review: DemoR10Review; asOf: string }) {
  return <SoftCard>
    <Text style={styles.title}>R_10 DEMO trade review</Text>
    <Text style={styles.note}>Engine entries · 1m · {review.hasMore ? `Latest ${review.limit}` : review.sampledClosedTrades} closed trades. Separate from LIVE and manual entries.</Text>
    <Text style={styles.note}>Updated {new Date(asOf).toLocaleString()}</Text>
    {review.firstCloseAt && review.lastCloseAt ? <Text style={styles.note}>Closes {new Date(review.firstCloseAt).toLocaleDateString()} – {new Date(review.lastCloseAt).toLocaleDateString()}</Text> : null}
    {review.sampledClosedTrades === 0 ? <Text style={styles.note}>No closed R_10 DEMO engine trades recorded.</Text> : <>
      <Outcome title="All recorded exits" value={review.overall} />
      {review.exits.filter(g => g.trades > 0 || g.key === "MANUAL" || g.key === "AUTOMATIC").map(g => <Outcome key={g.key} title={labels[g.key] ?? g.key} value={g} />)}
      <Collapsible title="By strategy and version" inline>
        {review.strategies.map(g => <View key={g.key}>
          <Outcome title={`${g.strategyId} · v${g.strategyVersion ?? "unknown"}`} value={g} />
          {g.exits.filter(e => e.trades > 0).map(e => <Text key={e.key} style={styles.note}>{labels[e.key]}: {e.trades} / P&L {fixed(e.netPnl)}</Text>)}
        </View>)}
      </Collapsible>
      <Breakdown title="Loss bypass at entry" groups={review.lossBypass} />
      <Breakdown title="Trade experiment at entry" groups={review.tradeExperiment} />
      <Breakdown title="Recorded strategy selection" groups={review.selection} />
      {review.squeezeEntryAudit ? <DemoR10SqueezeEntryAudit audit={review.squeezeEntryAudit} /> : null}
    </>}
    <Text style={styles.note}>Stored realized P&L; no added cost estimate. Profit factor is unavailable when there are no losses. Missing history stays unclassified.</Text>
    <Text style={styles.note}>These groups describe recorded exits, not what the same trades would have earned without manual closes. Stops and targets may also have been edited.</Text>
  </SoftCard>;
}
const styles = StyleSheet.create({ title: { color: colors.text, fontSize: font.title, fontWeight: "700" },
  label: { color: colors.text, fontSize: font.body, fontWeight: "600", marginBottom: spacing.xs },
  note: { color: colors.textDim, fontSize: font.caption, lineHeight: 18, marginTop: spacing.xs },
  outcome: { marginTop: spacing.md } });
