import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Link } from "expo-router";
import { api, ApiError, configuredApiUrl } from "../../src/api/client";
import { WebShell } from "../../src/components/WebShell";
import { useAuthStore } from "../../src/stores/auth";
import { Button, Card, Input } from "../../src/components/ui";
import { webStyle } from "../../src/lib/webStyles";
import { colors, font, spacing } from "../../src/theme";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setSession = useAuthStore((s) => s.setSession);

  async function onSubmit(): Promise<void> {
    setError(null);
    setLoading(true);
    try {
      const res = await api<{ accessToken: string; refreshToken: string; user: { email: string } }>(
        "/auth/login",
        { method: "POST", body: { email: email.trim(), password } }
      );
      await setSession(res.accessToken, res.refreshToken, res.user.email);
    } catch (err) {
      const detail = err instanceof ApiError ? err.message : "Could not reach the server";
      setError(`${detail}\n\nAPI: ${configuredApiUrl()}`);
    } finally {
      setLoading(false);
    }
  }

  const form = (
    <>
      <Text style={styles.logo}>RegimeX</Text>
      <Text style={styles.tagline}>Regime-aware CFD research lab · MT5 DEMO</Text>
      <Card style={styles.card}>
        <Input label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="you@example.com" />
        <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••••••" />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button title="Log in" onPress={() => void onSubmit()} loading={loading} disabled={!email || !password} />
        <Link href="/(auth)/register" style={styles.link}>
          Create an account
        </Link>
      </Card>
      <Text style={styles.disclaimer}>
        Experimental software. CFD / MT5 DEMO only — not binary options. No profit is promised.
      </Text>
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
  logo: {
    color: colors.text,
    fontSize: 34,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.5
  },
  tagline: { color: colors.textDim, fontSize: font.body, textAlign: "center", marginBottom: spacing.lg },
  card: webStyle({
    marginBottom: 0,
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.35)"
  }),
  error: { color: colors.down, marginBottom: spacing.sm, lineHeight: 20 },
  link: { color: colors.accent, textAlign: "center", marginTop: spacing.md, fontSize: font.body, fontWeight: "600" },
  disclaimer: {
    color: colors.textFaint,
    fontSize: font.caption,
    textAlign: "center",
    marginTop: spacing.xl,
    lineHeight: 18,
    maxWidth: 360,
    alignSelf: "center"
  }
});
