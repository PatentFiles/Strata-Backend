import {platformFeeUploadEnabled} from "./platformFeeUploadMode";
import {readActiveUploadedFeeSchedule} from "./platformUploadedFeeSchedule";
import {pool,type PoolClient} from "@workspace/db";
import {V13_CHAMPION_PARAMETER_HASH} from "@workspace/v13-strategy";
import {digest} from "../v13-production/types";
import {dedicatedSignerFingerprint} from "./commissioning";
import {deployedGitSha} from "./deployedGitSha";
import {publicSelfServiceReleaseQualified} from "./ownerSelfServiceEligibility";
import {inspectOwnerAccountOnboardingReadiness} from "./ownerAccountOnboardingReadiness";
import {loadedMaterial} from "./inAppProtectiveRelease";
import {loadCapitalTransferSigner} from "./capitalCreditTransferSigner";
import {registeredReceipt,proveRegisteredOpeningEvidence} from "./registeredOpeningCapitalProof";
import {readCapitalTransfers} from "./capitalCreditTransfers";
import {getScopedKalshiJson} from "../kalshiAccountClient";
import {readOwnedKalshiFeeds,personalAccountSnapshot} from "./personalExchangeRead";
import {STANDARD_PROPORTIONAL_PRESET,TEST_TWENTY_PERCENT_PRESET,scaleSharedRiskPreset} from "./sharedPresets";
import {resolveStrictPresetStake} from "./strictPresetStake";
import {authorizeOwnedPolicy,createOwnedPolicyDraft,persistOwnedPolicyApproval,APPROVE_OWNED_POLICY_CONFIRMATION} from "./personalPolicyApproval";
import {REVIEWED_RELEASE} from "./reviewedRelease";
import {CANONICAL_FEE_SCHEDULE_URL,STANDARD_QUADRATIC_FEE_FORMULA_VERSION,STANDING_FEE_POLICY_VERSION} from "../microLiveFeeArtifact";
import {verifyMonetaryFeeContract} from "./monetaryFeeContract";

