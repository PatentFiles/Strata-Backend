/**
 * Issue #165: validate the already-persisted, versioned stake-policy snapshot.
 * Users choose $5–$25,000 and a named allocation in Dashboard. The authenticated
 * owner stake-amendment transaction separately re-resolves and versions the
 * original preset/revision. Fee consent must bind THAT approved snapshot,
 * not assume a fixed amount or hardcoded allocation.
 *
 * This pure check confers NO trading rights. The V4 final signed POST remains
 * separately fail-closed until current fee and exit authority is integrated.
 */
import {V13_MAX_ENTRY_STAKE_CENTS,V13_MIN_ENTRY_STAKE_CENTS} from "../v13LiveMoneyRisk";
import {DYNAMIC_FEE_POLICY_VERSION_V4} from "./dynamicFeeOrderRiskV4";

type Row=Record<string,unknown>;
const integer=(x:unknown):number|null=>{
 if(typeof x==="number")return Number.isSafeInteger(x)?x:null;
 if(typeof x==="string"&&/^(0|[1-9]\d*)$/.test(x)){
  const n=Number(x);return Number.isSafeInteger(n)?n:null;
 }
 return null;
};
export function approvedDynamicStakeSnapshot(p:Row):{ok:boolean;stakeCents:number|null;capitalCents:number|null}{
 const stake=integer(p.configured_stake_cents);
 const policyStake=integer(p.max_entry_stake_cents);
 const allIn=integer(p.max_entry_all_in_cents);
 const capital=integer(p.capital_limit_cents);
 const budget=integer(p.risk_capital_cents);
 const daily=integer(p.max_daily_loss_cents);
 const total=integer(p.max_total_loss_cents);
 const revision=integer(p.risk_preset_revision);
 const presetId=p.risk_preset_id;
 const valid=
   p.fee_policy_version===DYNAMIC_FEE_POLICY_VERSION_V4&&
   p.state==="APPROVED"&&
   typeof p.policy_hash==="string"&&/^[a-f0-9]{64}$/.test(p.policy_hash)&&
   stake!==null&&stake>=V13_MIN_ENTRY_STAKE_CENTS&&stake<=V13_MAX_ENTRY_STAKE_CENTS&&
   policyStake===stake&&
   allIn!==null&&allIn>=stake&&
   capital!==null&&capital>=allIn&&
   budget!==null&&budget===capital&&
   daily!==null&&daily>0&&daily<=capital&&
   total!==null&&total>0&&total<=capital&&
   typeof presetId==="string"&&presetId.length>0&&presetId.length<=120&&
   revision!==null&&revision>=1;
 return {ok:valid,stakeCents:valid?stake:null,capitalCents:valid?budget:null};
}
