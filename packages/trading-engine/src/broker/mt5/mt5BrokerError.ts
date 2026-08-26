import { isAutonomousDecisionCode, type AutonomousDecisionCode } from "@regimex/shared";
import {
  isMt5BridgeFailureCode,
  MT5_BRIDGE_TIMEOUT,
  MT5_BRIDGE_UNAVAILABLE,
  MT5_BRIDGE_UNHEALTHY
} from "./bridgeCircuit.js";

export class Mt5BrokerError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message?: string) {
    super(message && message !== errorCode ? `${errorCode}: ${message}` : errorCode);
    this.name = "Mt5BrokerError";
    this.errorCode = errorCode;
  }
}

export function mt5ErrorCodeFromUnknown(err: unknown): string {
  if (err instanceof Mt5BrokerError) return err.errorCode;
  if (err instanceof Error && err.name === "AbortError") return MT5_BRIDGE_TIMEOUT;
  const message = err instanceof Error ? err.message : String(err);
  if (/^MT5_[A-Z0-9_]+/.test(message)) {
    return message.split(":")[0]!.trim();
  }
  if (/aborted|timeout|Timeout/i.test(message)) return MT5_BRIDGE_TIMEOUT;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(message)) return MT5_BRIDGE_UNAVAILABLE;
  return MT5_BRIDGE_UNAVAILABLE;
}

export function toAutonomousMt5DecisionCode(code: string): AutonomousDecisionCode {
  if (code === "MT5_BRIDGE_UNREACHABLE" || code === "MT5_BRIDGE_HTTP_ERROR") {
    return "MT5_BRIDGE_UNAVAILABLE";
  }
  if (code === "MT5_MAILBOX_IO_TIMEOUT") return "MT5_BRIDGE_UNHEALTHY";
  if (isAutonomousDecisionCode(code)) return code;
  if (isMt5BridgeFailureCode(code)) return "MT5_BRIDGE_UNAVAILABLE";
  return "EXECUTION_REJECTED";
}
