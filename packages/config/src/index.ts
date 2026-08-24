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
  /**
   * CFD execution backend:
   * - paper_cfd: simulated PaperCFDBrokerAdapter (default)
   * - broker_demo_cfd: Deriv cTrader Open API DEMO
   * - broker_demo_mt5: Deriv MT5 DEMO via local EA/bridge (no public ports)
   * - broker_real_cfd / broker_real_mt5: MUST remain unimplemented
   * - legacy_binary: quarantined options path
   */
  EXECUTION_MODE: z
    .enum([
      "paper_cfd",
      "broker_demo_cfd",
      "broker_demo_mt5",
      "broker_real_cfd",
      "broker_real_mt5",
      "legacy_binary"
    ])
    .default("paper_cfd"),
  /** Must remain false. Real-money path is architecture-only. */
  REAL_MONEY_ENABLED: z.coerce.boolean().default(false),
  /** Quarantined legacy Deriv rise/fall options path. Defaults OFF. */
  LEGACY_BINARY_ENABLED: z.coerce.boolean().default(false),
  /** Initial balance for new paper CFD accounts (not Deriv options balance). */
  PAPER_INITIAL_BALANCE: z.coerce.number().positive().default(10_000),
  /** Global fallback paper spread/slippage when instrument metadata omits overrides. */
  PAPER_SPREAD_BPS: z.coerce.number().min(0).default(10),
  PAPER_SLIPPAGE_BPS: z.coerce.number().min(0).default(5),
  /**
   * Max age of a quote for paper open/close/liquidation (ms).
   * Aligns with risk maxDataAgeSeconds default (30s). Fail closed / defer when stale.
   */
  MAX_EXECUTION_QUOTE_AGE_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Live strategy selection mode:
   * - bootstrap: regime-fit only (cold start)
   * - validated: CFD research + forward-paper evidence when available; falls back to bootstrap
   * Default remains bootstrap — do not enable validated until research evidence exists.
   */
  STRATEGY_SELECTION_MODE: z.enum(["bootstrap", "validated"]).default("bootstrap"),
  /** Required acknowledgement string for broker_real_cfd — do not set in .env.example. */
  BROKER_REAL_ACK: z.string().optional(),
  BROKER_REAL_ACCOUNT_ID: z.string().optional(),
  /** cTrader Open API credentials for broker_demo_cfd (optional until provisioned). */
  CTRADER_CLIENT_ID: z.string().optional(),
  CTRADER_CLIENT_SECRET: z.string().optional(),
  CTRADER_ACCOUNT_ID: z.string().optional(),
  CTRADER_ACCESS_TOKEN: z.string().optional(),
  /** demo | live — broker_demo_cfd requires demo. */
  CTRADER_ENVIRONMENT: z.enum(["demo", "live"]).default("demo"),
  CTRADER_HOST: z.string().optional(),
  CTRADER_PORT: z.coerce.number().int().optional(),
  /** Extra demo safety caps (in addition to RiskProfile). */
  BROKER_DEMO_MAX_VOLUME: z.coerce.number().positive().default(0.1),
  BROKER_DEMO_MAX_RISK_PERCENT: z.coerce.number().positive().default(0.5),
  /**
   * Guarded connectivity test path. Does not enable automated engine trading.
   */
  BROKER_DEMO_TEST_MODE: z.coerce.boolean().default(false),
  /**
   * Allow engine-generated broker-demo trades. Keep false until one manual demo
   * connectivity trade is approved.
   */
  BROKER_DEMO_ENGINE_ENABLED: z.coerce.boolean().default(false),
  /** Spotware money field scale (cents → 100). */
  CTRADER_MONEY_SCALE: z.coerce.number().positive().default(100),
  /**
   * MT5 demo bridge (worker/api → Docker DNS, never 127.0.0.1 from a container).
   * Example inside Compose: http://mt5-bridge:8765
   * Do NOT publish this port. Do NOT put MT5 account passwords here.
   */
  MT5_BRIDGE_URL: z.string().url().optional(),
  MT5_BRIDGE_HOST: z.string().default("mt5-bridge"),
  MT5_BRIDGE_PORT: z.coerce.number().int().positive().default(8765),
  MT5_BRIDGE_SECRET: z.string().min(16).optional(),
  MT5_MAILBOX_PATH: z.string().default("/mt5-mailbox"),
  MT5_EXPECTED_BROKER: z.string().default("Deriv"),
  MT5_EXPECTED_ENVIRONMENT: z.enum(["demo", "live"]).default("demo"),
  MT5_EXPECTED_SERVER: z.string().optional(),
  MT5_EXPECTED_LOGIN: z.string().optional(),
  MT5_MAGIC_NUMBER: z.coerce.number().int().positive().default(26082301),
  MT5_ENGINE_ENABLED: z.coerce.boolean().default(false),
  MT5_TEST_MODE: z.coerce.boolean().default(false),
  MT5_MAX_TEST_VOLUME: z.coerce.number().positive().default(0.01),
  MT5_MAX_TEST_RISK_PERCENT: z.coerce.number().positive().default(0.1),
  MT5_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
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
