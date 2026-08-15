import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle
} from "react-native";
import { colors, font, radius, spacing, REGIME_LABELS } from "../theme";

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Metric({
  label,
  value,
  tone = "neutral",
  large = false
}: {
  label: string;
  value: string;
  tone?: "neutral" | "up" | "down" | "warning";
  large?: boolean;
}) {
  const toneColor =
    tone === "up" ? colors.up : tone === "down" ? colors.down : tone === "warning" ? colors.warning : colors.text;
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[large ? styles.metricValueLarge : styles.metricValue, { color: toneColor }]}>
        {value}
      </Text>
    </View>
  );
}

export function Badge({ text, tone = "neutral" }: { text: string; tone?: "neutral" | "up" | "down" | "warning" | "accent" }) {
  const bg =
    tone === "up" ? "#14351F" : tone === "down" ? "#3A1416" : tone === "warning" ? "#3A2A0E" : tone === "accent" ? "#12283F" : colors.surfaceRaised;
  const fg =
    tone === "up" ? colors.up : tone === "down" ? colors.down : tone === "warning" ? colors.warning : tone === "accent" ? colors.accent : colors.textDim;
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>{text}</Text>
    </View>
  );
}

export function RegimeBadge({ regime, confidence }: { regime: string | null; confidence?: number | null }) {
  if (!regime) return <Badge text="No regime yet" />;
  const tone = regime.includes("UPTREND")
    ? "up"
    : regime.includes("DOWNTREND")
      ? "down"
      : regime === "BREAKOUT_EXPANSION"
        ? "accent"
        : "neutral";
  const label = REGIME_LABELS[regime] ?? regime;
  return <Badge tone={tone} text={confidence != null ? `${label} · ${(confidence * 100).toFixed(0)}%` : label} />;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  loading?: boolean;
}) {
  const bg = variant === "danger" ? colors.danger : variant === "primary" ? colors.accent : colors.surfaceRaised;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 }
      ]}
    >
      {loading ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <Text style={styles.buttonText}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Input(props: TextInputProps & { label?: string }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      {props.label ? <Text style={styles.inputLabel}>{props.label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        {...props}
        style={[styles.input, props.style]}
      />
    </View>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: colors.down }]}>Something went wrong</Text>
      <Text style={styles.emptyHint}>{message}</Text>
      {onRetry ? <Button title="Retry" onPress={onRetry} variant="secondary" /> : null}
    </View>
  );
}

export function Skeleton({ height = 80 }: { height?: number }) {
  return <View style={[styles.skeleton, { height }]} />;
}

export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function KeyValue({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={styles.kvValue}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md
  },
  sectionTitle: {
    color: colors.textDim,
    fontSize: font.caption,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
    marginTop: spacing.md
  },
  metric: { flex: 1, minWidth: 100, marginBottom: spacing.sm },
  metricLabel: { color: colors.textDim, fontSize: font.caption, marginBottom: 2 },
  metricValue: { color: colors.text, fontSize: font.metric, fontWeight: "700" },
  metricValueLarge: { color: colors.text, fontSize: font.metricLarge, fontWeight: "800" },
  badge: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm
  },
  badgeText: { fontSize: font.caption, fontWeight: "700" },
  button: {
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: "center",
    marginVertical: spacing.xs
  },
  buttonText: { color: colors.text, fontWeight: "700", fontSize: font.body },
  input: {
    backgroundColor: colors.surfaceRaised,
    color: colors.text,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: font.body
  },
  inputLabel: { color: colors.textDim, fontSize: font.caption, marginBottom: 4 },
  empty: { alignItems: "center", padding: spacing.xxl },
  emptyTitle: { color: colors.text, fontSize: font.title, fontWeight: "700", marginBottom: spacing.sm },
  emptyHint: { color: colors.textDim, fontSize: font.body, textAlign: "center", marginBottom: spacing.md },
  skeleton: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    opacity: 0.5
  },
  row: { flexDirection: "row", gap: spacing.md, flexWrap: "wrap" },
  kvRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  kvKey: { color: colors.textDim, fontSize: font.body },
  kvValue: { color: colors.text, fontSize: font.body, fontWeight: "600", flexShrink: 1, textAlign: "right" }
});
