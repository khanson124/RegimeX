import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Link } from "expo-router";
import { api, ApiError } from "../../src/api/client";
import { WebShell } from "../../src/components/WebShell";
import { useAuthStore } from "../../src/stores/auth";
import { Button, Card, Input } from "../../src/components/ui";
import { webStyle } from "../../src/lib/webStyles";
import { colors, font, spacing } from "../../src/theme";

export default function RegisterScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setSession = useAuthStore((s) => s.setSession);

  async function onSubmit(): Promise<void> {
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ accessToken: string; refreshToken: string; user: { email: string } }>(
        "/auth/register",
        { method: "POST", body: { email: email.trim(), password } }
      );
      await setSession(res.accessToken, res.refreshToken, res.user.email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  const form = (
    <>
      <Text style={styles.logo}>Create account</Text>
      <Card style={styles.card}>
        <Input label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="you@example.com" />
        <Input
          label="Password (10+ chars, upper/lower/digit)"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="••••••••••"
        />
        <Input label="Confirm password" value={confirm} onChangeText={setConfirm} secureTextEntry placeholder="••••••••••" />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Register" onPress={() => void onSubmit()} loading={loading} disabled={!email || !password} />
        <Link href="/(auth)/login" style={styles.link}>
          Back to login
        </Link>
      </Card>
    </>
  );

  if (Platform.OS === "web") {
    return <WebShell narrow>{form}</WebShell>;
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.inner}>{form}</View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: "center" },
  inner: { padding: spacing.xl },
  logo: { color: colors.text, fontSize: 26, fontWeight: "800", textAlign: "center", marginBottom: spacing.lg },
  card: webStyle({ marginBottom: 0, boxShadow: "0 8px 32px rgba(0, 0, 0, 0.35)" }),
  error: { color: colors.down, marginBottom: spacing.sm },
  link: { color: colors.accent, textAlign: "center", marginTop: spacing.md, fontSize: font.body, fontWeight: "600" }
});
