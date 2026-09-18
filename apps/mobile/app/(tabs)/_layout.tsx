import React from "react";
import { Platform } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../src/theme";
import { webLayout } from "../../src/lib/webStyles";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: {
          backgroundColor: colors.bgElevated,
          borderBottomWidth: 0,
          elevation: 0,
          shadowOpacity: 0
        },
        headerTitleStyle: { fontWeight: "700", fontSize: 17 },
        headerTintColor: colors.text,
        tabBarStyle: {
          backgroundColor: colors.bgElevated,
          borderTopColor: colors.border,
          height: Platform.OS === "web" ? 64 : undefined,
          paddingTop: 6,
          ...(Platform.OS === "web"
            ? {
                maxWidth: webLayout.appMaxWidth,
                width: "100%",
                alignSelf: "center",
                borderLeftWidth: 1,
                borderRightWidth: 1,
                borderColor: colors.border
              }
            : {})
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
        sceneStyle: { backgroundColor: colors.bg }
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" color={color} size={size} />
        }}
      />
      <Tabs.Screen
        name="market"
        options={{
          title: "Trade",
          tabBarIcon: ({ color, size }) => <Ionicons name="pulse-outline" color={color} size={size} />
        }}
      />
      <Tabs.Screen
        name="strategies"
        options={{
          href: null,
          title: "Strategies"
        }}
      />
      <Tabs.Screen
        name="backtests"
        options={{
          href: null,
          title: "Backtests"
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: ({ color, size }) => <Ionicons name="grid-outline" color={color} size={size} />
        }}
      />
    </Tabs>
  );
}
