import "dotenv/config";
import { z } from "zod";

export * from "./crypto.js";
export * from "./redis.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  /** Seconds. */
  ACCESS_TOKEN_TTL: z.coerce.number().int().default(900),
  /** Seconds. */
  REFRESH_TOKEN_TTL: z.coerce.number().int().default(60 * 60 * 24 * 30),
  /** 32-byte key, hex or base64, for AES-256-GCM credential encryption. */
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32),
  DERIV_APP_ID: z.string().default("1089"),
  DERIV_REST_URL: z.string().url().default("https://api.derivws.com"),
  DERIV_WS_URL: z
    .string()
    .url()
    .default("wss://api.derivws.com/trading/v1/options/ws/public"),
  MOBILE_APP_URL: z.string().default("regimex://"),
  CORS_ORIGINS: z.string().default("*"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Feature flag: ensemble strategy voting. */
  FEATURE_ENSEMBLE_VOTING: z.coerce.boolean().default(false),
  /** Hard switch: demo trade execution. Defaults OFF. */
  DEMO_TRADING_ENABLED: z.coerce.boolean().default(false),
  /** Optimizer safety threshold before confirmation is required. */
  OPTIMIZER_MAX_COMBINATIONS: z.coerce.number().int().default(200),
  ENGINE_VERSION: z.string().default("0.1.0")
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | null = null;

/**
 * Load and validate environment configuration. Fails fast with a readable
 * message listing every missing/invalid variable.
 */
export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  if (cached && Object.keys(overrides).length === 0) return cached;
  const parsed = envSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (Object.keys(overrides).length === 0) cached = parsed.data;
  return parsed.data;
}

/** Test helper. */
export function resetConfigCache(): void {
  cached = null;
}
