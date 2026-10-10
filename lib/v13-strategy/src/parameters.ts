export type V13StrategyParameters = {
  scoutMinSeparation: number;
  scoutMaxSeparation: number;
  confirmMinSeparation: number;
  scoutMaxOffer: number;
  confirmMaxOffer: number;
  wrongSideRecrossSeparation: number;
  exitOnMomentumInvalidation: boolean;
};

export type V13StrategyParameterSet = {
  id: string;
  label: string;
  classifierVersion: "V1.3";
  parameters: V13StrategyParameters;
};

/**
 * Immutable execution champion. Existing execution behavior must continue to
 * call evaluateV13Strategy(), which is bound to this exact parameter set.
 *
 * Research/challenger parameter sets must use evaluateV13StrategyWithParameters()
 * and are never execution authority by themselves.
 */
/**
 * SHA-256 of canonicalV13StrategyParameters(V13_CHAMPION_PARAMETER_SET.parameters).
 * Kept as a literal so browser/shared strategy code does not depend on Node crypto.
 * Server-side tests verify the literal against the canonical serialization.
 */
export const V13_CHAMPION_PARAMETER_HASH =
  "314e7b49f5cd9782175dbb88fb7a05bbf80bb4c5e1458d0d48a15348b35f6161";

export const V13_CHAMPION_PARAMETER_SET: V13StrategyParameterSet = Object.freeze({
  id: "v13-champion-2-c52-confirm53",
  label: "V1.3 C52/53 launch champion",
  classifierVersion: "V1.3",
  parameters: Object.freeze({
    scoutMinSeparation: 8,
    scoutMaxSeparation: 15,
    confirmMinSeparation: 20,
    scoutMaxOffer: 0.52,
    confirmMaxOffer: 0.53,
    wrongSideRecrossSeparation: 8,
    exitOnMomentumInvalidation: true,
  }),
});

/**
 * Research presets derived from the 267-trade review. They are intentionally
 * not execution defaults. Activating one for shadow study requires an explicit,
 * versioned research parameter-set record.
 */
export const V13_RESEARCH_PRESETS = Object.freeze({
  LEGACY_60_68: Object.freeze({
    scoutMinSeparation: 8,
    scoutMaxSeparation: 15,
    confirmMinSeparation: 20,
    scoutMaxOffer: 0.60,
    confirmMaxOffer: 0.68,
    wrongSideRecrossSeparation: 8,
    exitOnMomentumInvalidation: true,
  }) satisfies V13StrategyParameters,
  C52_CONFIRM55: Object.freeze({
    scoutMinSeparation: 8,
    scoutMaxSeparation: 15,
    confirmMinSeparation: 20,
    scoutMaxOffer: 0.52,
    confirmMaxOffer: 0.55,
    wrongSideRecrossSeparation: 8,
    exitOnMomentumInvalidation: true,
  }) satisfies V13StrategyParameters,
  C52_CONFIRM53: Object.freeze({
    scoutMinSeparation: 8,
    scoutMaxSeparation: 15,
    confirmMinSeparation: 20,
    scoutMaxOffer: 0.52,
    confirmMaxOffer: 0.53,
    wrongSideRecrossSeparation: 8,
    exitOnMomentumInvalidation: true,
  }) satisfies V13StrategyParameters,
  C51_CONFIRM53: Object.freeze({
    scoutMinSeparation: 8,
    scoutMaxSeparation: 15,
    confirmMinSeparation: 20,
    scoutMaxOffer: 0.51,
    confirmMaxOffer: 0.53,
    wrongSideRecrossSeparation: 8,
    exitOnMomentumInvalidation: true,
  }) satisfies V13StrategyParameters,
  C57_CONFIRM56: Object.freeze({
    scoutMinSeparation: 8,
    scoutMaxSeparation: 15,
    confirmMinSeparation: 20,
    scoutMaxOffer: 0.57,
    confirmMaxOffer: 0.56,
    wrongSideRecrossSeparation: 8,
    exitOnMomentumInvalidation: true,
  }) satisfies V13StrategyParameters,
  C50: Object.freeze({
    scoutMinSeparation: 8,
    scoutMaxSeparation: 15,
    confirmMinSeparation: 20,
    scoutMaxOffer: 0.50,
    confirmMaxOffer: 0.50,
    wrongSideRecrossSeparation: 8,
    exitOnMomentumInvalidation: true,
  }) satisfies V13StrategyParameters,
  C50_CONFIRM22: Object.freeze({
    scoutMinSeparation: 8,
    scoutMaxSeparation: 15,
    confirmMinSeparation: 22,
    scoutMaxOffer: 0.50,
    confirmMaxOffer: 0.50,
    wrongSideRecrossSeparation: 8,
    exitOnMomentumInvalidation: true,
  }) satisfies V13StrategyParameters,
});

