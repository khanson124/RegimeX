import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionBackend } from "@regimex/trading-engine";
import type { SessionDeps } from "./liveEngineSession.js";

const socket = vi.hoisted(() => ({
  construct: vi.fn(), connect: vi.fn(), on: vi.fn()
}));
vi.mock("@regimex/trading-engine", async (importOriginal) => {
  const original = await importOriginal<typeof import("@regimex/trading-engine")>();
  return { ...original, DerivClient: class {
    constructor(options: unknown) { socket.construct(options); }
    connect = socket.connect;
    on = socket.on;
  } };
});
import { LiveEngineSession } from "./liveEngineSession.js";

function fixture(backend: ExecutionBackend, symbol = "XAUUSD") {
  const credential = vi.fn().mockResolvedValue({ encryptedToken: "encrypted" });
  const decrypt = vi.fn().mockReturnValue("test-token");
  const info = vi.fn();
  const deps = {
    config: { STRATEGY_SELECTION_MODE: "bootstrap", DERIV_WS_URL: "wss://example.invalid", DERIV_APP_ID: "test" },
    prisma: { derivCredential: { findFirst: credential } },
    credentialDecrypt: decrypt, publish: vi.fn(), logger: { child: () => ({ info }) }
  } as unknown as SessionDeps;
  const session = new LiveEngineSession("user", deps);
  const internal = session as unknown as {
    executionBackend: ExecutionBackend; symbol: string; client: unknown;
    connectDerivClient(): Promise<void>; setState(): Promise<void>;
  };
  internal.executionBackend = backend;
  internal.symbol = symbol;
  vi.spyOn(internal, "setState").mockResolvedValue();
  return { internal, credential, decrypt, info };
}

beforeEach(() => { vi.clearAllMocks(); socket.connect.mockResolvedValue(undefined); });
describe("DEMO MT5 market-data connection", () => {
  it.each(["XAUUSD", "R_10"])("%s starts without reading Deriv credentials or opening a WebSocket", async (symbol) => {
    const f = fixture("broker_demo_mt5", symbol);
    f.credential.mockRejectedValue(new Error("Deriv credentials unavailable"));
    socket.connect.mockRejectedValue(new Error("Deriv unavailable"));
    await expect(f.internal.connectDerivClient()).resolves.toBeUndefined();
    expect(f.credential).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(socket.construct).not.toHaveBeenCalled();
    expect(socket.on).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
    expect(f.internal.client).toBeNull();
    expect(f.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: symbol === "XAUUSD" ? "DEMO_XAU_MT5_ONLY_MARKET_DATA" : "DEMO_R10_MT5_ONLY_MARKET_DATA" }), expect.any(String)
    );
  });

  it.each([
    ["broker_real_mt5", "XAUUSD"], ["broker_real_mt5", "R_10"], ["broker_demo_mt5", "R_25"],
    ["legacy_binary", "XAUUSD"], ["paper_cfd", "XAUUSD"],
    ["legacy_binary", "R_10"], ["paper_cfd", "R_10"]
  ] as const)("preserves %s/%s credential, connection and event handling", async (backend, symbol) => {
    const f = fixture(backend, symbol);
    await f.internal.connectDerivClient();
    expect(f.credential).toHaveBeenCalledOnce();
    expect(f.decrypt).toHaveBeenCalledWith("encrypted");
    expect(socket.construct).toHaveBeenCalledWith(expect.objectContaining({ apiToken: "test-token" }));
    expect(socket.connect).toHaveBeenCalledOnce();
    expect(socket.on.mock.calls.map(c => c[0])).toEqual(["reconnected", "error", "stateChange"]);
  });

  it("does not swallow REAL connection failures", async () => {
    const f = fixture("broker_real_mt5");
    socket.connect.mockRejectedValue(new Error("connection failed"));
    await expect(f.internal.connectDerivClient()).rejects.toThrow("connection failed");
  });
});
