import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { DemoR10ReviewMetrics, DemoR10SqueezeEntryAudit as Audit } from "../api/hooks";
import { Collapsible, StatRow, StatTile } from "./design";
import { colors, font, spacing } from "../theme";
const n = (v: number | null) => v == null ? "—" : v.toFixed(2);
const outcome = (m: DemoR10ReviewMetrics) => `${m.trades} trades · ${m.wins}W/${m.losses}L/${m.pushes} flat · P&L ${n(m.netPnl)} · Average R ${n(m.expectancyR)}${m.missingPnl ? ` · ${m.missingPnl} missing P&L` : ""}`;
export function DemoR10SqueezeEntryAudit({ audit }: { audit: Audit }) {
  return <Collapsible title="Squeeze entry conditions (research)" inline>
    <Text style={styles.note}>Automatic exits only; {audit.excludedManualTrades} manual and {audit.excludedSafetyOrUnknownTrades} safety/unclassified closes excluded. Fixed descriptive bins; entry rules are unchanged.</Text>
    {audit.hasMore ? <Text style={styles.note}>Uses the bounded trade-review sample. Earlier history may be truncated.</Text> : null}
    {audit.versions.length === 0 ? <Text style={styles.note}>No automatic squeeze exits in this sample.</Text> : null}
    {audit.versions.map(v => <View key={JSON.stringify(v.strategyVersion)} style={styles.version}>
      <Text style={styles.label}>squeeze-breakout-v1 · v{v.strategyVersion ?? "unknown"}</Text>
      <StatRow>
        <StatTile label={`Recent ${v.recent.trades} P&L`} value={n(v.recent.netPnl)} />
        <StatTile label={`Earlier ${v.earlier.trades} P&L`} value={n(v.earlier.netPnl)} />
        <StatTile label="Recent average R" value={n(v.recent.expectancyR)} />
      </StatRow>
      <Text style={styles.note}>Recent: {outcome(v.recent)}</Text>
      <Text style={styles.note}>Earlier: {outcome(v.earlier)}</Text>
      {v.recent.firstCloseAt && v.recent.lastCloseAt ? <Text style={styles.note}>Recent closes: {new Date(v.recent.firstCloseAt).toLocaleDateString()} – {new Date(v.recent.lastCloseAt).toLocaleDateString()}</Text> : null}
      {v.undatedTrades > 0 ? <Text style={styles.note}>{v.undatedTrades} undated closes excluded from the recent/earlier comparison.</Text> : null}
      {v.dimensions.map(d => <Collapsible key={d.key} title={d.label} inline>
        <Text style={styles.note}>Available: recent {d.recentCovered}/{v.recent.trades}; earlier {d.earlierCovered}/{v.earlier.trades}. Each dimension is a separate view of the same trades.</Text>
        {d.buckets.filter(b => b.recent.trades > 0 || b.earlier.trades > 0).map(b => <View key={b.key} style={styles.bucket}>
          <Text style={styles.label}>{b.key === "UNKNOWN" ? "Missing or invalid snapshot" : b.key}</Text>
          <Text style={styles.note}>Recent: {outcome(b.recent)}</Text>
          <Text style={styles.note}>Earlier: {outcome(b.earlier)}</Text>
        </View>)}
      </Collapsible>)}
    </View>)}
    <Text style={styles.note}>Small cohorts and manual stop/target edits can distort comparisons. These are recorded outcomes, not a replay or a recommended filter.</Text>
  </Collapsible>;
}
const styles = StyleSheet.create({ note: { color: colors.textDim, fontSize: font.caption, lineHeight: 18, marginTop: spacing.xs },
  label: { color: colors.text, fontSize: font.body, fontWeight: "600", marginBottom: spacing.xs },
  version: { marginTop: spacing.md }, bucket: { marginTop: spacing.sm } });
