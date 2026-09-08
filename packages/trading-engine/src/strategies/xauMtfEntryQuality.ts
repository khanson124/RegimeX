/**
 * Transparent additive entry-quality score for xau-mtf-structure-momentum-v1.
 * Components are explicit; no ML / black-box weights.
 */
import { type HtfStructureSnapshot } from "./htfStructure.js";
import { type ImpulsePullbackSnapshot } from "./impulsePullback.js";

export interface EntryQualityComponents {
  htfStructure: number;
  pullbackQuality: number;
  continuationStrength: number;
  structuralRoom: number;
  extensionPenalty: number;
  impulseMaturityPenalty: number;
}

export interface EntryQualityResult {
  score: number;
  components: EntryQualityComponents;
  pass: boolean;
}

export function scoreEntryQuality(input: {
  htf: HtfStructureSnapshot;
  phase: ImpulsePullbackSnapshot;
  continuationStrength: number;
  structureRoomR: number | null;
  minPullbackAtr: number;
  maxExtensionAtr: number;
  minRoomR: number;
  minScore: number;
}): EntryQualityResult {
  const components: EntryQualityComponents = {
    htfStructure: 0,
    pullbackQuality: 0,
    continuationStrength: 0,
    structuralRoom: 0,
    extensionPenalty: 0,
    impulseMaturityPenalty: 0
  };

  // HTF: 0–2
  if (input.htf.state !== "NEUTRAL") {
    components.htfStructure = 1 + Math.min(1, input.htf.strength);
  }

  // Pullback: 0–2
  const depth = input.phase.pullbackDepthAtr ?? 0;
  const pct = input.phase.pullbackPercentOfImpulse ?? 0;
  if (input.phase.phase === "PULLBACK") {
    components.pullbackQuality = 1;
    if (depth >= input.minPullbackAtr) components.pullbackQuality += 0.5;
    if (pct >= 0.25 && pct <= 0.7) components.pullbackQuality += 0.5;
  }

  // Continuation: 0–2 (caller-normalized 0–1)
  components.continuationStrength = Math.max(0, Math.min(2, input.continuationStrength * 2));

  // Room: 0–2
  if (input.structureRoomR != null) {
    if (input.structureRoomR >= input.minRoomR) components.structuralRoom = 2;
    else if (input.structureRoomR >= input.minRoomR * 0.75) components.structuralRoom = 1;
  }

  // Extension penalty: 0 to -2
  const ext = input.phase.impulseDistanceAtr ?? 0;
  if (ext > input.maxExtensionAtr) {
    components.extensionPenalty = -2;
  } else if (ext > input.maxExtensionAtr * 0.8) {
    components.extensionPenalty = -1;
  }

  // Maturity: long pullback wait without reset
  const bars = input.phase.barsSinceImpulseExtreme ?? 0;
  if (bars > 20) components.impulseMaturityPenalty = -1;
  if (bars > 35) components.impulseMaturityPenalty = -2;

  const score = Number(
    (
      components.htfStructure +
      components.pullbackQuality +
      components.continuationStrength +
      components.structuralRoom +
      components.extensionPenalty +
      components.impulseMaturityPenalty
    ).toFixed(4)
  );

  return {
    score,
    components,
    pass: score >= input.minScore
  };
}

export function sessionContextFromEpochMs(epochMs: number): {
  hourUtc: number;
  session: "ASIA" | "LONDON" | "LONDON_NY_OVERLAP" | "NEW_YORK" | "OFF_HOURS";
} {
  const hourUtc = new Date(epochMs).getUTCHours();
  let session: "ASIA" | "LONDON" | "LONDON_NY_OVERLAP" | "NEW_YORK" | "OFF_HOURS";
  if (hourUtc >= 0 && hourUtc < 7) session = "ASIA";
  else if (hourUtc >= 7 && hourUtc < 12) session = "LONDON";
  else if (hourUtc >= 12 && hourUtc < 16) session = "LONDON_NY_OVERLAP";
  else if (hourUtc >= 16 && hourUtc < 21) session = "NEW_YORK";
  else session = "OFF_HOURS";
  return { hourUtc, session };
}
