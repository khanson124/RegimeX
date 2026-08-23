import { Alert, Platform } from "react-native";

/** Cross-platform confirm dialog (Alert on native, window.confirm on web). */
export function confirmAsync(title: string, message: string, confirmLabel = "OK"): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, onPress: () => resolve(true) }
    ]);
  });
}

/** Cross-platform alert (Alert on native, window.alert on web). */
export function alertMessage(title: string, message?: string): void {
  if (Platform.OS === "web") {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}
