import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Card } from "../../src/components/ui";
import { colors, font, spacing } from "../../src/theme";

const LINKS: Array<{ href: Href; icon: keyof typeof Ionicons.glyphMap; label: string; hint: string }> = [
  { href: "/engine", icon: "play-circle-outline", label: "Live Engine", hint: "Start, pause, analysis or CFD demo trading" },
  { href: "/positions", icon: "layers-outline", label: "Positions", hint: "MT5 DEMO / paper CFD positions, floating P/L, close" },
  { href: "/risk", icon: "shield-checkmark-outline", label: "Risk Settings", hint: "Risk % of equity, loss limits, cooldowns" },
  { href: "/settings", icon: "settings-outline", label: "Settings", hint: "Market data (Deriv API), execution venue, account" },
  { href: "/decisions", icon: "document-text-outline", label: "Decision Log", hint: "Why the engine traded or did not trade" },
  { href: "/research", icon: "analytics-outline", label: "Research", hint: "Walk-forward validation, holdout, confidence scores" },
  { href: "/optimizer", icon: "options-outline", label: "Optimizer", hint: "Grid-search strategy parameters" },
  { href: "/trades", icon: "swap-horizontal-outline", label: "Legacy Demo Trades", hint: "Archived binary options contracts (read-only)" }
];

export default function MoreScreen() {
  const router = useRouter();
  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
      {LINKS.map((link) => (
        <Pressable key={link.label} onPress={() => router.push(link.href)}>
          <Card>
            <View style={styles.row}>
              <Ionicons name={link.icon} size={22} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>{link.label}</Text>
                <Text style={styles.hint}>{link.hint}</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </View>
          </Card>
        </Pressable>
      ))}
      <Text style={styles.disclaimer}>
        RegimeX is an experimental CFD research tool. Primary forward path is MT5 DEMO; paper CFD is fallback.
        Live-money trading is disabled. Past performance does not guarantee future results.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  label: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  hint: { color: colors.textDim, fontSize: font.caption, marginTop: 2 },
  disclaimer: { color: colors.textFaint, fontSize: font.caption, textAlign: "center", marginTop: spacing.lg, lineHeight: 18 }
});
