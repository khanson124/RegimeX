/** Structured MT5 bridge/mailbox telemetry — no secrets, no auth material. */
export type Mt5TelemetrySink = (payload: Record<string, unknown>) => void;

let telemetrySink: Mt5TelemetrySink | null = null;

export function setMt5TelemetrySink(sink: Mt5TelemetrySink | null): void {
  telemetrySink = sink;
}

const REDACT_KEY_PATTERN =
  /secret|password|token|authorization|authhmac|credential|bearer/i;

export function sanitizeMt5TelemetryPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (REDACT_KEY_PATTERN.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export function emitMt5Telemetry(payload: Record<string, unknown>): void {
  const event = sanitizeMt5TelemetryPayload({
    ...payload,
    ts: payload.ts ?? Date.now()
  });
  if (telemetrySink) {
    telemetrySink(event);
    return;
  }
  console.info(JSON.stringify(event));
}
