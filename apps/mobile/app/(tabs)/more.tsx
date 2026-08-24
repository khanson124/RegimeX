import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Card } from "../../src/components/ui";
import { colors, font, spacing } from "../../src/theme";

const LINKS: Array<{ href: Href; icon: keyof typeof Ionicons.glyphMap; label: string; hint: string }> = [
  { href: "/engine", icon: "play-circle-outline", label: "Live Engine", hint: "Start, pause, configure analysis or paper CFD trading" },
  { href: "/positions", icon: "layers-outline", label: "Open Positions", hint: "Paper CFD positions, floating P/L, manual close" },
  { href: "/trades", icon: "swap-horizontal-outline", label: "Legacy Demo Trades", hint: "Historical binary demo contracts (read-only)" },
  { href: "/risk", icon: "shield-checkmark-outline", label: "Risk Settings", hint: "Risk %, loss limits, cooldowns, session hours" },
  { href: "/decisions", icon: "document-text-outline", label: "Decision Log", hint: "Why the engine traded or did not trade" },
  { href: "/research", icon: "analytics-outline", label: "Research", hint: "Walk-forward validation, holdout, confidence scores" },
  { href: "/optimizer", icon: "options-outline", label: "Optimizer", hint: "Grid-search strategy parameters" },
  { href: "/settings", icon: "settings-outline", label: "Settings", hint: "Deriv connection, data, account" }
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
        RegimeX is an experimental research tool for Deriv demo accounts only. Live-money trading is disabled.
        Past performance, simulated or real, does not guarantee future results.
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
