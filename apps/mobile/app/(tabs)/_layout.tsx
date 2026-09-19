import React from "react";
import { Platform } from "react-native";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../../src/theme";
import { webLayout } from "../../src/lib/webStyles";

const TAB_BAR_CONTENT_HEIGHT = 56;

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  // Android edge-to-edge draws under the system nav; without this the tab bar
  // sits under the gesture/3-button bar and becomes untappable.
  const bottomInset = Platform.OS === "web" ? 0 : Math.max(insets.bottom, Platform.OS === "android" ? 16 : 0);

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
          height: Platform.OS === "web" ? 64 : TAB_BAR_CONTENT_HEIGHT + bottomInset,
          paddingTop: 6,
          paddingBottom: bottomInset,
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
        tabBarSafeAreaInsets: { bottom: 0 },
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
