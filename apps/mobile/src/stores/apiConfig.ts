import * as SecureStore from "expo-secure-store";
import { create } from "zustand";

const API_URL_KEY = "regimex.apiUrl";
const WS_URL_KEY = "regimex.wsUrl";

const DEFAULT_API = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";
const DEFAULT_WS = process.env.EXPO_PUBLIC_WS_URL ?? DEFAULT_API.replace(/^http/, "ws");

interface ApiConfigState {
  apiUrl: string;
  wsUrl: string;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setUrls: (apiUrl: string, wsUrl?: string) => Promise<void>;
}

export const useApiConfigStore = create<ApiConfigState>((set, get) => ({
  apiUrl: DEFAULT_API,
  wsUrl: DEFAULT_WS,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const [storedApi, storedWs] = await Promise.all([
      SecureStore.getItemAsync(API_URL_KEY),
      SecureStore.getItemAsync(WS_URL_KEY)
    ]);
    const apiUrl = storedApi ?? DEFAULT_API;
    set({
      apiUrl,
      wsUrl: storedWs ?? apiUrl.replace(/^http/, "ws"),
      hydrated: true
    });
  },

  setUrls: async (apiUrl, wsUrl) => {
    const ws = wsUrl ?? apiUrl.replace(/^http/, "ws");
    await Promise.all([
      SecureStore.setItemAsync(API_URL_KEY, apiUrl),
      SecureStore.setItemAsync(WS_URL_KEY, ws)
    ]);
    set({ apiUrl, wsUrl: ws });
  }
}));

export function getApiUrl(): string {
  return useApiConfigStore.getState().apiUrl;
}

export function getWsUrl(): string {
  return useApiConfigStore.getState().wsUrl;
}
