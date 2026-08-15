import { useAuthStore } from "../stores/auth";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

let refreshPromise: Promise<boolean> | null = null;

/** Attempt a refresh-token rotation. Returns true when the session survives. */
async function tryRefresh(): Promise<boolean> {
  const { refreshToken, setSession, clearSession } = useAuthStore.getState();
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken })
    });
    if (!res.ok) {
      await clearSession();
      return false;
    }
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    await setSession(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch wrapper with bearer auth and single-flight 401 refresh handling.
 */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; retried?: boolean } = {}
): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const method = options.method ?? "GET";
  const hasBody = options.body !== undefined;
  const headers: Record<string, string> = {
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
  };
  // Fastify rejects Content-Type: application/json with an empty body.
  if (hasBody) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    ...(hasBody ? { body: JSON.stringify(options.body) } : {})
  });

  if (res.status === 401 && !options.retried && !path.startsWith("/auth/")) {
    refreshPromise ??= tryRefresh().finally(() => {
      refreshPromise = null;
    });
    const refreshed = await refreshPromise;
    if (refreshed) return api<T>(path, { ...options, retried: true });
  }

  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!res.ok) {
    const error = json.error as { code?: string; message?: string; details?: unknown } | undefined;
    throw new ApiError(
      res.status,
      error?.code ?? "UNKNOWN",
      error?.message ?? `Request failed (${res.status})`,
      error?.details
    );
  }
  return json as T;
}

export function wsUrl(token: string): string {
  const base = process.env.EXPO_PUBLIC_WS_URL ?? API_URL.replace(/^http/, "ws");
  return `${base}/ws?token=${encodeURIComponent(token)}`;
}
