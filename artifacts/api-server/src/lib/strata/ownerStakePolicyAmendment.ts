import { randomUUID } from "node:crypto";
import { computeV13LiveMoneyPolicyHash, V13_MAX_ENTRY_STAKE_CENTS, type V13ApprovedLiveMoneyPolicy } from "../v13LiveMoneyRisk";
import { digest as v13Digest } from "../v13-production/types";

/**
 * Owner-scoped, audited policy amendment when a production stake exceeds the
 * existing approved policy. Saving the stake does NOT arm or start the bot.
 * All entry/exposure checks remain active and the account's kill switches stay untouched.
 */
export const MIN_OWNER_STAKE_CENTS = 150;
export const OWNER_STAKE_POLICY_CONFIRM = "I_APPROVE_MY_OWN_STAKE_RISK_POLICY_REVISION";

type Row = Record<string, unknown>;
type Tx = { query(sql: string, args?: unknown[]): Promise<{rows: Row[];rowCount?: number | null}>; release(): void };
type Database = { connect(): Promise<Tx> };
export type StakeAmendmentResult =
  | { ok: true; policyId: string; policyVersion: number; stakeRevision: number }
  | { ok: false; reason: string };

const int = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const asText = (v: unknown): string => typeof v === "string" ? v : "";
const asDate = (v: unknown): Date | null => {
  const d = v instanceof Date ? v : new Date(String(v ?? ""));
  return Number.isFinite(d.getTime()) ? d : null;
};

function approvedFromRow(p: Row): V13ApprovedLiveMoneyPolicy | null {
  const required = [
    "version", "capital_limit_cents", "max_entry_stake_cents", "max_entry_all_in_cents",
    "max_open_positions", "max_daily_loss_cents", "max_total_loss_cents",
    "max_quote_age_ms", "max_fee_evidence_age_ms",
  ];
  if (required.some(key => int(p[key]) === null)) return null;
  const r: V13ApprovedLiveMoneyPolicy = {
    id: asText(p.id), version: int(p.version)!, supersedesPolicyId: p.supersedes_policy_id == null ? null : asText(p.supersedes_policy_id),
    state: "APPROVED", strategyVersion: asText(p.strategy_version),
    strategyParameterSetId: asText(p.strategy_parameter_set_id), strategyParameterHash: asText(p.strategy_parameter_hash),
    entryPolicyVersion: p.entry_policy_version == null ? null : asText(p.entry_policy_version),
    championSelectionReviewId: p.champion_selection_review_id == null ? null : asText(p.champion_selection_review_id),
    championSelectionEvidenceHash: p.champion_selection_evidence_hash == null ? null : asText(p.champion_selection_evidence_hash),
    championSelectedBy: p.champion_selected_by == null ? null : asText(p.champion_selected_by),
    championSelectedAt: asDate(p.champion_selected_at),
    capitalLimitCents: int(p.capital_limit_cents)!, maxEntryStakeCents: int(p.max_entry_stake_cents)!,
    maxEntryAllInCents: int(p.max_entry_all_in_cents)!, maxOpenPositions: int(p.max_open_positions)!,
    maxDailyLossCents: int(p.max_daily_loss_cents)!, maxTotalLossCents: int(p.max_total_loss_cents)!,
    maxQuoteAgeMs: int(p.max_quote_age_ms)!, maxFeeEvidenceAgeMs: int(p.max_fee_evidence_age_ms)!,
    feePolicyVersion: p.fee_policy_version == null ? null : asText(p.fee_policy_version),
    feeSourceUrl: p.fee_source_url == null ? null : asText(p.fee_source_url),
    feeFormulaVersion: p.fee_formula_version == null ? null : asText(p.fee_formula_version),
    requireFullDepth: p.require_full_depth === true,
    entryTimeInForce: asText(p.entry_time_in_force), entryLimitSource: asText(p.entry_limit_source),
    policyHash: p.policy_hash == null ? null : asText(p.policy_hash),
    createdBy: asText(p.created_by), approvedBy: p.approved_by == null ? null : asText(p.approved_by),
    approvedAt: asDate(p.approved_at),
  };
  return r;
}

