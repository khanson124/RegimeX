import React from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { useRouter, type Href } from "expo-router";
import type { ComponentProps } from "react";
import { Ionicons } from "@expo/vector-icons";
import { NavGroup, NavListItem } from "../../src/components/design";
import { colors, font, spacing } from "../../src/theme";

type IconName = ComponentProps<typeof Ionicons>["name"];

type LinkItem = {
  href: Href;
  icon: IconName;
  label: string;
  hint: string;
};

const TRADING: LinkItem[] = [
  { href: "/engine", icon: "play-circle-outline", label: "Live Engine", hint: "Start, pause, symbol & mode" },
  { href: "/positions", icon: "layers-outline", label: "Positions", hint: "Open & closed · edit stop · close" },
  { href: "/risk", icon: "shield-checkmark-outline", label: "Risk Settings", hint: "Risk %, limits, lot & stop overrides" }
];

const RESEARCH: LinkItem[] = [
  { href: "/(tabs)/strategies", icon: "git-branch-outline", label: "Strategies", hint: "Library · enable / disable" },
  { href: "/(tabs)/backtests", icon: "flask-outline", label: "Backtests", hint: "Historical simulations" },
  { href: "/research", icon: "analytics-outline", label: "Research", hint: "Walk-forward · confidence" },
  { href: "/optimizer", icon: "options-outline", label: "Optimizer", hint: "Parameter grid search" }
];

const SYSTEM: LinkItem[] = [
  { href: "/settings", icon: "settings-outline", label: "Settings", hint: "Deriv market data · venue · logout" },
  { href: "/decisions", icon: "document-text-outline", label: "Decision Log", hint: "Why trades fired or blocked" },
  { href: "/trades", icon: "swap-horizontal-outline", label: "Legacy Demo Trades", hint: "Archived binary contracts" }
];

export default function MoreScreen() {
  const router = useRouter();

  function renderGroup(title: string, items: LinkItem[]) {
    return (
      <NavGroup title={title}>
        {items.map((link) => (
          <NavListItem
            key={link.label}
            icon={link.icon}
            label={link.label}
            hint={link.hint}
            onPress={() => router.push(link.href)}
          />
        ))}
      </NavGroup>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.pad}>
      <Text style={styles.lead}>Trading, research, and system</Text>
      {renderGroup("Trading", TRADING)}
      {renderGroup("Research", RESEARCH)}
      {renderGroup("System", SYSTEM)}
      <Text style={styles.disclaimer}>
        RegimeX is experimental CFD research. MT5 DEMO is primary; paper is fallback. Live money is disabled.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  pad: { padding: spacing.lg, paddingBottom: 56 },
  lead: {
    color: colors.textDim,
    fontSize: font.body,
    marginBottom: spacing.xl,
    marginTop: spacing.sm
  },
  disclaimer: {
    color: colors.textFaint,
    fontSize: font.micro,
    textAlign: "center",
    marginTop: spacing.md,
    lineHeight: 16
  }
});
