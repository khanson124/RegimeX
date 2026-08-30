import { type AppConfig } from "@regimex/config";
import { type PrismaClient } from "@regimex/database";
import { type Logger } from "pino";

const TELEGRAM_TIMEOUT_MS = 5_000;
const TELEGRAM_RETRY_DELAY_MS = 250;

export type TelegramFetch = typeof fetch;

export interface TelegramNotifierDeps {
  config: AppConfig;
  prisma: PrismaClient;
  logger: Logger;
  fetchImpl?: TelegramFetch;
  /** Test hook — override clock for closedAt keys. */
  now?: () => Date;
}

export type TelegramDeliveryKind = "trade-open" | "trade-close" | "execution-rejected";

export interface TradeOpenedNotificationInput {
  positionId: string;
  internalSymbol: string;
  brokerSymbol: string;
  direction: string;
  volume: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null | undefined;
  strategyId: string;
  regime: string;
  brokerPositionId: string | null | undefined;
  openedAt?: Date | null;
}

export interface TradeClosedNotificationInput {
  positionId: string;
  symbol: string;
  direction: string | null | undefined;
  entryPrice: number | null | undefined;
  exitPrice: number | null | undefined;
  volume: number;
  realizedPnl: number | null | undefined;
  closeReason: string | null | undefined;
  strategyId: string;
  brokerPositionId: string | null | undefined;
  openedAt?: Date | null;
  closedAt?: Date | null;
}

