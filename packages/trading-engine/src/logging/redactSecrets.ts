const TOKEN_QUERY_KEYS = /(?:token|access_token|refresh_token|jwt|authorization|secret|password|apiToken|bridgeSecret)=([^&]*)/gi;

/** Strip JWTs / secrets from URLs so request logs cannot leak bearer tokens. */
export function redactSensitiveUrl(url: string | undefined | null): string {
  if (!url) return "";
  let out = url.replace(TOKEN_QUERY_KEYS, (match) => {
    const eq = match.indexOf("=");
    return `${match.slice(0, eq + 1)}[REDACTED]`;
  });
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+=/]+/gi, "Bearer [REDACTED]");
  return out;
}

export function redactSensitiveObject(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveUrl(value);
  if (Array.isArray(value)) return value.map(redactSensitiveObject);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|password|secret|authorization|jwt/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSensitiveObject(v);
      }
    }
    return out;
  }
  return value;
}

export function containsSensitiveQuery(url: string | undefined | null): boolean {
  if (!url) return false;
  return /[?&](?:token|access_token|refresh_token)=/i.test(url);
}
