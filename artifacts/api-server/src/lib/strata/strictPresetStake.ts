import { V13_MAX_ENTRY_STAKE_CENTS, V13_MIN_ENTRY_STAKE_CENTS } from "../v13LiveMoneyRisk";
import {
  scaleSharedRiskPreset, type SharedPreset, type ScaledPolicyLimits,
} from "./sharedPresets";

/**
 * Fixed-ratio mode: the authenticated owner chooses one named risk template
 * and an authorized capital budget. The server, never the browser, derives
 * stake and all policy ceilings using exact integer-cent arithmetic.
 * Manual entries cannot raise the chosen preset's stake allocation.
 */
export type StrictPresetSelection = {
  presetId: string;
  presetRevision: number;
  capitalBudgetCents: number;
};
export type StrictPresetDecision =
  | {ok:true;limits:ScaledPolicyLimits;stakeCents:number;selection:StrictPresetSelection}
  | {ok:false;reason:string};

export function resolveStrictPresetStake(
  preset:SharedPreset, selection:StrictPresetSelection, verifiedCashCents:number,
  requestedStakeCents:number,
):StrictPresetDecision {
  if (selection.presetId !== preset.id ||
      !Number.isSafeInteger(selection.presetRevision) ||
      selection.presetRevision !== preset.revision) {
    return {ok:false,reason:"selected_risk_preset_revision_changed"};
  }
  if (!Number.isSafeInteger(verifiedCashCents) || verifiedCashCents < 0 ||
      !Number.isSafeInteger(selection.capitalBudgetCents) ||
      selection.capitalBudgetCents < 150 ||
      selection.capitalBudgetCents > verifiedCashCents) {
    return {ok:false,reason:"risk_capital_budget_exceeds_fresh_cash"};
  }
  const result=scaleSharedRiskPreset(preset,selection.capitalBudgetCents);
  if(!result.ok)return {ok:false,reason:result.reason};
  const stake=result.limits.maxEntryStakeCents;
  if (stake<V13_MIN_ENTRY_STAKE_CENTS || stake>V13_MAX_ENTRY_STAKE_CENTS) {
    return {ok:false,reason:"selected_preset_stake_outside_live_range"};
  }
  if (!Number.isSafeInteger(requestedStakeCents) ||
      requestedStakeCents !== stake) {
    return {ok:false,reason:"stake_must_match_selected_proportional_preset"};
  }
  if (result.limits.maxEntryAllInCents > verifiedCashCents ||
      result.limits.capitalLimitCents > verifiedCashCents) {
    return {ok:false,reason:"preset_all_in_risk_exceeds_available_cash"};
  }
  return {ok:true,limits:result.limits,stakeCents:stake,selection};
}
