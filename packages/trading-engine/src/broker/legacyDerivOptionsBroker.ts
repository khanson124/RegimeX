import { type BrokerAdapter } from "@regimex/shared";

export interface LegacyDerivOptionsBrokerConfig {
  enabled: boolean;
}

/**
 * Quarantined wrapper for the legacy Deriv rise/fall options execution path.
 * Milestone 0: disabled by default; real delegation wired only when LEGACY_BINARY_ENABLED=true
 * in a later cleanup pass. Throws if invoked while disabled.
 */
export class LegacyDerivOptionsBrokerAdapter implements BrokerAdapter {
  readonly name = "legacy_deriv_options";

  constructor(private readonly config: LegacyDerivOptionsBrokerConfig) {}

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error(
        "Legacy binary options execution is disabled. Use EXECUTION_MODE=paper_cfd."
      );
    }
  }

  async connect(): Promise<void> {
    this.assertEnabled();
    throw new Error("LegacyDerivOptionsBrokerAdapter.connect is not implemented in Milestone 0");
  }

  async disconnect(): Promise<void> {
    this.assertEnabled();
  }

  async getAccount(): Promise<never> {
    this.assertEnabled();
    throw new Error("LegacyDerivOptionsBrokerAdapter.getAccount is not implemented in Milestone 0");
  }

  async getInstrumentMetadata(_symbol: string) {
    this.assertEnabled();
    return null;
  }

  async getQuote(_symbol: string) {
    this.assertEnabled();
    return null;
  }

  async openMarketPosition(_request: import("@regimex/shared").OpenMarketPositionRequest): Promise<never> {
    this.assertEnabled();
    throw new Error(
      "LegacyDerivOptionsBrokerAdapter.openMarketPosition is quarantined — use paper CFD"
    );
  }

  async modifyPosition(_request: import("@regimex/shared").ModifyPositionRequest): Promise<never> {
    this.assertEnabled();
    throw new Error("LegacyDerivOptionsBrokerAdapter.modifyPosition is quarantined");
  }

  async closePosition(_request: import("@regimex/shared").ClosePositionRequest): Promise<never> {
    this.assertEnabled();
    throw new Error("LegacyDerivOptionsBrokerAdapter.closePosition is quarantined");
  }

  async getOpenPositions() {
    this.assertEnabled();
    return [];
  }

  async getPosition() {
    this.assertEnabled();
    return null;
  }
}

export function createBrokerAdapter(options: {
  executionMode:
    | "paper_cfd"
    | "broker_demo_cfd"
    | "broker_demo_mt5"
    | "broker_real_cfd"
    | "broker_real_mt5"
    | "legacy_binary";
  legacyBinaryEnabled: boolean;
  paper: import("./paperCFDBroker.js").PaperCFDBrokerAdapter;
  derivCfd?: import("./derivCfdBroker.js").DerivCfdBrokerAdapter;
  derivMt5?: import("./derivMt5Broker.js").DerivMT5BrokerAdapter;
}): BrokerAdapter {
  if (options.executionMode === "broker_real_mt5") {
    throw new Error("REAL_MT5_EXECUTION_NOT_IMPLEMENTED");
  }
  if (options.executionMode === "legacy_binary" && options.legacyBinaryEnabled) {
    return new LegacyDerivOptionsBrokerAdapter({ enabled: true });
  }
  if (options.executionMode === "broker_demo_cfd" || options.executionMode === "broker_real_cfd") {
    if (!options.derivCfd) {
      throw new Error("createBrokerAdapter: DerivCfdBrokerAdapter required for broker_*_cfd modes");
    }
    return options.derivCfd;
  }
  if (options.executionMode === "broker_demo_mt5") {
    if (!options.derivMt5) {
      throw new Error("createBrokerAdapter: DerivMT5BrokerAdapter required for broker_demo_mt5");
    }
    return options.derivMt5;
  }
  return options.paper;
}
