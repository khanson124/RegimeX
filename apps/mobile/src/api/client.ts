import { useAuthStore } from "../stores/auth";
import { getApiUrl, getWsUrl } from "../stores/apiConfig";

export function configuredApiUrl(): string {
  return getApiUrl();
}

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
    const res = await fetch(`${getApiUrl()}/auth/refresh`, {
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

  let res: Response;
  try {
    res = await fetch(`${getApiUrl()}${path}`, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(options.body) } : {})
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network request failed";
    throw new ApiError(0, "NETWORK_ERROR", message.includes("Network") ? "Could not reach the server" : message);
  }

  if (res.status === 401 && !options.retried && !path.startsWith("/auth/")) {
    refreshPromise ??= tryRefresh().finally(() => {
      refreshPromise = null;
    });
    const refreshed = await refreshPromise;
    if (refreshed) return api<T>(path, { ...options, retried: true });
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ApiError(
        res.status,
        "INVALID_RESPONSE",
        res.ok ? "Server returned invalid JSON" : text.slice(0, 120) || `Request failed (${res.status})`
      );
    }
  }

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
  return `${getWsUrl()}/ws?token=${encodeURIComponent(token)}`;
}
