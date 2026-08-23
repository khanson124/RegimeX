import { create } from "zustand";
import { deleteSecureItem, getSecureItem, setSecureItem } from "../lib/secureStorage";

const ACCESS_KEY = "regimex.accessToken";
const REFRESH_KEY = "regimex.refreshToken";

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  userEmail: string | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setSession: (access: string, refresh: string, email?: string | null) => Promise<void>;
  clearSession: () => Promise<void>;
}

/**
 * Auth/session store. Tokens live in SecureStore only — never AsyncStorage.
 * The in-memory copy exists so the API client can read synchronously.
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  accessToken: null,
  refreshToken: null,
  userEmail: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const [access, refresh] = await Promise.all([
      getSecureItem(ACCESS_KEY),
      getSecureItem(REFRESH_KEY)
    ]);
    set({ accessToken: access, refreshToken: refresh, hydrated: true });
  },

  setSession: async (access, refresh, email = null) => {
    await Promise.all([
      setSecureItem(ACCESS_KEY, access),
      setSecureItem(REFRESH_KEY, refresh)
    ]);
    set({ accessToken: access, refreshToken: refresh, ...(email ? { userEmail: email } : {}) });
  },

  clearSession: async () => {
    await Promise.all([
      deleteSecureItem(ACCESS_KEY),
      deleteSecureItem(REFRESH_KEY)
    ]);
    set({ accessToken: null, refreshToken: null, userEmail: null });
  }
}));
