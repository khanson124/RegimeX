import React, { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Link } from "expo-router";
import { api, ApiError } from "../../src/api/client";
import { useAuthStore } from "../../src/stores/auth";
import { Button, Card, Input } from "../../src/components/ui";
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

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={styles.inner}>
        <Text style={styles.logo}>Create account</Text>
        <Card>
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
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, justifyContent: "center" },
  inner: { padding: spacing.xl },
  logo: { color: colors.text, fontSize: 26, fontWeight: "800", textAlign: "center", marginBottom: spacing.lg },
  error: { color: colors.down, marginBottom: spacing.sm },
  link: { color: colors.accent, textAlign: "center", marginTop: spacing.md, fontSize: font.body }
});