export const REVIEW_INITIAL_RISK="REVIEW_PUBLIC_INITIAL_RISK_V1";
export const APPROVE_INITIAL_RISK="APPROVE_PUBLIC_INITIAL_RISK_V1";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
type Q={query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
const no=(reason:string)=>({ok:false as const,version:"PUBLIC_INITIAL_RISK_V1" as const,reason,
 policyRecorded:false as const,review:null,tradingAuthorized:false as const,ordersSubmitted:false as const,workerStarted:false as const,transferAttempted:false as const});
function requireCondition(v:unknown,reason:string):asserts v{if(!v)throw Error(reason);}
function safe(e:unknown){return e instanceof Error&&/^[a-z][a-z0-9_]{1,110}$/.test(e.message)?e.message:"initial_risk_evidence_or_database_unavailable";}
export function parseInitialRiskConsent(owner:string,raw:unknown){
 if(!UUID.test(owner)||!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const b=raw as Record<string,unknown>;
 const preview=b.confirmation===REVIEW_INITIAL_RISK,confirm=b.confirmation===APPROVE_INITIAL_RISK;
 const keys=Object.keys(b).sort().join(",");
 if(b.expectedOwnerId!==owner||(!preview&&!confirm)||
  (preview?keys!=="capitalBudgetCents,confirmation,expectedOwnerId,presetId,presetRevision":
   keys!=="capitalBudgetCents,confirmation,expectedOwnerId,presetId,presetRevision,scopeDigest"||!HASH.test(String(b.scopeDigest))))return null;
 const preset=[STANDARD_PROPORTIONAL_PRESET,TEST_TWENTY_PERCENT_PRESET].find(p=>p.id===b.presetId);
 if(!preset||b.presetRevision!==preset.revision||typeof b.capitalBudgetCents!=="number"||
   !Number.isSafeInteger(b.capitalBudgetCents)||b.capitalBudgetCents<150)return null;
 const scaled=scaleSharedRiskPreset(preset,b.capitalBudgetCents);
 if(!scaled.ok||scaled.limits.maxEntryStakeCents<500)return null;
 return {preview,scopeDigest:confirm?String(b.scopeDigest):null,preset,
  selection:{presetId:preset.id,presetRevision:preset.revision,capitalBudgetCents:b.capitalBudgetCents},limits:scaled.limits};
}
type Selection=NonNullable<ReturnType<typeof parseInitialRiskConsent>>;
/** Initial risk setup precedes first policy link; it cannot require an approved
 * policy as a prerequisite to creating that policy. Never replace a saved policy
 * or stake. Only verified never-traded opening funding is admitted here. */
async function local(db:Q,owner:string,lock=false){
 const tail=lock?" FOR SHARE":"";
 const rows=await db.query("SELECT a.*,a.owner_user_id::text AS owner_id,a.revision::text AS revision_text "+
  "FROM public.v13_production_account a JOIN auth.users u ON u.id=a.owner_user_id "+
  "WHERE a.owner_user_id=$1::uuid AND u.email_confirmed_at IS NOT NULL "+
  "AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp()) "+
  "AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2"+(lock?" FOR UPDATE OF a":""),[owner]);
 requireCondition(rows.rows.length===1,"initial_risk_owner_scope_unverified");
 const a=rows.rows[0]!,id=String(a.id);
 requireCondition(a.policy_id===null&&a.commissioned===false&&a.execution_enabled===false&&a.kill_switch===true&&
  (a.blocked_reason===null||a.blocked_reason==="awaiting_account_commissioning")&&String(a.reserved_micros)==="0"&&
  String(a.cash_micros)===String(a.initial_cash_micros)&&HASH.test(String(a.key_fingerprint)),"initial_risk_stopped_new_account_required");
 const status=await inspectOwnerAccountOnboardingReadiness(owner,{db});
 requireCondition(status.ok&&status.emailVerified&&status.ownedAccountUnique&&status.keyInventory.connection==="saved"&&
  status.credentials.allFourRecorded&&status.funding.historicalOrCompletedTransferRecorded&&!status.policy.approvedRecord&&
  status.openingBasis?.differenceMicros==="0","initial_risk_verified_technical_and_funding_scope_required");
 // Independently pin all verified credential identities, not merely their roles.
 const creds=await db.query("SELECT c.id::text,c.role,c.key_fingerprint,c.vault_secret_id::text,pc.id::text AS connection_id "+
  "FROM public.financial_accounts f JOIN private.provider_connections pc ON pc.financial_account_id=f.id "+
  "JOIN private.kalshi_connection_credentials c ON c.financial_account_id=f.id AND c.provider_connection_id=pc.id AND c.owner_user_id=f.user_id "+
  "WHERE f.id=$1 AND f.user_id=$2::uuid AND f.provider='kalshi' AND c.revoked_at IS NULL "+
  "AND c.verified_at<=clock_timestamp() AND c.verification_reason='credential_verified' "+
  "AND c.vault_secret_id IS NOT NULL AND c.vault_secret_id<>pc.vault_secret_id AND pc.vault_secret_id IS NOT NULL "+
  "ORDER BY c.role"+(lock?" FOR SHARE OF f,pc,c":""),[a.kalshi_connection_id,owner]);
 requireCondition(creds.rows.length===4&&new Set(creds.rows.map(c=>c.role)).size===4&&
  new Set(creds.rows.map(c=>c.key_fingerprint)).size===4&&new Set(creds.rows.map(c=>c.vault_secret_id)).size===4&&
  creds.rows.every(c=>HASH.test(String(c.key_fingerprint)))&&
  creds.rows.some(c=>c.role==="restricted_execution"&&c.key_fingerprint===a.key_fingerprint),"initial_risk_credential_scope_unverified");
 for(const [table,column] of [
  ["public.v13_live_money_policy","execution_account_id"],
  ["public.strata_configured_stake","execution_account_id"],
  ["public.v13_production_intent","account_id"],["public.v13_production_event","account_id"],
  ["public.v13_production_position","account_id"],["private.strata_emergency_exit_reservations","execution_account_id"],
  ["private.kalshi_owner_topups","execution_account_id"]] as const){
  const filter=table==="public.v13_live_money_policy"?" AND state='APPROVED'":"";
  const r=await db.query("SELECT 1 FROM "+table+" WHERE "+column+"=$1"+filter+" LIMIT 1"+tail,[id]);
  requireCondition(r.rows.length===0,"initial_risk_existing_approval_or_history_preserved");
 }
 const workers=await db.query("SELECT owner_user_id::text,state,account_kill,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1"+(lock?" FOR UPDATE":""),[id]);
 requireCondition(workers.rows.length===0||(workers.rows.length===1&&workers.rows[0]!.owner_user_id===owner&&
  workers.rows[0]!.state==="killed"&&workers.rows[0]!.account_kill===true&&workers.rows[0]!.arm_requested===false),"initial_risk_worker_not_stopped");
 const pilot=(await db.query("SELECT * FROM private.kalshi_owner_pilot_transfers WHERE execution_account_id=$1 LIMIT 2"+tail,[id])).rows;
 const historical=(await db.query("SELECT * FROM private.kalshi_owner_historical_funding WHERE execution_account_id=$1 LIMIT 2"+tail,[id])).rows;
 const receipt=registeredReceipt(pilot,historical,owner,a);
 const registrations=await db.query("SELECT 1 FROM private.kalshi_owner_pilot_transfers WHERE verified_exchange_transfer_id=$1 UNION ALL SELECT 1 FROM private.kalshi_owner_historical_funding WHERE exchange_transfer_id=$1 UNION ALL SELECT 1 FROM private.kalshi_owner_topup_legs WHERE exchange_transfer_id=$1",[receipt.receiptId]);
 requireCondition(registrations.rows.length===1,"initial_risk_funding_receipt_ambiguous");
 const signer=await loadCapitalTransferSigner(db,a,lock);
 requireCondition(!receipt.providerConnectionId||receipt.providerConnectionId===signer.bindings.setup.providerConnectionId,"initial_risk_receipt_connection_changed");
 return {a,id,receipt,signer,credentialDigest:digest(creds.rows)};
}
function identity(scope:Awaited<ReturnType<typeof local>>){
 return {accountId:scope.id,revision:String(scope.a.revision_text),keyFingerprint:String(scope.a.key_fingerprint),
  fundingReceiptDigest:scope.receipt.registryDigest,signerBindingDigest:digest(scope.signer.bindings),
  credentialDigest:scope.credentialDigest,cashMicros:String(scope.a.cash_micros),initialCashMicros:String(scope.a.initial_cash_micros)};
}
async function proof(owner:string,choice:Selection,sha:string){
 const before=await local(pool,owner),material=await loadedMaterial(pool,before.a);
 requireCondition(material&&dedicatedSignerFingerprint(material.keyId,material.privateKey)===before.a.key_fingerprint,"initial_risk_restricted_signer_unverified");
 const now=Date.now(),deadline=performance.now()+15000,signal=AbortSignal.timeout(15000);
 const [feeds,transfers,fee]=await Promise.all([
  readOwnedKalshiFeeds(material,now,undefined,{mode:"bounded_history_reads_v1",signal}),
  readCapitalTransfers((path,q)=>getScopedKalshiJson(before.signer.material,path,q,fetch,"https://external-api.kalshi.com",owner,signal),now),
  verifyMonetaryFeeContract("STEP_9"),
 ]);
 requireCondition(feeds.ok&&Date.now()-now<=15000&&performance.now()<=deadline,"initial_risk_signed_evidence_unavailable");
 proveRegisteredOpeningEvidence(before.receipt,feeds.cashMicros,feeds,transfers,now);
 const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:String(before.a.key_fingerprint)},feeds,[]);
 requireCondition("identity" in snapshot&&snapshot.authenticated&&snapshot.complete&&snapshot.cashExact&&!snapshot.unexplainedCashActivity,"initial_risk_signed_account_unverified");
 requireCondition(fee.ok&&fee.monetaryFeeAuthorized&&typeof fee.sourceDigest==="string"&&HASH.test(fee.sourceDigest),"initial_risk_current_monetary_fees_unverified");
 const actual=BigInt(feeds.cashMicros)/10000n;
 requireCondition(actual>=2500n&&actual<=BigInt(Number.MAX_SAFE_INTEGER),"initial_risk_initial_capital_outside_supported_range");
 const chosen=resolveStrictPresetStake(choice.preset,choice.selection,Number(actual),choice.limits.maxEntryStakeCents);
 requireCondition(chosen.ok&&chosen.stakeCents>=500,"initial_risk_selected_budget_or_stake_unverified");
 const key=identity(before),current=await local(pool,owner);
 requireCondition(digest(identity(current))===digest(key)&&performance.now()<=deadline,"initial_risk_scope_changed");
 const core={ownerId:owner,accountId:before.id,releaseSha:sha,presetId:choice.preset.id,presetRevision:choice.preset.revision,
  capitalBudgetCents:choice.selection.capitalBudgetCents,stakeCents:chosen.stakeCents,cashMicros:feeds.cashMicros,
  limits:chosen.limits,maxOpenPositions:1,feeDigest:fee.sourceDigest,feeFormulaVersion:STANDARD_QUADRATIC_FEE_FORMULA_VERSION,
  ...(fee.sourceKind?{feeSourceKind:fee.sourceKind,feeEffectiveDate:fee.sourceEffectiveDate,feeSourceAuthenticityVerified:false}: {})};
 return {review:{...core,scopeDigest:digest({core,key})},key,deadline,now};
}
export function publicInitialRiskAction(owner:string,raw:unknown){
 return executeInitialRiskAction(owner,raw,0);
}
async function executeInitialRiskAction(owner:string,raw:unknown,attempt:number):Promise<ReturnType<typeof no>|(Omit<ReturnType<typeof no>,"ok"|"review">&{ok:true;review:Awaited<ReturnType<typeof proof>>["review"]})|(Omit<ReturnType<typeof no>,"ok"|"policyRecorded">&{ok:true;policyRecorded:true})>{
 const choice=parseInitialRiskConsent(owner,raw),sha=deployedGitSha();
 if(!choice)return no("initial_risk_exact_owner_consent_required");
 if(!publicSelfServiceReleaseQualified(sha))return no("public_self_service_release_not_qualified");
 let tx:PoolClient|undefined,committed=false,commitSent=false,discard:Error|undefined;
 try{
  const evidence=await proof(owner,choice,sha);
  if(choice.preview)return {...no("initial_risk_review_ready"),ok:true as const,review:evidence.review};
  if(evidence.review.scopeDigest!==choice.scopeDigest)return no("initial_risk_review_scope_changed");
  tx=await pool.connect();await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await tx.query("SET LOCAL lock_timeout='1500ms'");await tx.query("SET LOCAL statement_timeout='8000ms'");
  const current=await local(tx,owner,true);
  requireCondition(digest(identity(current))===digest(evidence.key)&&performance.now()<=evidence.deadline&&Date.now()-evidence.now<=15000&&deployedGitSha()===sha,"initial_risk_signed_scope_expired_or_changed");
  // Lock the original publication identity against concurrent capture changes.
  await tx.query("SELECT pg_advisory_xact_lock_shared(1958371201,1)");
  if(platformFeeUploadEnabled()){
    const uploaded=await readActiveUploadedFeeSchedule(tx);
    requireCondition(uploaded&&uploaded.digest===evidence.review.feeDigest,"initial_risk_uploaded_publication_changed");
   }else{
   const publication=await tx.query("SELECT content_sha256,effective_date IS NOT NULL AND expires_at>clock_timestamp() AND captured_at<=clock_timestamp() AS current "+
    "FROM private.strata_platform_official_fee_capture_v1 ORDER BY captured_at DESC,capture_id DESC LIMIT 1");
  requireCondition(publication.rows.length===1&&publication.rows[0]!.content_sha256===evidence.review.feeDigest&&publication.rows[0]!.current===true,"initial_risk_issuer_publication_changed");
   }
  const draft=await createOwnedPolicyDraft(tx,{ownerUserId:owner,executionAccountId:current.id,limits:evidence.review.limits});
  requireCondition(draft.ok,"initial_risk_draft_unavailable");
  const at=new Date();
  const approved=authorizeOwnedPolicy({ownerUserId:owner,executionAccountId:current.id,policyId:draft.policyId,version:draft.version,
   confirmation:APPROVE_OWNED_POLICY_CONFIRMATION,limits:evidence.review.limits,
   fee:{policyVersion:STANDING_FEE_POLICY_VERSION,sourceUrl:CANONICAL_FEE_SCHEDULE_URL,formulaVersion:STANDARD_QUADRATIC_FEE_FORMULA_VERSION},
   champion:{reviewId:REVIEWED_RELEASE.commit,evidenceHash:V13_CHAMPION_PARAMETER_HASH,selectedBy:owner,selectedAt:new Date(at.getTime()-1)},approvedAt:at});
  requireCondition(approved.ok,"initial_risk_policy_validation_failed");
  const client=tx;
  // Reuse policy persistence inside the same enclosing transaction.
  const saved=await persistOwnedPolicyApproval({query:(s,p)=>client.query(s,p),transaction:work=>work((s,p)=>client.query(s,p))},
   {ownerUserId:owner,executionAccountId:current.id,policy:approved.policy});
  requireCondition(saved.ok,"initial_risk_policy_write_refused");
  const stake=await tx.query("INSERT INTO public.strata_configured_stake "+
   "(id,execution_account_id,configured_stake_cents,revision,updated_at,risk_preset_id,risk_preset_revision,risk_capital_cents) "+
   "VALUES($1,$1,$2,1,clock_timestamp(),$3,$4,$5) RETURNING revision",[current.id,evidence.review.stakeCents,
   choice.preset.id,choice.preset.revision,choice.selection.capitalBudgetCents]);
  requireCondition(stake.rows.length===1&&performance.now()<=evidence.deadline,"initial_risk_stake_write_or_evidence_expired");
  commitSent=true;await tx.query("COMMIT");committed=true;
  return {...no("initial_risk_policy_and_stake_recorded"),ok:true as const,policyRecorded:true as const};
 }catch(e){
  // PostgreSQL 40001/40P01 explicitly abort the transaction, including a
  // rejected COMMIT. Retry the entire operation and fresh signed proof, never
  // just its last statement. A lost connection/unknown COMMIT is not retried.
  const code=e&&typeof e==="object"&&"code" in e?e.code:null;
  if(tx&&(code==="40001"||code==="40P01")){
   try{await tx.query("ROLLBACK");}catch{discard=Error("initial_risk_rollback_unknown");return no("initial_risk_commit_unknown_refresh_records");}
   tx.release();tx=undefined;
   if(attempt>=2)return no("initial_risk_concurrency_retry_exhausted");
   return executeInitialRiskAction(owner,raw,attempt+1);
  }
  if(commitSent){discard=Error("initial_risk_commit_unknown");return no("initial_risk_commit_unknown_refresh_records");}return no(safe(e));
 }
 finally{if(tx){if(!committed&&!discard)try{await tx.query("ROLLBACK");}catch{discard=Error("initial_risk_rollback_unknown");}tx.release(discard);}}
}
