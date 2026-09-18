/**
 * Premium fintech UI primitives shared by web + mobile.
 * Keep screen files thin — compose these instead of one-off styles.
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius, spacing } from "../theme";
import { webStyle } from "../lib/webStyles";

export function Screen({
  children,
  style
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function SoftCard({
  children,
  style,
  padded = true
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  padded?: boolean;
}) {
  return (
    <View style={[styles.softCard, !padded && styles.softCardFlush, style]}>{children}</View>
  );
}

export function SectionHeader({
  title,
  action,
  onAction
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionHeaderTitle}>{title}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} style={webStyle({ cursor: "pointer" })}>
          <Text style={styles.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function StatusChip({
  label,
  tone = "neutral"
}: {
  label: string;
  tone?: "neutral" | "up" | "down" | "warning" | "accent";
}) {
  const bg =
    tone === "up"
      ? colors.upMuted
      : tone === "down"
        ? colors.downMuted
        : tone === "warning"
          ? colors.warningMuted
          : tone === "accent"
            ? colors.accentSoft
            : colors.surfaceRaised;
  const fg =
    tone === "up"
      ? colors.up
      : tone === "down"
        ? colors.down
        : tone === "warning"
          ? colors.warning
          : tone === "accent"
            ? colors.accent
            : colors.textDim;
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <View style={[styles.chipDot, { backgroundColor: fg }]} />
      <Text style={[styles.chipText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function ChipRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.chipRow}>{children}</View>;
}

export function SegmentedChips({
  options,
  value,
  onChange
}: {
  options: Array<{ id: string; label: string; disabled?: boolean }>;
  value: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const active = opt.id === value;
        const disabled = Boolean(opt.disabled);
        return (
          <Pressable
            key={opt.id}
            onPress={() => {
              if (disabled) return;
              onChange(opt.id);
            }}
            disabled={disabled}
            style={[
              styles.segment,
              active && styles.segmentActive,
              disabled && styles.segmentDisabled,
              webStyle({ cursor: disabled ? "not-allowed" : "pointer" })
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                active && styles.segmentTextActive,
                disabled && styles.segmentTextDisabled
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function HeroStat({
  label,
  value,
  subtitle,
  tone = "neutral"
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "neutral" | "up" | "down";
}) {
  const color = tone === "up" ? colors.up : tone === "down" ? colors.down : colors.text;
  return (
    <View style={styles.heroStat}>
      <Text style={styles.heroLabel}>{label}</Text>
      <Text style={[styles.heroValue, { color }]}>{value}</Text>
      {subtitle ? <Text style={styles.heroSub}>{subtitle}</Text> : null}
    </View>
  );
}

export function StatTile({
  label,
  value,
  tone = "neutral"
}: {
  label: string;
  value: string;
  tone?: "neutral" | "up" | "down" | "warning";
}) {
  const color =
    tone === "up" ? colors.up : tone === "down" ? colors.down : tone === "warning" ? colors.warning : colors.text;
  return (
    <View style={styles.statTile}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export function StatRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.statRow}>{children}</View>;
}

export function NavListItem({
  icon,
  label,
  hint,
  onPress
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.navItem, pressed && styles.navItemPressed, webStyle({ cursor: "pointer" })]}
    >
      <View style={styles.navIconWrap}>
        <Ionicons name={icon} size={20} color={colors.accent} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.navLabel}>{label}</Text>
        {hint ? <Text style={styles.navHint}>{hint}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
    </Pressable>
  );
}

export function NavGroup({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.navGroup}>
      <Text style={styles.navGroupTitle}>{title}</Text>
      <SoftCard padded={false}>{children}</SoftCard>
    </View>
  );
}

export function Collapsible({
  title,
  children,
  defaultOpen = false,
  inline = false
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** When true, skip SoftCard wrapper (use inside an existing SoftCard). */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const body = (
    <>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={[styles.collapseHeader, webStyle({ cursor: "pointer" })]}
      >
        <Text style={styles.collapseTitle}>{title}</Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.textDim} />
      </Pressable>
      {open ? <View style={styles.collapseBody}>{children}</View> : null}
    </>
  );
  if (inline) return <View style={styles.collapseInline}>{body}</View>;
  return <SoftCard>{body}</SoftCard>;
}

