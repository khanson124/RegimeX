import React from "react";
import { Platform, ScrollView, StyleSheet, View, type ViewStyle } from "react-native";
import { colors } from "../theme";
import { webLayout } from "../lib/webStyles";

interface WebShellProps {
  children: React.ReactNode;
  /** Narrow centered column for auth forms. */
  narrow?: boolean;
  style?: ViewStyle;
}

/**
 * Centers content on wide viewports in the browser.
 * On native, renders children unchanged.
 */
export function WebShell({ children, narrow = false, style }: WebShellProps) {
  if (Platform.OS !== "web") {
    return <>{children}</>;
  }

  return (
    <ScrollView
      contentContainerStyle={[styles.scroll, narrow && styles.scrollNarrow, style]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[styles.frame, narrow ? styles.frameNarrow : styles.frameApp]}>{children}</View>
    </ScrollView>
  );
}

/** Constrains main app screens to a readable width on desktop. */
export function WebAppFrame({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== "web") {
    return <>{children}</>;
  }

  return (
    <View style={styles.appOuter}>
      <View style={styles.appInner}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    minHeight: "100%",
    backgroundColor: colors.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: webLayout.pagePadding
  },
  scrollNarrow: {
    backgroundColor: colors.bg
  },
  frame: {
    width: "100%"
  },
  frameNarrow: {
    maxWidth: webLayout.authMaxWidth
  },
  frameApp: {
    maxWidth: webLayout.appMaxWidth
  },
  appOuter: {
    flex: 1,
    width: "100%",
    backgroundColor: colors.bg,
    alignItems: "center"
  },
  appInner: {
    flex: 1,
    width: "100%",
    maxWidth: webLayout.appMaxWidth
  }
});
