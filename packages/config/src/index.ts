import "dotenv/config";
import { z } from "zod";
import { envBoolean } from "./envBoolean.js";

export * from "./crypto.js";
export * from "./redis.js";
export { parseEnvBoolean, envBoolean } from "./envBoolean.js";

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
  FEATURE_ENSEMBLE_VOTING: envBoolean.default(false),
  /** Hard switch: demo trade execution. Defaults OFF. */
  DEMO_TRADING_ENABLED: envBoolean.default(false),
  /**
   * CFD execution backend:
   * - broker_demo_mt5: primary Deriv MT5 DEMO forward path (EA/bridge, no public ports)
   * - paper_cfd: local development / tests / broker-unavailable fallback (still supported)
   * - broker_demo_cfd: Deriv cTrader Open API DEMO
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
  REAL_MONEY_ENABLED: envBoolean.default(false),
  /** Quarantined legacy Deriv rise/fall options path. Defaults OFF. */
  LEGACY_BINARY_ENABLED: envBoolean.default(false),
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
  BROKER_DEMO_TEST_MODE: envBoolean.default(false),
  /**
   * Allow engine-generated broker-demo trades. Keep false until one manual demo
   * connectivity trade is approved.
   */
  BROKER_DEMO_ENGINE_ENABLED: envBoolean.default(false),
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
  /**
   * Allow engine-generated MT5 DEMO orders. Keep false for status/preflight/TEST.
   * String "false" must remain false (do not use z.coerce.boolean).
   */
  MT5_ENGINE_ENABLED: envBoolean.default(false),
  /** Guarded TEST / status / preflight APIs. Does not enable engine automation. */
  MT5_TEST_MODE: envBoolean.default(false),
  MT5_MAX_TEST_VOLUME: z.coerce.number().positive().default(0.01),
  MT5_MAX_TEST_RISK_PERCENT: z.coerce.number().positive().default(0.1),
  MT5_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /** Bounded retention for completed MT5 mailbox files (bridge only). */
  MT5_MAILBOX_REPLY_RETENTION_SECONDS: z.coerce.number().int().positive().default(600),
  MT5_MAILBOX_PROCESSING_RETENTION_SECONDS: z.coerce.number().int().positive().default(600),
  MT5_MAILBOX_ORPHAN_RETENTION_SECONDS: z.coerce.number().int().positive().default(86_400),
  /** Legacy minute-based retention (used only when *_SECONDS unset in env). */
  MT5_MAILBOX_PROCESSING_RETENTION_MINUTES: z.coerce.number().int().positive().optional(),
  MT5_MAILBOX_REPLY_RETENTION_MINUTES: z.coerce.number().int().positive().optional(),
  MT5_MAILBOX_ORPHAN_RETENTION_MINUTES: z.coerce.number().int().positive().optional(),
  MT5_MAILBOX_CLEANUP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  MT5_MAILBOX_MAX_REPLIES: z.coerce.number().int().positive().default(5_000),
  MT5_MAILBOX_MAX_PROCESSING: z.coerce.number().int().positive().default(1_000),
  MT5_MAILBOX_CLEANUP_ENABLED: envBoolean.default(true),
  /**
   * Autonomous MT5 DEMO rollout. Empty allowlist = fail-closed (no engine orders).
   * Internal RegimeX symbols (R_10), not broker-native MT5 names.
   */
  MT5_ENGINE_SYMBOL_ALLOWLIST: z.string().default(""),
  MT5_ENGINE_STRATEGY_ALLOWLIST: z.string().default(""),
  MT5_ENGINE_MAX_CONCURRENT_POSITIONS: z.coerce.number().int().min(0).max(5).default(1),
  /** Hard ceiling. Never raised to satisfy broker minVolume. */
  MT5_ENGINE_MAX_VOLUME: z.coerce.number().positive().default(0.01),
  MT5_ENGINE_MAX_RISK_PERCENT: z.coerce.number().positive().default(0.1),
  /** Evidence thresholds — not profitability promises. */
  MT5_EVIDENCE_MIN_FORWARD_TRADES: z.coerce.number().int().min(1).default(20),
  MT5_EVIDENCE_MIN_EXPECTANCY_R: z.coerce.number().default(0.05),
  MT5_EVIDENCE_MIN_PROFIT_FACTOR: z.coerce.number().positive().default(1.1),
  MT5_EVIDENCE_MAX_DRAWDOWN_PERCENT: z.coerce.number().positive().default(15),
  MT5_EVIDENCE_MIN_POSITIVE_WF_PCT: z.coerce.number().min(0).max(100).default(50),
  MT5_EVIDENCE_MAX_DEGRADATION_PERCENT: z.coerce.number().min(0).max(100).default(50),
  /** Avoid flapping from one or two trades. */
  MT5_EVIDENCE_MIN_TRADES_FOR_TRANSITION: z.coerce.number().int().min(1).default(8),
  MT5_EVIDENCE_CONSECUTIVE_LOSSES_SUSPEND: z.coerce.number().int().min(3).default(8),
  /**
   * Optional Telegram trade notifications (worker-owned). Fully optional —
   * when false, no Telegram HTTP calls are made. Token/chat are never logged.
   */
  TELEGRAM_NOTIFICATIONS_ENABLED: envBoolean.default(false),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
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