export async function amendOwnedStakePolicy(
  db: Database, ownerId: string, accountId: string, stakeCents: number, expectedRevision: number | null,
  policyConfirmation?: string,
): Promise<StakeAmendmentResult> {
  if (!Number.isSafeInteger(stakeCents) || stakeCents < MIN_OWNER_STAKE_CENTS || stakeCents > V13_MAX_ENTRY_STAKE_CENTS) {
    return {ok:false,reason:"stake_outside_permitted_range"};
  }
  let tx: Tx | null = null;
  let committed = false;
  const reject = (reason: string): StakeAmendmentResult => ({ok:false,reason});
  try {
    tx = await db.connect();
    await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await tx.query("SET LOCAL lock_timeout='1500ms'");
    await tx.query("SET LOCAL statement_timeout='12000ms'");
    const accountRows = await tx.query(`SELECT * FROM public.v13_production_account
      WHERE id=$1 AND owner_user_id=$2::uuid AND subaccount=1 AND exchange_index=2 FOR UPDATE`, [accountId,ownerId]);
    if (accountRows.rows.length !== 1) return reject("execution_account_missing");
    const a = accountRows.rows[0]!;
    if (a.commissioned !== true || a.cash_precision_verified !== true || asText(a.policy_id).length===0) {
      return reject("account_not_commissioned");
    }
    const cash = int(a.cash_micros), reserved = int(a.reserved_micros);
    if (cash===null || reserved===null || reserved>cash ||
        !a.reconciled_at || Date.now() - new Date(String(a.reconciled_at)).getTime() > 15*60_000) {
      return reject("fresh_spendable_cash_unverified");
    }
    if (BigInt(stakeCents)*10000n > BigInt(cash-reserved)) return reject("stake_exceeds_available_cash");
    const count = await tx.query(`SELECT
      (SELECT count(*)::int FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths>0) positions,
      (SELECT count(*)::int FROM public.v13_production_intent WHERE account_id=$1 AND state NOT IN ('TERMINAL','BLOCKED')) unresolved,
      (SELECT count(*)::int FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 AND state='owned' AND heartbeat_at > now()-interval '30 seconds') running`,[accountId]);
    const x = count.rows[0];
    if (count.rows.length!==1 || int(x?.positions)!==0 || int(x?.unresolved)!==0 || int(x?.running)!==0) {
      return reject("stake_exposure_or_worker_active");
    }
    const previousStake = await tx.query(`SELECT revision FROM public.strata_configured_stake
      WHERE execution_account_id=$1 FOR UPDATE`,[accountId]);
    const actualRevision=previousStake.rows.length===1?int(previousStake.rows[0]?.revision):null;
    if (actualRevision !== expectedRevision) return reject("stake_revision_conflict");
    const policies=await tx.query(`SELECT * FROM public.v13_live_money_policy
      WHERE id=$1 AND execution_account_id=$2 AND created_by=$3 AND state='APPROVED' FOR UPDATE`,
      [a.policy_id,accountId,ownerId]);
    if (policies.rows.length!==1) return reject("approved_policy_missing");
    const old=approvedFromRow(policies.rows[0]!);
    if (!old || old.policyHash!==computeV13LiveMoneyPolicyHash(old)) return reject("approved_policy_hash_invalid");
    let next: V13ApprovedLiveMoneyPolicy=old;
    if (stakeCents > old.maxEntryStakeCents) {
    if (policyConfirmation !== OWNER_STAKE_POLICY_CONFIRM) return reject("explicit_owner_risk_policy_consent_required");
    // Existing drafts can occupy the next version: never overwrite or reuse
    // their revision numbers when increasing a commissioned policy.
    const versions=await tx.query(`SELECT COALESCE(MAX(version),0)::int AS last_version
      FROM public.v13_live_money_policy WHERE execution_account_id=$1`,[accountId]);
    const lastVersion=int(versions.rows[0]?.last_version);
    if(lastVersion===null || lastVersion<old.version)return reject("policy_version_unverified");
    const when=new Date();
    next = {
      ...old, id: randomUUID(), supersedesPolicyId: old.id, version: lastVersion+1,
      maxEntryStakeCents: stakeCents,
      maxEntryAllInCents: Math.max(old.maxEntryAllInCents,stakeCents),
      capitalLimitCents: Math.max(old.capitalLimitCents,stakeCents),
      maxDailyLossCents: Math.max(old.maxDailyLossCents,stakeCents),
      maxTotalLossCents: Math.max(old.maxTotalLossCents,stakeCents),
      approvedBy: ownerId, approvedAt: when, createdBy: ownerId,
    };
    if(next.maxEntryAllInCents>next.capitalLimitCents) next.capitalLimitCents=next.maxEntryAllInCents;
    next.policyHash=computeV13LiveMoneyPolicyHash(next);
    const revoked=await tx.query(`UPDATE public.v13_live_money_policy SET state='REVOKED'
      WHERE id=$1 AND execution_account_id=$2 AND state='APPROVED' AND policy_hash=$3 RETURNING id`,
      [old.id,accountId,old.policyHash]);
    if(revoked.rows.length!==1)return reject("policy_concurrency_conflict");
    const inserted=await tx.query(`INSERT INTO public.v13_live_money_policy
      (id,version,supersedes_policy_id,state,execution_account_id,created_by,
       strategy_version,strategy_parameter_set_id,strategy_parameter_hash,entry_policy_version,
       champion_selection_review_id,champion_selection_evidence_hash,champion_selected_by,champion_selected_at,
       capital_limit_cents,max_entry_stake_cents,max_entry_all_in_cents,max_open_positions,
       max_daily_loss_cents,max_total_loss_cents,max_quote_age_ms,max_fee_evidence_age_ms,
       fee_policy_version,fee_source_url,fee_formula_version,require_full_depth,
       entry_time_in_force,entry_limit_source,policy_hash,approved_by,approved_at)
      SELECT $1,$2,p.id,'APPROVED',p.execution_account_id,$3,
       p.strategy_version,p.strategy_parameter_set_id,p.strategy_parameter_hash,p.entry_policy_version,
       p.champion_selection_review_id,p.champion_selection_evidence_hash,p.champion_selected_by,p.champion_selected_at,
       $4,$5,$6,p.max_open_positions,$7,$8,p.max_quote_age_ms,p.max_fee_evidence_age_ms,
       p.fee_policy_version,p.fee_source_url,p.fee_formula_version,p.require_full_depth,
       p.entry_time_in_force,p.entry_limit_source,$9,$3,$10::timestamptz
      FROM public.v13_live_money_policy p WHERE p.id=$11 AND p.state='REVOKED'
       AND p.execution_account_id=$12 RETURNING id`,[
       next.id,next.version,ownerId,next.capitalLimitCents,next.maxEntryStakeCents,next.maxEntryAllInCents,
       next.maxDailyLossCents,next.maxTotalLossCents,next.policyHash,when.toISOString(),old.id,accountId]);
    if(inserted.rows.length!==1)return reject("policy_revision_not_inserted");
    const amendment={ownerId,accountId,oldPolicyId:old.id,newPolicyId:next.id,
      previousMaxStakeCents:old.maxEntryStakeCents,newMaxStakeCents:stakeCents,
      policyVersion:next.version,confirmation:OWNER_STAKE_POLICY_CONFIRM};
    await tx.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
      VALUES($1,$2,'OWNER_STAKE_POLICY_AMENDMENT',$3::jsonb,$4)`,
      [randomUUID(),accountId,JSON.stringify(amendment),v13Digest(amendment)]);
    const linked=await tx.query(`UPDATE public.v13_production_account SET policy_id=$1,revision=revision+1
      WHERE id=$2 AND owner_user_id=$3::uuid AND policy_id=$4 RETURNING id`,[next.id,accountId,ownerId,old.id]);
    if(linked.rows.length!==1)return reject("policy_revision_link_failed");
    } // Existing smaller stake: retain the approved policy while refreshing owner activation proof.
    const saved=await tx.query(`INSERT INTO public.strata_configured_stake(id,execution_account_id,configured_stake_cents,revision,updated_at)
      VALUES($1,$1,$2,$3,now()) ON CONFLICT (execution_account_id) WHERE execution_account_id IS NOT NULL
      DO UPDATE SET configured_stake_cents=EXCLUDED.configured_stake_cents,
        revision=public.strata_configured_stake.revision+1,updated_at=now()
      WHERE ($4::int IS NOT NULL AND public.strata_configured_stake.revision=$4)
      RETURNING revision`,[accountId,stakeCents,actualRevision===null?1:actualRevision+1,expectedRevision]);
    if(saved.rows.length!==1)return reject("stake_revision_conflict");
    const activated=await tx.query(`SELECT EXISTS(SELECT 1 FROM public.v13_production_observation
       WHERE account_id=$1 AND kind='OWNER_ACTIVATION_REQUEST') AS requested`,[accountId]);
    if(activated.rows[0]?.requested===true) {
      const payload={accountId,policyId:next.id,feeDigest:asText(a.fee_artifact_digest),
        stakeCents,commissioningDigest:asText(a.commissioning_digest),
        minimumExitMicros:int(a.minimum_exit_micros)};
      await tx.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
        VALUES($1,$2,'OWNER_ACTIVATION_REQUEST',$3::jsonb,$4)`,
        [randomUUID(),accountId,JSON.stringify(payload),v13Digest(payload)]);
    }
    await tx.query("COMMIT");
    committed=true;
    return {ok:true,policyId:next.id,policyVersion:next.version,stakeRevision:int(saved.rows[0]?.revision)!};
  } catch {
    return reject("stake_policy_transaction_failed");
  } finally {
    if(tx){if(!committed)try{await tx.query("ROLLBACK");}catch{} tx.release();}
  }
}
