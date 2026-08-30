import { describe, expect, it, vi, beforeEach } from "vitest";
import { type AppConfig } from "@regimex/config";
import {
  TelegramTradeNotifier,
  telegramHtml,
  type TelegramFetch
} from "./telegram.js";

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    TELEGRAM_NOTIFICATIONS_ENABLED: false,
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    ...overrides
  } as AppConfig;
}

function mockPrisma(store: Map<string, { deliveryKey: string; kind: string }> = new Map()) {
  return {
    store,
    telegramDelivery: {
      create: vi.fn(async ({ data }: { data: { deliveryKey: string; kind: string } }) => {
        if (store.has(data.deliveryKey)) {
          const err = Object.assign(new Error("Unique constraint"), { code: "P2002" });
          throw err;
        }
        store.set(data.deliveryKey, data);
        return { id: "d1", ...data, createdAt: new Date() };
      }),
      delete: vi.fn(async ({ where }: { where: { deliveryKey: string } }) => {
        store.delete(where.deliveryKey);
        return { id: "d1", deliveryKey: where.deliveryKey, kind: "trade-close", createdAt: new Date() };
      })
    }
  };
}

function mockLogger() {
  const warnings: Array<{ obj: unknown; msg: string }> = [];
  const child = {
    warn: (obj: unknown, msg?: string) => {
      warnings.push({ obj, msg: msg ?? "" });
    },
    info: vi.fn(),
    error: vi.fn(),
    child: () => child
  };
  return {
    warnings,
    logger: {
      child: () => child,
      warn: child.warn,
      info: child.info,
      error: child.error
    } as never
  };
}

