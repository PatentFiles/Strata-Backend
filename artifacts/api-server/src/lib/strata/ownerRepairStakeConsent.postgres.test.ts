import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {pool as db} from '@workspace/db';
import {amendOwnedStakePolicy,OWNER_STAKE_POLICY_CONFIRM} from './ownerStakePolicyAmendment';
import {repairOwnerV4CommissioningHold,OWNER_V4_REPAIR_CONFIRM} from './ownerV4CommissioningRepair';
import {PROVISIONAL_REPAIR_CONFIRM} from './inAppProtectiveRelease';
import {computeDynamicFeeModelDigest} from './dynamicOfficialFeeSchedule';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
import {V13_CHAMPION_PARAMETER_HASH,V13_CHAMPION_PARAMETER_SET,V13_ENTRY_POLICY_VERSION} from '@workspace/v13-strategy';
import {TEST_TWENTY_PERCENT_PRESET} from './sharedPresets';
const OWNER='11111111-1111-4111-8111-111111111111',ACCOUNT='a',authority='22222222-2222-4222-8222-222222222222',owner=OWNER;
const sha='a'.repeat(40),hash='b'.repeat(64),source='c'.repeat(64),now=Date.now(),ticker='KXBTC15M-26OCT251215';
if(!process.env.DATABASE_URL?.startsWith('postgresql://agent@127.0.0.1:55457/renewal_disposable_'))throw Error('isolated_db_required');
const old:any={
 id:"approved-policy-1",version:1,supersedesPolicyId:null,state:"APPROVED",
 strategyVersion:"V1.3",strategyParameterSetId:V13_CHAMPION_PARAMETER_SET.id,
 strategyParameterHash:V13_CHAMPION_PARAMETER_HASH,entryPolicyVersion:V13_ENTRY_POLICY_VERSION,
 championSelectionReviewId:"independent-champion",championSelectionEvidenceHash:"b".repeat(64),
 championSelectedBy:OWNER,championSelectedAt:new Date("2026-10-01T00:00:00Z"),
 capitalLimitCents:1000,maxEntryStakeCents:150,maxEntryAllInCents:250,maxOpenPositions:1,
 maxDailyLossCents:300,maxTotalLossCents:500,maxQuoteAgeMs:1000,maxFeeEvidenceAgeMs:1000,
 feePolicyVersion:"standing-fee-v1",feeSourceUrl:"https://example.com/official-schedule",
 feeFormulaVersion:"standard-quadratic-0.07-v1",requireFullDepth:true,
 entryTimeInForce:"IOC",entryLimitSource:"SIGNAL_REFERENCE_OFFER",
 policyHash:null,createdBy:OWNER,approvedBy:OWNER,approvedAt:new Date("2026-10-01T01:00:00Z"),
};
old.policyHash=computeV13LiveMoneyPolicyHash(old);
const policyRow={
 id:old.id,version:old.version,state:old.state,supersedes_policy_id:old.supersedesPolicyId,
 strategy_version:old.strategyVersion,strategy_parameter_set_id:old.strategyParameterSetId,
 strategy_parameter_hash:old.strategyParameterHash,entry_policy_version:old.entryPolicyVersion,
 champion_selection_review_id:old.championSelectionReviewId,
 champion_selection_evidence_hash:old.championSelectionEvidenceHash,
 champion_selected_by:old.championSelectedBy,champion_selected_at:old.championSelectedAt,
 capital_limit_cents:old.capitalLimitCents,max_entry_stake_cents:old.maxEntryStakeCents,
 max_entry_all_in_cents:old.maxEntryAllInCents,max_open_positions:old.maxOpenPositions,
 max_daily_loss_cents:old.maxDailyLossCents,max_total_loss_cents:old.maxTotalLossCents,
 max_quote_age_ms:old.maxQuoteAgeMs,max_fee_evidence_age_ms:old.maxFeeEvidenceAgeMs,
 fee_policy_version:old.feePolicyVersion,fee_source_url:old.feeSourceUrl,fee_formula_version:old.feeFormulaVersion,
 require_full_depth:old.requireFullDepth,entry_time_in_force:old.entryTimeInForce,
 entry_limit_source:old.entryLimitSource,policy_hash:old.policyHash,created_by:old.createdBy,
 approved_by:old.approvedBy,approved_at:old.approvedAt,
};
const modelBase={
 issuer:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 publicationDigest:source,effectiveDate:"2026-07-07",
 takerRatePpm:70000,makerRatePpm:17500,
 defaultTakerMultiplierPpm:1000000,defaultMakerMultiplierPpm:0,
 feeType:"quadratic" as const,feeMultiplier:"1" as const,marketTicker:ticker,
 eventTicker:"KXBTC15M-26OCT251215",
};
const modelDigest=computeDynamicFeeModelDigest(modelBase);
const model={...modelBase,metadataDigest:"d".repeat(64),modelDigest,
 observedAt:new Date(now).toISOString(),tradingAuthorized:false as const,
 requiresVersionedReview:true as const};