const finite = (value: number) => Number.isFinite(value);

export function assertV13StrategyParameters(
  parameters: V13StrategyParameters,
): V13StrategyParameters {
  const separationValues = [
    parameters.scoutMinSeparation,
    parameters.scoutMaxSeparation,
    parameters.confirmMinSeparation,
    parameters.wrongSideRecrossSeparation,
  ];
  if (separationValues.some((value) => !finite(value) || value < 0 || value > 10_000)) {
    throw new Error("V13 strategy separation parameters are invalid");
  }
  if (parameters.scoutMinSeparation > parameters.scoutMaxSeparation) {
    throw new Error("V13 scout minimum separation exceeds its maximum");
  }
  if (parameters.confirmMinSeparation <= parameters.scoutMaxSeparation) {
    throw new Error("V13 confirm separation must remain above the scout band");
  }
  for (const value of [parameters.scoutMaxOffer, parameters.confirmMaxOffer]) {
    if (!finite(value) || value <= 0 || value > 1) {
      throw new Error("V13 strategy offer ceilings must be within (0, 1]");
    }
  }
  if (typeof parameters.exitOnMomentumInvalidation !== "boolean") {
    throw new Error("V13 momentum exit parameter must be boolean");
  }
  return parameters;
}

/**
 * Canonical serialization for audit hashing on the server. Keep field order
 * explicit so hashes do not depend on JavaScript object insertion order.
 */
export function canonicalV13StrategyParameters(
  parameters: V13StrategyParameters,
): string {
  const p = assertV13StrategyParameters(parameters);
  return JSON.stringify({
    scoutMinSeparation: p.scoutMinSeparation,
    scoutMaxSeparation: p.scoutMaxSeparation,
    confirmMinSeparation: p.confirmMinSeparation,
    scoutMaxOffer: p.scoutMaxOffer,
    confirmMaxOffer: p.confirmMaxOffer,
    wrongSideRecrossSeparation: p.wrongSideRecrossSeparation,
    exitOnMomentumInvalidation: p.exitOnMomentumInvalidation,
  });
}


/**
 * Bounded search space for automated prospective challenger generation.
 * C52/53 is the launch champion. The automatic lane may only tighten its
 * entry filters, keeping challenger outcomes as strict subsets of champion
 * entries. Broader historical references require independent outcome evidence.
 * Exit behavior stays frozen.
 */
export const V13_HISTORICAL_TUNING_BOUNDS = Object.freeze({
  scoutMinSeparation: Object.freeze({ min: 8, max: 12, step: 1 }),
  scoutMaxSeparation: Object.freeze({ min: 12, max: 15, step: 1 }),
  confirmMinSeparation: Object.freeze({ min: 20, max: 30, step: 1 }),
  scoutMaxOffer: Object.freeze({ min: 0.45, max: 0.52, step: 0.01 }),
  confirmMaxOffer: Object.freeze({ min: 0.45, max: 0.53, step: 0.01 }),
  wrongSideRecrossSeparation: 8,
  exitOnMomentumInvalidation: true,
});

export function assertV13HistoricalTuningCandidate(
  parameters: V13StrategyParameters,
): V13StrategyParameters {
  const p = assertV13StrategyParameters(parameters);
  const b = V13_HISTORICAL_TUNING_BOUNDS;
  if (
    p.scoutMinSeparation < b.scoutMinSeparation.min ||
    p.scoutMinSeparation > b.scoutMinSeparation.max ||
    p.scoutMaxSeparation < b.scoutMaxSeparation.min ||
    p.scoutMaxSeparation > b.scoutMaxSeparation.max ||
    p.confirmMinSeparation < b.confirmMinSeparation.min ||
    p.confirmMinSeparation > b.confirmMinSeparation.max ||
    p.scoutMaxOffer < b.scoutMaxOffer.min ||
    p.scoutMaxOffer > b.scoutMaxOffer.max ||
    p.confirmMaxOffer < b.confirmMaxOffer.min ||
    p.confirmMaxOffer > b.confirmMaxOffer.max ||
    p.wrongSideRecrossSeparation !== b.wrongSideRecrossSeparation ||
    p.exitOnMomentumInvalidation !== b.exitOnMomentumInvalidation
  ) {
    throw new Error("V13 adaptive candidate is outside the bounded entry-tuning envelope");
  }
  return p;
}
