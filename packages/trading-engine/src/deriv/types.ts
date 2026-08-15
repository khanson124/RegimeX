/** Normalized Deriv API surface used by the rest of the system. */

export interface DerivAuthorizeInfo {
  loginId: string;
  isVirtual: boolean;
  currency: string;
  balance: number;
  email: string | null;
  landingCompany: string | null;
}

export interface DerivTick {
  symbol: string;
  epochMs: number;
  quote: number;
}

export interface DerivHistoricalCandle {
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DerivProposal {
  proposalId: string;
  askPrice: number;
  payout: number;
  spot: number;
  displayValue: string;
}

export interface DerivBuyResult {
  contractId: string;
  buyPrice: number;
  payout: number;
  startTime: number;
  transactionId: string;
  longcode: string;
}

export interface DerivContractUpdate {
  contractId: string;
  status: "open" | "won" | "lost" | "sold" | "cancelled";
  entrySpot: number | null;
  exitSpot: number | null;
  currentSpot: number | null;
  buyPrice: number;
  payout: number | null;
  profit: number | null;
  isSettled: boolean;
  expiryTimeMs: number | null;
  raw: Record<string, unknown>;
}

export interface DerivBalanceUpdate {
  balance: number;
  currency: string;
}

export interface DerivErrorShape {
  code: string;
  message: string;
}

export type DerivConnectionState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "AUTHENTICATED"
  | "RECONNECTING";

export interface DerivClientEvents {
  stateChange: (state: DerivConnectionState) => void;
  tick: (tick: DerivTick) => void;
  contractUpdate: (update: DerivContractUpdate) => void;
  balance: (update: DerivBalanceUpdate) => void;
  error: (error: Error) => void;
  reconnected: () => void;
}