async function setup(v4=false){
 await db.query('DROP SCHEMA IF EXISTS private CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public;CREATE SCHEMA private');
 const row={...policyRow,execution_account_id:ACCOUNT,capital_limit_cents:2500,max_entry_stake_cents:500,max_entry_all_in_cents:525,max_daily_loss_cents:250,max_total_loss_cents:250,fee_policy_version:v4?'strata_owner_provider_dynamic_fee_v4':policyRow.fee_policy_version};
 // Use actual risk parser/hash, no policy SQL response mocking.
 const {approvedFromRow}=await import('./ownerStakePolicyAmendment');row.policy_hash=computeV13LiveMoneyPolicyHash(approvedFromRow(row)!);
 const columns=Object.entries(row).map(([k,v])=>`"${k}" ${v instanceof Date?'timestamptz':typeof v==='boolean'?'boolean':typeof v==='number'?'integer':'text'}`);
 await db.query(`CREATE TABLE public.v13_live_money_policy(${columns.join(',')},PRIMARY KEY(id));
 CREATE TABLE v13_production_account(id text PRIMARY KEY,owner_user_id uuid,subaccount int,exchange_index int,policy_id text,commissioned boolean,cash_precision_verified boolean,cash_micros bigint,reserved_micros bigint,reconciled_at timestamptz,kill_switch boolean,execution_enabled boolean,blocked_reason text,revision bigint,key_fingerprint text,kalshi_connection_id uuid,fee_artifact_digest text,commissioning_digest text,minimum_exit_micros bigint);
 CREATE TABLE strata_configured_stake(id text,execution_account_id text,configured_stake_cents int,revision int,updated_at timestamptz,risk_preset_id text,risk_preset_revision int,risk_capital_cents int);
 CREATE UNIQUE INDEX stake_unique ON strata_configured_stake(execution_account_id) WHERE execution_account_id IS NOT NULL;
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,state text,arm_requested boolean,account_kill boolean,heartbeat_at timestamptz,fencing_token bigint);
 CREATE TABLE v13_production_position(account_id text,quantity_hundredths bigint);
 CREATE TABLE v13_production_intent(id text,account_id text,state text,terminal boolean,request jsonb,created_at timestamptz);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text,state text);
 CREATE TABLE v13_production_observation(id text PRIMARY KEY,account_id text,kind text,payload jsonb,digest text,observed_at timestamptz DEFAULT now());
 CREATE TABLE private.strata_protective_release_qualification(qualification_id uuid PRIMARY KEY,owner_user_id uuid,execution_account_id text,release_commit_sha text,expires_at timestamptz);
 CREATE TABLE private.strata_owner_sha_approvals(approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid,execution_account_id text,release_commit_sha text,qualification_id uuid,revoked_at timestamptz);
 CREATE TABLE private.strata_wallet_v4_fee_evidence(evidence_id uuid PRIMARY KEY,owner_user_id uuid,execution_account_id text,model_digest text,deployed_sha text,revoked_at timestamptz,expires_at timestamptz,market_ticker text,official_source_digest text);
 CREATE TABLE private.strata_wallet_v4_fee_authority(authority_id uuid PRIMARY KEY,evidence_id uuid,owner_user_id uuid,execution_account_id text,deployed_sha text,policy_hash text,policy_version text,revoked_at timestamptz,aal2_verified_at timestamptz,confirmation text,authorized_stages text[],expires_at timestamptz,model_digest text);`);
 await db.query(`INSERT INTO v13_live_money_policy(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
 await db.query(`INSERT INTO v13_production_account VALUES('a',$1,1,2,$2,true,true,25000000,0,now(),true,false,$3,7,$4,$5,$6,$6,10000)`,[owner,row.id,v4?'awaiting_account_commissioning':null,'e'.repeat(64),authority,hash]);
 await db.query(`INSERT INTO strata_configured_stake VALUES('a','a',500,1,now(),'owner20',1,2500);INSERT INTO private.kalshi_account_worker_lease VALUES('a','${owner}','killed',false,true,now(),5);
 INSERT INTO private.strata_owner_sha_approvals(owner_user_id,execution_account_id,release_commit_sha) VALUES('${owner}','a','${sha}');`);
 await db.query(readFileSync(process.env.CONSENT_SQL!,'utf8'));
 await db.query(`INSERT INTO private.strata_wallet_v4_fee_evidence VALUES($1,$2,'a',$3,$4,NULL,now()+interval '1 hour',$5,$6);`,[authority,owner,modelDigest,sha,ticker,source]);
 await db.query(`INSERT INTO private.strata_wallet_v4_fee_authority VALUES($1,$1,$2,'a',$3,$4,'strata_owner_provider_dynamic_fee_v4',NULL,now(),'I_APPROVE_MY_WALLET_DYNAMIC_FEE_MODEL_V4',ARRAY['ORDER_ENTRY'],now()+interval '1 hour',$5)`,[authority,owner,sha,row.policy_hash,modelDigest]);
 return row;
}
async function state(){return (await db.query(`SELECT jsonb_build_object('account',(SELECT to_jsonb(a) FROM v13_production_account a),'stake',(SELECT to_jsonb(s) FROM strata_configured_stake s),'policy',(SELECT jsonb_agg(p ORDER BY id) FROM v13_live_money_policy p),'lease',(SELECT to_jsonb(w) FROM private.kalshi_account_worker_lease w),'approvals',(SELECT jsonb_agg(a) FROM private.strata_owner_sha_approvals a),'generation',(SELECT generation::text FROM private.strata_owner_consent_heads),'audit',(SELECT coalesce(jsonb_agg(o ORDER BY id),'[]') FROM v13_production_observation o)) s`)).rows[0].s;}
async function failAudit(kind:string){await db.query(`CREATE FUNCTION private.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='${kind}' THEN RAISE EXCEPTION 'synthetic_atomicity_failure';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_audit BEFORE INSERT ON v13_production_observation FOR EACH ROW EXECUTE FUNCTION private.fail_audit();`);}
const runRepair=(row:any)=>repairOwnerV4CommissioningHold(owner,{confirmation:OWNER_V4_REPAIR_CONFIRM,provisionalRepairConfirmation:PROVISIONAL_REPAIR_CONFIRM,expectedPolicyId:row.id,expectedPolicyHash:row.policy_hash,expectedRevision:7,authorityId:authority,expectedDeployedSha:sha},{db:db as never,sha:()=>sha,material:async()=>({keyId:'synthetic',privateKey:'synthetic'}),read:async(_c:any,t:number)=>({ok:true,observedAtMs:t,historicalCoverageComplete:true,cashMicros:'25000000',orders:[],fills:[],positions:[],settlements:[]}),observe:async()=>({ok:true,model:{...model,observedAt:new Date().toISOString()},tradingAuthorized:false})} as never);
const selection={presetId:TEST_TWENTY_PERCENT_PRESET.id,presetRevision:TEST_TWENTY_PERCENT_PRESET.revision,capitalBudgetCents:2500};
const runStake=()=>amendOwnedStakePolicy(db as never,owner,'a',500,1,OWNER_STAKE_POLICY_CONFIRM,selection);
for(const kind of ['stake','repair']){
 test(kind+' full workflow advances generation, revokes approval, preserves kills atomically',async()=>{const row=await setup(kind==='repair');const before=await state();const r=kind==='repair'?await runRepair(row):await runStake();assert.equal(r.ok,true,JSON.stringify(r));const after=await state();assert.equal(after.generation,'2');assert.notEqual(after.approvals[0].revoked_at,null);assert.equal(after.account.kill_switch,true);assert.equal(after.account.execution_enabled,false);assert.deepEqual(after.lease,before.lease);if(kind==='stake'){assert.equal(after.policy.length,2);assert.equal(after.policy.filter((p:any)=>p.state==='REVOKED').length,1);assert.equal(after.stake.revision,2);}else{assert.equal(after.account.blocked_reason,null);assert.equal(after.account.revision,8);}
assert.equal(after.audit.filter((x:any)=>x.kind==='OWNER_CODE_CONSENT_REVOKED').length,1);});
 for(const audit of ['OWNER_CODE_CONSENT_REVOKED',kind==='repair'?'OWNER_V4_PROVISIONAL_HOLD_REPAIR':'OWNER_STAKE_RELEASE_INVALIDATED'])test(kind+' rolls back all effects on '+audit+' failure',async()=>{const row=await setup(kind==='repair');await failAudit(audit);const before=await state();const r=kind==='repair'?await runRepair(row):await runStake();assert.equal(r.ok,false);assert.equal('reason'in r?r.reason:'',kind==='repair'?'v4_repair_transaction_failed':'stake_policy_transaction_failed');assert.deepEqual(await state(),before);});
}
test('stake exact saved preset replay is no-op including consent generation',async()=>{await setup();assert.equal((await runStake()).ok,true);const before=await state();const r=await amendOwnedStakePolicy(db as never,owner,'a',500,2,OWNER_STAKE_POLICY_CONFIRM,selection);assert.equal(r.ok,true);assert.equal('unchanged'in r&&r.unchanged,true);assert.deepEqual(await state(),before);});
test('stake owned worker refusal leaves generation and financial state untouched',async()=>{await setup();await db.query("UPDATE private.kalshi_account_worker_lease SET state='owned'");const before=await state();const r=await runStake();assert.deepEqual(r,{ok:false,reason:'worker_lease_recovery_required'});assert.deepEqual(await state(),before);});
test('repair unrelated risk freeze is not erased or generation advanced',async()=>{const row=await setup(true);await db.query("UPDATE v13_production_account SET blocked_reason='unresolved_exchange_order'");const before=await state();const r=await runRepair(row);assert.equal(r.ok,false);assert.equal(r.reason,'unrelated_risk_freeze');assert.deepEqual(await state(),before);});
test('stake foreign owner cannot revoke this owner receipt',async()=>{await setup();const before=await state();const r=await amendOwnedStakePolicy(db as never,'33333333-3333-4333-8333-333333333333','a',500,1,OWNER_STAKE_POLICY_CONFIRM,selection);assert.deepEqual(r,{ok:false,reason:'execution_account_missing'});assert.deepEqual(await state(),before);});
test.after(async()=>{await db.end()});
