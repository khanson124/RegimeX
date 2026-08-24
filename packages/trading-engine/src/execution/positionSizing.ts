import {
  roundMoney,
  type InstrumentMetadata,
  type PositionSizingInput,
  type PositionSizingResult,
  validateInstrumentMetadata
} from "@regimex/shared";
import { lossAtStopPerUnitVolume, normalizeVolumeDown } from "./cfdMath.js";

const LOSS_TOLERANCE = 0.01;

export interface RawPositionSizingResult {
  success: boolean;
  rawVolume: number | null;
  riskAmount: number | null;
  perUnitLoss: number | null;
  rejectionReasons: string[];
}

export class DefaultPositionSizingService {
  /** Risk-sized volume before broker min/max. Does not raise to minVolume. */
  calculateRaw(input: PositionSizingInput): RawPositionSizingResult {
    const validation = validateInstrumentMetadata(input.instrument);
    if (!validation.valid) {
      return {
        success: false,
        rawVolume: null,
        riskAmount: null,
        perUnitLoss: null,
        rejectionReasons: validation.reasons
      };
    }

    if (input.equity <= 0) {
      return {
        success: false,
        rawVolume: null,
        riskAmount: null,
        perUnitLoss: null,
        rejectionReasons: ["Account equity must be positive"]
      };
    }

    const perUnitLoss = lossAtStopPerUnitVolume(
      input.direction,
      input.entryPrice,
      input.stopLoss,
      input.instrument
    );

    if (perUnitLoss <= 0) {
      return {
        success: false,
        rawVolume: null,
        riskAmount: null,
        perUnitLoss: null,
        rejectionReasons: ["Stop-loss must be on the adverse side of entry for sizing"]
      };
    }

    const riskAmount = roundMoney((input.equity * input.riskPerTradePercent) / 100);
    if (riskAmount <= 0) {
      return {
        success: false,
        rawVolume: null,
        riskAmount: null,
        perUnitLoss: null,
        rejectionReasons: ["Computed risk amount is zero"]
      };
    }

    return {
      success: true,
      rawVolume: riskAmount / perUnitLoss,
      riskAmount,
      perUnitLoss,
      rejectionReasons: []
    };
  }

  calculate(input: PositionSizingInput): PositionSizingResult {
    const raw = this.calculateRaw(input);
    if (!raw.success || raw.rawVolume == null || raw.riskAmount == null || raw.perUnitLoss == null) {
      return {
        success: false,
        volume: null,
        riskAmount: null,
        lossAtStop: null,
        rejectionReasons: raw.rejectionReasons
      };
    }

    const volume = normalizeVolumeDown(raw.rawVolume, input.instrument);
    const riskAmount = raw.riskAmount;
    const perUnitLoss = raw.perUnitLoss;

    if (volume <= 0 || volume < input.instrument.minVolume) {
      return {
        success: false,
        volume: null,
        riskAmount: null,
        lossAtStop: null,
        rejectionReasons: [
          `Normalized volume ${volume} is below instrument minimum ${input.instrument.minVolume} after rounding down to step ${input.instrument.volumeStep}`
        ]
      };
    }

    if (volume > input.instrument.maxVolume) {
      return {
        success: false,
        volume: null,
        riskAmount: null,
        lossAtStop: null,
        rejectionReasons: [
          `Normalized volume ${volume} exceeds instrument maximum ${input.instrument.maxVolume}`
        ]
      };
    }

    const lossAtStop = roundMoney(perUnitLoss * volume);
    if (lossAtStop > riskAmount + LOSS_TOLERANCE) {
      return {
        success: false,
        volume: null,
        riskAmount: null,
        lossAtStop: null,
        rejectionReasons: [
          `Loss at stop (${lossAtStop}) exceeds approved risk (${riskAmount}) after volume normalization`
        ]
      };
    }

    return {
      success: true,
      volume,
      riskAmount,
      lossAtStop,
      rejectionReasons: []
    };
  }
}

export function resolveInstrumentCosts(
  instrument: InstrumentMetadata,
  fallbackSpreadBps: number,
  fallbackSlippageBps: number
): { spreadBps: number; slippageBps: number } {
  return {
    spreadBps: Number.isFinite(instrument.spreadBps) ? instrument.spreadBps : fallbackSpreadBps,
    slippageBps: Number.isFinite(instrument.slippageBps) ? instrument.slippageBps : fallbackSlippageBps
  };
}
