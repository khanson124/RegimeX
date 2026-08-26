import { MT5_BRIDGE_TIMEOUT, MT5_BRIDGE_UNAVAILABLE } from "./bridgeCircuit.js";

export interface Mt5BridgeLiveProbe {
  ok: boolean;
  statusCode: number | null;
  errorCode: string | null;
  latencyMs: number;
}

export async function probeMt5BridgeLive(
  baseUrl: string,
  timeoutMs = 2_000,
  fetchImpl: typeof fetch = fetch
): Promise<Mt5BridgeLiveProbe> {
  const url = `${baseUrl.replace(/\/$/, "")}/health/live`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, statusCode: res.status, errorCode: MT5_BRIDGE_UNAVAILABLE, latencyMs };
    }
    return { ok: true, statusCode: res.status, errorCode: null, latencyMs };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      statusCode: null,
      errorCode: aborted ? MT5_BRIDGE_TIMEOUT : MT5_BRIDGE_UNAVAILABLE,
      latencyMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

export function classifyBridgeFetchError(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return MT5_BRIDGE_TIMEOUT;
  const message = err instanceof Error ? err.message : String(err);
  if (/aborted|timeout|Timeout/i.test(message)) return MT5_BRIDGE_TIMEOUT;
  return MT5_BRIDGE_UNAVAILABLE;
}
