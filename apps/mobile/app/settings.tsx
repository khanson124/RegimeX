import React, { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import { ApiError } from "../src/api/client";
import {
  useConnectDeriv,
  useDerivAccount,
  useDisconnectDeriv,
  useDownloadMarketData,
  useTestDerivConnection
} from "../src/api/hooks";
import { useAuthStore } from "../src/stores/auth";
import { Badge, Button, Card, ErrorView, Input, KeyValue, SectionTitle, Skeleton } from "../src/components/ui";
import { colors, font, spacing } from "../src/theme";

export default function SettingsScreen() {
  const { data, isLoading, isError, error, refetch } = useDerivAccount();
  const connect = useConnectDeriv();
  const disconnect = useDisconnectDeriv();
  const testConn = useTestDerivConnection();
  const download = useDownloadMarketData();
  const clearSession = useAuthStore((s) => s.clearSession);
  const router = useRouter();

  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <Skeleton height={140} />
        <Skeleton height={200} />
      </ScrollView>
    );
  }
  if (isError) {
    return <ErrorView message={error instanceof Error ? error.message : "Failed to load"} onRetry={() => void refetch()} />;
  }

  const account = data?.account ?? null;

  function connectToken(): void {
    setFormError(null);
    if (!token.trim()) {
      setFormError("Enter your Deriv demo API token");
      return;
    }
    connect.mutate(token.trim(), {
      onSuccess: () => {
        setToken("");
        Alert.alert("Connected", "Demo account linked. Token is stored encrypted on the server.");
      },
      onError: (err) => setFormError(err instanceof ApiError ? err.message : "Connection failed")
    });
  }

  function confirmDisconnect(): void {
    Alert.alert("Disconnect Deriv?", "The encrypted token will be revoked on the server.", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => disconnect.mutate() }
    ]);
  }

  function confirmLogout(): void {
    Alert.alert("Log out?", undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Log out",
        style: "destructive",
        onPress: () => {
          void clearSession();
          router.replace("/(auth)/login");
        }
      }
    ]);
  }

  function seedHistory(): void {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    download.mutate(
      { symbol: "R_10", interval: "1m", from, to },
      {
        onSuccess: () => Alert.alert("Queued", "Historical candle download job queued."),
        onError: (err) => Alert.alert("Failed", err instanceof ApiError ? err.message : "Download failed")
      }
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}>
      <SectionTitle>Deriv demo account</SectionTitle>
      <Card>
        {account ? (
          <>
            <Badge tone="up" text="Demo account connected" />
            <KeyValue k="Login ID" v={account.loginId} />
            <KeyValue k="Currency" v={account.currency} />
            <KeyValue k="Balance" v={account.balance != null ? account.balance.toFixed(2) : "—"} />
            <KeyValue k="Account type" v={account.isVirtual ? "Virtual (demo)" : "Live — blocked"} />
            <Button
              title="Test connection"
              variant="secondary"
              onPress={() => testConn.mutate()}
              loading={testConn.isPending}
            />
            <Button title="Disconnect" variant="danger" onPress={confirmDisconnect} loading={disconnect.isPending} />
          </>
        ) : (
          <>
            <Text style={styles.hint}>
              Paste a Deriv demo API token. Only virtual accounts are accepted. The token is encrypted server-side
              and never returned to this app after submission.
            </Text>
            <Input
              label="Deriv demo API token"
              value={token}
              onChangeText={setToken}
              secureTextEntry
              autoCapitalize="none"
            />
            {formError ? <Text style={styles.error}>{formError}</Text> : null}
            <Button title="Connect demo account" onPress={connectToken} loading={connect.isPending} />
          </>
        )}
      </Card>

      <SectionTitle>Data management</SectionTitle>
      <Card>
        <Text style={styles.hint}>Queue a 7-day historical candle download for R_10 (1m) from Deriv.</Text>
        <Button title="Download sample history" variant="secondary" onPress={seedHistory} loading={download.isPending} />
      </Card>

      <SectionTitle>Account</SectionTitle>
      <Card>
        <Pressable onPress={confirmLogout}>
          <Text style={styles.logout}>Log out</Text>
        </Pressable>
      </Card>

      <Text style={styles.disclaimer}>
        RegimeX is for research on Deriv synthetic indices using demo accounts only. Past performance does not
        guarantee future results.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  hint: { color: colors.textDim, fontSize: font.caption, marginBottom: spacing.sm, lineHeight: 18 },
  error: { color: colors.down, fontSize: font.caption, marginBottom: spacing.sm },
  logout: { color: colors.down, fontSize: font.body, fontWeight: "700", textAlign: "center", paddingVertical: spacing.sm },
  disclaimer: { color: colors.textFaint, fontSize: font.caption, textAlign: "center", marginTop: spacing.lg, lineHeight: 18 }
});
