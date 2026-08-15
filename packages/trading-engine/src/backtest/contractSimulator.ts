import { multiplyMoney, roundMoney, subtractMoney } from "@regimex/shared";

export type ContractDirection = "CALL" | "PUT";
export type ContractOutcome = "WIN" | "LOSS" | "PUSH";

export interface ContractSimulationInput {
  direction: ContractDirection;
  /** Entry spot: close of the signal candle. */
  entryPrice: number;
  /** Exit spot: close of the expiry candle. */
  exitPrice: number;
  stake: number;
  /**
   * SIMULATED payout assumption: total return per unit stake on a win
   * (e.g. 0.95 = stake + 95% profit). Real demo execution uses the payout
   * quoted by Deriv proposals instead of this assumption.
   */
  assumedPayoutRatio: number;
}

export interface ContractSimulationResult {
  outcome: ContractOutcome;
  /** Amount credited back on settlement (0 on loss). */
  payout: number;
  /** Net profit relative to stake (negative on loss). */
  profit: number;
  /** Always true here — flags that payout is an assumption, not a quote. */
  simulated: true;
}

export interface ContractSimulator {
  simulate(input: ContractSimulationInput): ContractSimulationResult;
}

/**
 * Fixed-duration rise/fall contract simulator (Deriv CALL/PUT).
 * CALL wins when exit > entry; PUT wins when exit < entry; equal = push
 * (stake returned). Pluggable so other contract types can be added without
 * touching strategy code.
 */
export class RiseFallContractSimulator implements ContractSimulator {
  simulate(input: ContractSimulationInput): ContractSimulationResult {
    const { direction, entryPrice, exitPrice, stake, assumedPayoutRatio } = input;
    if (stake <= 0) throw new Error("Stake must be positive");

    let outcome: ContractOutcome;
    if (exitPrice === entryPrice) outcome = "PUSH";
    else if (direction === "CALL") outcome = exitPrice > entryPrice ? "WIN" : "LOSS";
    else outcome = exitPrice < entryPrice ? "WIN" : "LOSS";

    if (outcome === "WIN") {
      const profit = multiplyMoney(stake, assumedPayoutRatio);
      return { outcome, payout: roundMoney(stake + profit), profit, simulated: true };
    }
    if (outcome === "PUSH") {
      return { outcome, payout: roundMoney(stake), profit: 0, simulated: true };
    }
    return { outcome, payout: 0, profit: subtractMoney(0, stake), simulated: true };
  }
}
