import {
  CFD_INTRABAR_POLICY,
  CFD_SIMULATOR_VERSION,
  type InstrumentMetadata,
  type PositionCloseReason,
  type PositionDirection
} from "@regimex/shared";
import {
  applyExitFill,
  computeRMultiples,
  floatingPnl,
  lossAtStopPerUnitVolume
} from "../execution/cfdMath.js";
import { roundMoney } from "@regimex/shared";

export interface CfdBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CfdSimulationInput {
  direction: PositionDirection;
  /** Filled entry price (already includes entry half-spread + slippage). */
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  volume: number;
  instrument: InstrumentMetadata;
  bars: ReadonlyArray<CfdBar>;
  /** Full bid–ask spread in bps of mid (half applied on exit side). */
  spreadBps: number;
  /** Adverse slippage in bps of mid (applied on exit side). */
  slippageBps: number;
}

export interface CfdSimulationResult {
  simulatorVersion: typeof CFD_SIMULATOR_VERSION;
  intrabarPolicy: typeof CFD_INTRABAR_POLICY;
  /** Trigger / mid used for SL/TP/close before exit fill. */
  exitTriggerPrice: number;
  /** Executable exit fill after half-spread + slippage. */
  exitPrice: number;
  closeReason: PositionCloseReason;
  barsHeld: number;
  /** P&L entryFill → exitTrigger (before exit fill costs). */
  grossPnl: number;
  /** P&L entryFill → exitFill (after exit half-spread + slippage). */
  netPnl: number;
  initialRiskAmount: number;
  grossR: number | null;
  netR: number | null;
  /** Alias of netR for backward compatibility. Prefer netR. */
  rMultiple: number | null;
  riskAmount: number;
}

export interface CfdPositionSimulator {
  simulate(input: CfdSimulationInput): CfdSimulationResult;
}

function hitOnBar(
  direction: PositionDirection,
  bar: CfdBar,
  stopLoss: number,
  takeProfit: number | null
): { stopHit: boolean; tpHit: boolean } {
  if (direction === "BUY") {
    return {
      stopHit: bar.low <= stopLoss,
      tpHit: takeProfit !== null && bar.high >= takeProfit
    };
  }
  return {
    stopHit: bar.high >= stopLoss,
    tpHit: takeProfit !== null && bar.low <= takeProfit
  };
}

/**
 * Bar-based CFD simulator for backtests.
 * Same-candle ambiguity: STOP_LOSS_FIRST (conservative).
 *
 * Fill model matches paper live: spreadBps = full spread; half + slip per side via prices.
 * Entry is assumed already filled; exit applies half-spread + slip on the close side.
 */
export class BarCfdPositionSimulator implements CfdPositionSimulator {
  simulate(input: CfdSimulationInput): CfdSimulationResult {
    const riskAmount = roundMoney(
      lossAtStopPerUnitVolume(
        input.direction,
        input.entryPrice,
        input.stopLoss,
        input.instrument
      ) * input.volume
    );

    for (let i = 0; i < input.bars.length; i++) {
      const bar = input.bars[i]!;
      const { stopHit, tpHit } = hitOnBar(input.direction, bar, input.stopLoss, input.takeProfit);

      if (stopHit && tpHit) {
        return this.buildResult(input, input.stopLoss, "STOP_LOSS", i + 1, riskAmount);
      }
      if (stopHit) {
        return this.buildResult(input, input.stopLoss, "STOP_LOSS", i + 1, riskAmount);
      }
      if (tpHit && input.takeProfit !== null) {
        return this.buildResult(input, input.takeProfit, "TAKE_PROFIT", i + 1, riskAmount);
      }
    }

    const last = input.bars[input.bars.length - 1]!;
    return this.buildResult(input, last.close, "STRATEGY_EXIT", input.bars.length, riskAmount);
  }

  private buildResult(
    input: CfdSimulationInput,
    exitTriggerPrice: number,
    closeReason: PositionCloseReason,
    barsHeld: number,
    riskAmount: number
  ): CfdSimulationResult {
    const exitFill = applyExitFill(
      input.direction,
      exitTriggerPrice,
      input.spreadBps,
      input.slippageBps
    );
    const grossPnl = floatingPnl(
      input.direction,
      input.entryPrice,
      exitTriggerPrice,
      input.volume,
      input.instrument
    );
    const netPnl = floatingPnl(
      input.direction,
      input.entryPrice,
      exitFill.fillPrice,
      input.volume,
      input.instrument
    );
    const r = computeRMultiples(riskAmount, grossPnl, netPnl);

    return {
      simulatorVersion: CFD_SIMULATOR_VERSION,
      intrabarPolicy: CFD_INTRABAR_POLICY,
      exitTriggerPrice,
      exitPrice: exitFill.fillPrice,
      closeReason,
      barsHeld,
      grossPnl,
      netPnl,
      initialRiskAmount: riskAmount,
      grossR: r.grossR,
      netR: r.netR,
      rMultiple: r.netR,
      riskAmount
    };
  }
}

export { CFD_SIMULATOR_VERSION, CFD_INTRABAR_POLICY };
