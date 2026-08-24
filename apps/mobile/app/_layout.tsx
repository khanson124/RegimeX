import React, { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Platform, View, ActivityIndicator } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { WebStyleProvider } from "../src/components/WebStyleProvider";
import { WebAppFrame } from "../src/components/WebShell";
import { useAuthStore } from "../src/stores/auth";
import { useApiConfigStore } from "../src/stores/apiConfig";
import { colors } from "../src/theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 }
  }
});

function AuthGate({ children }: { children: React.ReactNode }) {
  const { accessToken, hydrated, hydrate } = useAuthStore();
  const hydrateApi = useApiConfigStore((s) => s.hydrate);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    void Promise.all([hydrate(), hydrateApi()]);
  }, [hydrate, hydrateApi]);

  useEffect(() => {
    if (!hydrated) return;
    const inAuthGroup = segments[0] === "(auth)";
    if (!accessToken && !inAuthGroup) {
      router.replace("/(auth)/login");
    } else if (accessToken && inAuthGroup) {
      router.replace("/(tabs)");
    }
  }, [accessToken, hydrated, segments, router]);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  return <>{children}</>;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <WebStyleProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          <AuthGate>
            <WebAppFrame>
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: colors.surface },
                  headerTintColor: colors.text,
                  contentStyle: { backgroundColor: colors.bg }
                }}
              >
            <Stack.Screen name="(auth)/login" options={{ headerShown: false }} />
            <Stack.Screen name="(auth)/register" options={{ headerShown: false }} />
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="strategy/[id]" options={{ title: "Strategy" }} />
            <Stack.Screen name="backtest/[id]" options={{ title: "Backtest" }} />
            <Stack.Screen name="backtest/new" options={{ title: "New Backtest" }} />
            <Stack.Screen name="engine" options={{ title: "Live Engine" }} />
            <Stack.Screen name="positions" options={{ title: "Positions" }} />
            <Stack.Screen name="trades" options={{ title: "Legacy Demo Trades" }} />
            <Stack.Screen name="risk" options={{ title: "Risk Settings" }} />
            <Stack.Screen name="decisions" options={{ title: "Decision Log" }} />
            <Stack.Screen name="research" options={{ title: "Research" }} />
            <Stack.Screen name="optimizer" options={{ title: "Optimizer" }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
              </Stack>
            </WebAppFrame>
          </AuthGate>
        </QueryClientProvider>
      </WebStyleProvider>
    </SafeAreaProvider>
  );
}