export interface ExecutionRejectedNotificationInput {
  signalId: string;
  symbol: string;
  direction: string | null | undefined;
  strategyId: string;
  regime: string | null | undefined;
  reasons: string[];
  stopLoss?: number | null;
  takeProfit?: number | null;
  rejectedAt?: Date;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtNum(value: number | null | undefined, digits = 3): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function fmtPnl(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function fmtUtc(date: Date | null | undefined): string {
  const d = date ?? new Date();
  const iso = d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return iso;
}

function sanitizeErrorMessage(message: string, config: AppConfig): string {
  let out = message;
  const token = config.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = config.TELEGRAM_CHAT_ID?.trim();
  if (token) out = out.split(token).join("[redacted]");
  if (chatId) out = out.split(chatId).join("[redacted]");
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Worker-owned Telegram notifier. Never throws into trading flow.
 * Secrets are never logged.
 */
export class TelegramTradeNotifier {
  private missingConfigWarned = false;
  private readonly fetchImpl: TelegramFetch;
  private readonly now: () => Date;

  constructor(private readonly deps: TelegramNotifierDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  private get log(): Logger {
    return this.deps.logger.child({ component: "telegram_notify" });
  }

  private isEnabled(): boolean {
    return this.deps.config.TELEGRAM_NOTIFICATIONS_ENABLED === true;
  }

  private resolveCredentials(): { token: string; chatId: string } | null {
    if (!this.isEnabled()) return null;
    const token = this.deps.config.TELEGRAM_BOT_TOKEN?.trim() ?? "";
    const chatId = this.deps.config.TELEGRAM_CHAT_ID?.trim() ?? "";
    if (!token || !chatId) {
      if (!this.missingConfigWarned) {
        this.missingConfigWarned = true;
        this.log.warn(
          {
            enabled: true,
            hasBotToken: Boolean(token),
            hasChatId: Boolean(chatId)
          },
          "Telegram notifications enabled but BOT_TOKEN or CHAT_ID is missing — skipping sends"
        );
      }
      return null;
    }
    return { token, chatId };
  }

  /**
   * Claim a durable delivery key. Returns false if already claimed (duplicate).
   * On send failure the claim is released so a later cycle may retry once.
   */
  async claimDelivery(deliveryKey: string, kind: TelegramDeliveryKind): Promise<boolean> {
    try {
      await this.deps.prisma.telegramDelivery.create({
        data: { deliveryKey, kind }
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      this.log.warn(
        { err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err), this.deps.config) },
        "Telegram delivery claim failed"
      );
      return false;
    }
  }

  async releaseDelivery(deliveryKey: string): Promise<void> {
    try {
      await this.deps.prisma.telegramDelivery.delete({ where: { deliveryKey } });
    } catch {
      /* ignore — best effort */
    }
  }

  /**
   * Generic sendMessage. Never throws. Returns whether Telegram accepted the message.
   */
  async sendTelegramMessage(text: string, opts?: { parseMode?: "HTML" }): Promise<boolean> {
    const creds = this.resolveCredentials();
    if (!creds) return false;

    const url = `https://api.telegram.org/bot${creds.token}/sendMessage`;
    const body = JSON.stringify({
      chat_id: creds.chatId,
      text,
      disable_web_page_preview: true,
      ...(opts?.parseMode ? { parse_mode: opts.parseMode } : {})
    });

    const attempt = async (): Promise<boolean> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal
        });
        if (!res.ok) {
          this.log.warn(
            { status: res.status },
            "Telegram sendMessage HTTP failure"
          );
          return false;
        }
        const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
        if (!json?.ok) {
          this.log.warn({ status: res.status }, "Telegram sendMessage API returned not ok");
          return false;
        }
        return true;
      } catch (err) {
        this.log.warn(
          {
            err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err), this.deps.config)
          },
          "Telegram sendMessage network failure"
        );
        return false;
      } finally {
        clearTimeout(timer);
      }
    };

    if (await attempt()) return true;
    await new Promise((r) => setTimeout(r, TELEGRAM_RETRY_DELAY_MS));
    return attempt();
  }

  async sendTradeOpenedNotification(input: TradeOpenedNotificationInput): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const key = `trade-open:${input.positionId}`;
    const claimed = await this.claimDelivery(key, "trade-open");
    if (!claimed) return false;

    const lines = [
      "📈 <b>RegimeX Trade Opened</b>",
      "",
      `Symbol: ${escapeHtml(input.internalSymbol)}`,
      `Broker: ${escapeHtml(input.brokerSymbol)}`,
      `Direction: ${escapeHtml(input.direction)}`,
      `Volume: ${escapeHtml(String(input.volume))}`,
      `Entry: ${escapeHtml(fmtNum(input.entryPrice))}`,
      `SL: ${escapeHtml(fmtNum(input.stopLoss))}`,
      `TP: ${escapeHtml(input.takeProfit != null ? fmtNum(input.takeProfit) : "n/a")}`,
      `Strategy: ${escapeHtml(input.strategyId)}`,
      `Regime: ${escapeHtml(input.regime)}`,
      `Position: ${escapeHtml(input.brokerPositionId ?? input.positionId)}`,
      `Time: ${escapeHtml(fmtUtc(input.openedAt ?? this.now()))}`
    ];

    const ok = await this.sendTelegramMessage(lines.join("\n"), { parseMode: "HTML" });
    if (!ok) await this.releaseDelivery(key);
    return ok;
  }

  async sendTradeClosedNotification(input: TradeClosedNotificationInput): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const closedAt = input.closedAt ?? this.now();
    const key = `trade-close:${input.positionId}:${closedAt.toISOString()}`;
    const claimed = await this.claimDelivery(key, "trade-close");
    if (!claimed) return false;

    const lines = [
      "✅ <b>RegimeX Trade Closed</b>",
      "",
      `Symbol: ${escapeHtml(input.symbol)}`,
      ...(input.direction ? [`Direction: ${escapeHtml(input.direction)}`] : []),
      `Volume: ${escapeHtml(String(input.volume))}`,
      `Entry: ${escapeHtml(fmtNum(input.entryPrice))}`,
      `Exit: ${escapeHtml(fmtNum(input.exitPrice))}`,
      `P&amp;L: ${escapeHtml(fmtPnl(input.realizedPnl))}`,
      `Reason: ${escapeHtml(input.closeReason ?? "UNKNOWN")}`,
      `Strategy: ${escapeHtml(input.strategyId)}`,
      `Position: ${escapeHtml(input.brokerPositionId ?? input.positionId)}`,
      ...(input.openedAt ? [`Opened: ${escapeHtml(fmtUtc(input.openedAt))}`] : []),
      `Closed: ${escapeHtml(fmtUtc(closedAt))}`
    ];

    const ok = await this.sendTelegramMessage(lines.join("\n"), { parseMode: "HTML" });
    if (!ok) await this.releaseDelivery(key);
    return ok;
  }

  async sendExecutionRejectedNotification(input: ExecutionRejectedNotificationInput): Promise<boolean> {
    if (!this.isEnabled()) return false;
    const key = `execution-rejected:${input.signalId}`;
    const claimed = await this.claimDelivery(key, "execution-rejected");
    if (!claimed) return false;

    const reasonText = input.reasons.length > 0 ? input.reasons.join(", ") : "UNKNOWN";
    const lines = [
      "⚠️ <b>RegimeX Execution Rejected</b>",
      "",
      `Symbol: ${escapeHtml(input.symbol)}`,
      ...(input.direction ? [`Direction: ${escapeHtml(input.direction)}`] : []),
      `Strategy: ${escapeHtml(input.strategyId)}`,
      ...(input.regime ? [`Regime: ${escapeHtml(input.regime)}`] : []),
      `Reason: ${escapeHtml(reasonText)}`,
      ...(input.stopLoss != null ? [`SL: ${escapeHtml(fmtNum(input.stopLoss))}`] : []),
      ...(input.takeProfit != null ? [`TP: ${escapeHtml(fmtNum(input.takeProfit))}`] : []),
      `Time: ${escapeHtml(fmtUtc(input.rejectedAt ?? this.now()))}`
    ];

    const ok = await this.sendTelegramMessage(lines.join("\n"), { parseMode: "HTML" });
    if (!ok) await this.releaseDelivery(key);
    return ok;
  }

  /**
   * Fire-and-forget wrapper — never rejects, never blocks callers awaiting trading.
   */
  notifyOpened(input: TradeOpenedNotificationInput): void {
    void this.sendTradeOpenedNotification(input).catch((err) => {
      this.log.warn(
        { err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err), this.deps.config) },
        "Telegram opened notification unexpected failure"
      );
    });
  }

  notifyClosed(input: TradeClosedNotificationInput): void {
    void this.sendTradeClosedNotification(input).catch((err) => {
      this.log.warn(
        { err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err), this.deps.config) },
        "Telegram closed notification unexpected failure"
      );
    });
  }

  notifyRejected(input: ExecutionRejectedNotificationInput): void {
    void this.sendExecutionRejectedNotification(input).catch((err) => {
      this.log.warn(
        { err: sanitizeErrorMessage(err instanceof Error ? err.message : String(err), this.deps.config) },
        "Telegram rejected notification unexpected failure"
      );
    });
  }
}

/** Factory used by MT5 runtime. */
export function createTelegramTradeNotifier(deps: TelegramNotifierDeps): TelegramTradeNotifier {
  return new TelegramTradeNotifier(deps);
}

export const telegramHtml = { escapeHtml, fmtNum, fmtPnl, fmtUtc, sanitizeErrorMessage };
