import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Link } from "expo-router";
import { api, ApiError } from "../../src/api/client";
import { useAuthStore } from "../../src/stores/auth";
import { Button, Card, Input } from "../../src/components/ui";
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
      setError(err instanceof ApiError ? err.message : "Could not reach the server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.inner}>
        <Text style={styles.logo}>RegimeX</Text>
        <Text style={styles.tagline}>Regime-aware demo trading lab</Text>
        <Card>
          <Input label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="you@example.com" />
          <Input label="Password" value={password} onChangeText={setPassword} secureTextEntry placeholder="••••••••••" />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button title="Log in" onPress={() => void onSubmit()} loading={loading} disabled={!email || !password} />
          <Link href="/(auth)/register" style={styles.link}>
            Create an account
          </Link>
        </Card>
        <Text style={styles.disclaimer}>
          Experimental software. Demo accounts only. No profit is promised or implied.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: "center" },
  inner: { padding: spacing.xl },
  logo: { color: colors.text, fontSize: 34, fontWeight: "800", textAlign: "center" },
  tagline: { color: colors.textDim, fontSize: font.body, textAlign: "center", marginBottom: spacing.xl },
  error: { color: colors.down, marginBottom: spacing.sm },
  link: { color: colors.accent, textAlign: "center", marginTop: spacing.md, fontSize: font.body },
  disclaimer: { color: colors.textFaint, fontSize: font.caption, textAlign: "center", marginTop: spacing.xl }
});