export function TicketField({
  label,
  value,
  onChangeText,
  hint,
  editable = true,
  keyboardType = "decimal-pad",
  secureTextEntry = false,
  autoCapitalize
}: {
  label: string;
  value: string;
  onChangeText?: (t: string) => void;
  hint?: string;
  editable?: boolean;
  keyboardType?: "decimal-pad" | "number-pad" | "default";
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) {
  return (
    <View style={styles.ticketField}>
      <Text style={styles.ticketLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        placeholderTextColor={colors.textFaint}
        style={[styles.ticketInput, !editable && styles.ticketInputLocked]}
      />
      {hint ? <Text style={styles.ticketHint}>{hint}</Text> : null}
    </View>
  );
}

export function PrimaryButton({
  title,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  loading?: boolean;
  disabled?: boolean;
}) {
  const bg =
    variant === "danger" ? colors.danger : variant === "primary" ? colors.accent : colors.surfaceRaised;
  const fg = variant === "secondary" ? colors.text : "#FFFFFF";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.primaryBtn,
        { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.85 : 1 },
        webStyle({ cursor: disabled ? "not-allowed" : "pointer" })
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[styles.primaryBtnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

/** Compact 0–100 progress toward a target (e.g. entry → TP). */
export function ProgressBar({
  progress,
  tone = "accent",
  label
}: {
  progress: number;
  tone?: "accent" | "up" | "down" | "warning";
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, progress));
  const fill =
    tone === "up"
      ? colors.up
      : tone === "down"
        ? colors.down
        : tone === "warning"
          ? colors.warning
          : colors.accent;
  return (
    <View style={styles.progressWrap}>
      {label ? <Text style={styles.progressLabel}>{label}</Text> : null}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: fill }]} />
      </View>
    </View>
  );
}

/** Compact label/value row for settings-style detail. */
export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  softCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    marginBottom: spacing.md
  },
  softCardFlush: { padding: 0, overflow: "hidden" },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.section,
    marginBottom: spacing.sm
  },
  sectionHeaderTitle: {
    color: colors.textDim,
    fontSize: font.micro,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase"
  },
  sectionAction: { color: colors.accent, fontSize: font.caption, fontWeight: "600" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontSize: font.micro, fontWeight: "700" },
  segment: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border
  },
  segmentActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  segmentDisabled: { opacity: 0.45 },
  segmentText: { color: colors.textDim, fontSize: font.caption, fontWeight: "600" },
  segmentTextActive: { color: colors.text },
  segmentTextDisabled: { color: colors.textFaint },
  heroStat: { marginBottom: spacing.lg },
  heroLabel: { color: colors.textDim, fontSize: font.caption, fontWeight: "600", letterSpacing: 0.4 },
  heroValue: { color: colors.text, fontSize: font.hero, fontWeight: "800", marginTop: 6, letterSpacing: -0.5 },
  heroSub: { color: colors.textDim, fontSize: font.body, marginTop: 6 },
  statRow: { flexDirection: "row", gap: spacing.sm },
  statTile: {
    flex: 1,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    padding: spacing.md,
    minWidth: 90
  },
  statLabel: { color: colors.textFaint, fontSize: font.micro, fontWeight: "600", marginBottom: 4 },
  statValue: { color: colors.text, fontSize: font.metric, fontWeight: "700" },
  navGroup: { marginBottom: spacing.lg },
  navGroupTitle: {
    color: colors.textFaint,
    fontSize: font.micro,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
    marginLeft: spacing.xs
  },
  navItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  navItemPressed: { backgroundColor: colors.surfaceRaised },
  navIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center"
  },
  navLabel: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  navHint: { color: colors.textFaint, fontSize: font.caption, marginTop: 2 },
  collapseHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  collapseTitle: { color: colors.text, fontSize: font.title, fontWeight: "600" },
  collapseBody: { marginTop: spacing.md },
  collapseInline: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border
  },
  ticketField: { flex: 1, minWidth: 120, marginBottom: spacing.md },
  ticketLabel: { color: colors.textFaint, fontSize: font.micro, fontWeight: "700", marginBottom: 6 },
  ticketInput: {
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: font.body,
    fontWeight: "600"
  },
  ticketInputLocked: { opacity: 0.7 },
  ticketHint: { color: colors.textFaint, fontSize: font.micro, marginTop: 4 },
  primaryBtn: {
    borderRadius: radius.xl,
    paddingVertical: 14,
    alignItems: "center",
    marginVertical: spacing.xs
  },
  primaryBtnText: { fontSize: font.body, fontWeight: "700" },
  progressWrap: { marginTop: spacing.md },
  progressLabel: { color: colors.textFaint, fontSize: font.micro, fontWeight: "600", marginBottom: 6 },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceMuted,
    overflow: "hidden"
  },
  progressFill: { height: "100%", borderRadius: 3 },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border
  },
  infoLabel: { color: colors.textDim, fontSize: font.caption, flexShrink: 0 },
  infoValue: {
    color: colors.text,
    fontSize: font.caption,
    fontWeight: "600",
    flex: 1,
    textAlign: "right"
  }
});