describe("TelegramTradeNotifier", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("makes no HTTP requests when notifications are disabled", async () => {
    const fetchImpl = vi.fn() as unknown as TelegramFetch;
    const prisma = mockPrisma();
    const { logger } = mockLogger();
    const notifier = new TelegramTradeNotifier({
      config: baseConfig({ TELEGRAM_NOTIFICATIONS_ENABLED: false }),
      prisma: prisma as never,
      logger,
      fetchImpl
    });

    const ok = await notifier.sendTradeOpenedNotification({
      positionId: "p1",
      internalSymbol: "R_10",
      brokerSymbol: "Volatility 10 Index",
      direction: "SELL",
      volume: 0.5,
      entryPrice: 4771.24,
      stopLoss: 4772.1,
      takeProfit: 4769.7,
      strategyId: "ema-pullback-v1",
      regime: "STRONG_DOWNTREND",
      brokerPositionId: "123"
    });

    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(prisma.telegramDelivery.create).not.toHaveBeenCalled();
  });

  it("sends successfully when enabled with token and chat id", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 1 } })
    ) as unknown as TelegramFetch;
    const prisma = mockPrisma();
    const { logger, warnings } = mockLogger();
    const notifier = new TelegramTradeNotifier({
      config: baseConfig({
        TELEGRAM_NOTIFICATIONS_ENABLED: true,
        TELEGRAM_BOT_TOKEN: "test-token-abc",
        TELEGRAM_CHAT_ID: "999001"
      }),
      prisma: prisma as never,
      logger,
      fetchImpl
    });

    const ok = await notifier.sendTradeOpenedNotification({
      positionId: "pos-open-1",
      internalSymbol: "R_10",
      brokerSymbol: "Volatility 10 Index",
      direction: "SELL",
      volume: 0.5,
      entryPrice: 4771.24,
      stopLoss: 4772.1,
      takeProfit: 4769.7,
      strategyId: "ema-pullback-v1",
      regime: "STRONG_DOWNTREND",
      brokerPositionId: "123456789",
      openedAt: new Date("2026-08-30T16:30:00.000Z")
    });

    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(url).toContain("api.telegram.org/bot");
    expect(url).toContain("/sendMessage");
    const body = JSON.parse(String(init.body));
    expect(body.chat_id).toBe("999001");
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toContain("RegimeX Trade Opened");
    expect(body.text).toContain("R_10");
    expect(body.text).toContain("Volatility 10 Index");
    expect(body.text).toContain("SELL");
    expect(warnings.every((w) => !JSON.stringify(w).includes("test-token-abc"))).toBe(true);
    expect(warnings.every((w) => !JSON.stringify(w).includes("999001"))).toBe(true);
  });

  it("does not throw into trading flow on Telegram API/network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down token=test-token-secret chat=chat-secret-42");
    }) as unknown as TelegramFetch;
    const prisma = mockPrisma();
    const { logger, warnings } = mockLogger();
    const notifier = new TelegramTradeNotifier({
      config: baseConfig({
        TELEGRAM_NOTIFICATIONS_ENABLED: true,
        TELEGRAM_BOT_TOKEN: "test-token-secret",
        TELEGRAM_CHAT_ID: "chat-secret-42"
      }),
      prisma: prisma as never,
      logger,
      fetchImpl
    });

    await expect(
      notifier.sendTradeOpenedNotification({
        positionId: "p-fail",
        internalSymbol: "R_10",
        brokerSymbol: "Volatility 10 Index",
        direction: "BUY",
        volume: 0.1,
        entryPrice: 100,
        stopLoss: 99,
        takeProfit: 101,
        strategyId: "s1",
        regime: "RANGE",
        brokerPositionId: "1"
      })
    ).resolves.toBe(false);

    expect(prisma.store.has("trade-open:p-fail")).toBe(false);
    const blob = JSON.stringify(warnings);
    expect(blob).not.toContain("test-token-secret");
    expect(blob).not.toContain("chat-secret-42");
    expect(blob).toContain("[redacted]");
  });

  it("warns and skips when enabled but token/chat id missing", async () => {
    const fetchImpl = vi.fn() as unknown as TelegramFetch;
    const prisma = mockPrisma();
    const { logger, warnings } = mockLogger();
    const notifier = new TelegramTradeNotifier({
      config: baseConfig({
        TELEGRAM_NOTIFICATIONS_ENABLED: true,
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_CHAT_ID: ""
      }),
      prisma: prisma as never,
      logger,
      fetchImpl
    });

    const ok = await notifier.sendTelegramMessage("hello");
    expect(ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warnings.some((w) => w.msg.includes("BOT_TOKEN or CHAT_ID is missing"))).toBe(true);
  });

  it("sends execution rejected notification", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true })
    ) as unknown as TelegramFetch;
    const prisma = mockPrisma();
    const { logger } = mockLogger();
    const notifier = new TelegramTradeNotifier({
      config: baseConfig({
        TELEGRAM_NOTIFICATIONS_ENABLED: true,
        TELEGRAM_BOT_TOKEN: "tok",
        TELEGRAM_CHAT_ID: "1"
      }),
      prisma: prisma as never,
      logger,
      fetchImpl
    });

    const ok = await notifier.sendExecutionRejectedNotification({
      signalId: "sig-1",
      symbol: "R_10",
      direction: "SELL",
      strategyId: "ema-pullback-v1",
      regime: "STRONG_DOWNTREND",
      reasons: ["MT5_INVALID_STOP_DISTANCE_PRECHECK"]
    });
    expect(ok).toBe(true);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    const body = JSON.parse(String((call![1] as RequestInit).body));
    expect(body.text).toContain("Execution Rejected");
    expect(body.text).toContain("MT5_INVALID_STOP_DISTANCE_PRECHECK");
  });

  it("sends close notification and dedupes duplicate reconciliation closes", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ ok: true })
    ) as unknown as TelegramFetch;
    const prisma = mockPrisma();
    const { logger } = mockLogger();
    const closedAt = new Date("2026-08-30T17:00:00.000Z");
    const notifier = new TelegramTradeNotifier({
      config: baseConfig({
        TELEGRAM_NOTIFICATIONS_ENABLED: true,
        TELEGRAM_BOT_TOKEN: "tok",
        TELEGRAM_CHAT_ID: "1"
      }),
      prisma: prisma as never,
      logger,
      fetchImpl,
      now: () => closedAt
    });

    const payload = {
      positionId: "pos-close-1",
      symbol: "R_10",
      direction: "SELL",
      entryPrice: 4769.667,
      exitPrice: 4768.357,
      volume: 0.5,
      realizedPnl: 0.66,
      closeReason: "TAKE_PROFIT",
      strategyId: "ema-pullback-v1",
      brokerPositionId: "5760025203",
      openedAt: new Date("2026-08-30T16:30:00.000Z"),
      closedAt
    };

    expect(await notifier.sendTradeClosedNotification(payload)).toBe(true);
    expect(await notifier.sendTradeClosedNotification(payload)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(prisma.store.has(`trade-close:pos-close-1:${closedAt.toISOString()}`)).toBe(true);
  });

  it("sanitizeErrorMessage redacts token and chat id", () => {
    const config = baseConfig({
      TELEGRAM_BOT_TOKEN: "super-secret-token",
      TELEGRAM_CHAT_ID: "chat-999"
    });
    const msg = telegramHtml.sanitizeErrorMessage(
      "fail https://api.telegram.org/botsuper-secret-token/sendMessage chat-999",
      config
    );
    expect(msg).not.toContain("super-secret-token");
    expect(msg).not.toContain("chat-999");
    expect(msg).toContain("[redacted]");
  });

  it("fire-and-forget notify helpers never reject", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as TelegramFetch;
    const prisma = mockPrisma();
    const { logger } = mockLogger();
    const notifier = new TelegramTradeNotifier({
      config: baseConfig({
        TELEGRAM_NOTIFICATIONS_ENABLED: true,
        TELEGRAM_BOT_TOKEN: "tok",
        TELEGRAM_CHAT_ID: "1"
      }),
      prisma: prisma as never,
      logger,
      fetchImpl
    });

    expect(() =>
      notifier.notifyOpened({
        positionId: "p",
        internalSymbol: "R_10",
        brokerSymbol: "B",
        direction: "BUY",
        volume: 0.1,
        entryPrice: 1,
        stopLoss: 0.9,
        takeProfit: 1.1,
        strategyId: "s",
        regime: "R",
        brokerPositionId: "1"
      })
    ).not.toThrow();

    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("mt5CfdRuntime telegram hook placement", () => {
  it("notifies OPENED only after accepted broker open; reject path uses REJECTED notify", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../cfd/mt5CfdRuntime.ts"), "utf8");

    expect(src).toContain("notifyOpened");
    expect(src).toContain("notifyRejected");
    expect(src).toContain("notifyClosed");

    const rejectIdx = src.indexOf("if (!result.accepted || !result.position)");
    const openedNotifyIdx = src.indexOf("this.telegram.notifyOpened");
    const rejectedNotifyIdx = src.indexOf("this.telegram.notifyRejected({", rejectIdx);
    expect(rejectIdx).toBeGreaterThan(-1);
    expect(openedNotifyIdx).toBeGreaterThan(rejectIdx);
    expect(rejectedNotifyIdx).toBeGreaterThan(rejectIdx);
    expect(rejectedNotifyIdx).toBeLessThan(openedNotifyIdx);

    const acceptedBranch = src.slice(rejectIdx, openedNotifyIdx);
    expect(acceptedBranch).toContain("notifyRejected");
    expect(acceptedBranch).not.toContain("notifyOpened");
  });
});
