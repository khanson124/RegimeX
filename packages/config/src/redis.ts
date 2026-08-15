/** Options shared by API and worker Redis / BullMQ connections. */
export interface RedisConnectionOptions {
  maxRetriesPerRequest: null;
  tls?: Record<string, never>;
}

/**
 * Redis / BullMQ connection options for managed hosts (Render Key Value, Upstash, etc.).
 * Enables TLS when the URL uses the `rediss:` scheme.
 */
export function redisConnectionOptions(redisUrl: string): RedisConnectionOptions {
  const url = new URL(redisUrl);
  const tls = url.protocol === "rediss:" ? {} : undefined;
  return {
    maxRetriesPerRequest: null,
    ...(tls ? { tls } : {})
  };
}
