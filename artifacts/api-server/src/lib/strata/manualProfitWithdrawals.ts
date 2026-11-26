import {transactionConnectionFence} from '../v13-production/transactionConnectionFence';
import {randomUUID} from 'node:crypto';
import {pool,type PoolClient} from '@workspace/db';
import {dedicatedSignerFingerprint} from './commissioning';
import {getScopedKalshiJson,postScopedKalshiCashierSweep} from '../kalshiAccountClient';
import {readOwnedKalshiFeeds} from './personalExchangeRead';
import {economicExitNotDischarged} from './economicExitDischargeScope';
import {exactCashMicros,protectedTransferCash,requiredTradingCapitalCents} from './cashTransferPolicy';
import {assertCashTransferSchema,ownerCashTransfersEnabled,recordOwnerCashFlow} from './ownerCashFlowAccounting';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import {requireProof} from '../v13-production/types';

const TABLE='private.strata_manual_profit_withdrawals';
const TRANSFER_PATH='/trade-api/v2/portfolio/intra_exchange_instance_transfers';
const BALANCE_PATH='/trade-api/v2/portfolio/balance';
export const CASHIER_SWEEP_CONFIRMATION='WITHDRAW_VERIFIED_CASH_TO_PRIMARY_CASHIER';
type Row=Record<string,unknown>;type Credential={keyId:string;privateKey:string};
type Get=typeof getScopedKalshiJson;type Post=typeof postScopedKalshiCashierSweep;
export type ManualSweepState='prepared'|'attempted'|'pending'|'uncertain'|'completed'|'expired';
export type SweepResult={ok:boolean;reason:string;enabled:boolean;id:string|null;state:ManualSweepState|null;
 amountCents:number|null;minimumRetainedCents:number|null;botCashCents:number|null;cashierCashCents:number|null;
 maximumCents:number|null;expiresAt:string|null;transferId:string|null;origin?:'manual'|'automatic'|null;
 requiredCapitalCents?:number|null;savedStakeCents?:number|null;transferEligible?:boolean;observedAt?:string|null;
 botCashMicros?:string|null;realizedPnlMicros?:string|null};
const UUID=/^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const exact=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
const amountValue=(r:Row,k:string):number|null=>r[k]!==null&&r[k]!==undefined&&Number.isSafeInteger(Number(r[k]))&&Number(r[k])>=0?Number(r[k]):null;
export const withdrawalTransfersEnabled=()=>ownerCashTransfersEnabled()&&process.env.STRATA_MANUAL_WITHDRAWALS_ENABLED==='true'&&process.env.STRATA_WITHDRAWAL_ROUTING_VERIFIED==='true'&&process.env.KALSHI_API_ENVIRONMENT==='production';
const fail=(reason:string):SweepResult=>({ok:false,reason,enabled:withdrawalTransfersEnabled(),id:null,state:null,amountCents:null,minimumRetainedCents:null,botCashCents:null,cashierCashCents:null,maximumCents:null,expiresAt:null,transferId:null,transferEligible:false,observedAt:null});
function exposed(r:Row,reason:string,ok=true):SweepResult{return {...fail(reason),ok,id:typeof r.id==='string'?r.id:null,state:r.state as ManualSweepState,
 amountCents:amountValue(r,'amount_cents'),minimumRetainedCents:amountValue(r,'retain_cents'),botCashCents:amountValue(r,'bot_before_cents'),cashierCashCents:amountValue(r,'cashier_before_cents'),
 expiresAt:r.expires_at instanceof Date?r.expires_at.toISOString():typeof r.expires_at==='string'?r.expires_at:null,transferId:typeof r.exchange_transfer_id==='string'?r.exchange_transfer_id:null,origin:r.origin==='automatic'?'automatic':'manual'};}
function credential(r:Row):Credential|null{try{if(typeof r.decrypted_secret!=='string')return null;const s=JSON.parse(r.decrypted_secret);return typeof s.api_key_id==='string'&&typeof s.private_key==='string'&&dedicatedSignerFingerprint(s.api_key_id,s.private_key)===r.key_fingerprint?{keyId:s.api_key_id,privateKey:s.private_key}:null;}catch{return null;}}
// Read access is independent from transfer authorization. Signed cash may be
// displayed while trading; a positive display is NEVER a safe-to-transfer flag.
const OWNER_SQL=`SELECT a.*,a.cash_micros::text AS cash_micros,a.reserved_micros::text AS reserved_micros,
 a.initial_cash_micros::text AS initial_cash_micros,c.id AS credential_id,c.key_fingerprint AS authority_fingerprint,s.decrypted_secret,
 st.configured_stake_cents,st.revision AS stake_revision,p.policy_hash,p.state AS policy_state,p.max_entry_stake_cents,
 m.state AS maintenance_state,m.owner_user_id AS maintenance_owner,m.operator_interrupted,
 (SELECT coalesce(sum(e.pnl_micros),0)::text FROM public.v13_production_event e WHERE e.account_id=a.id) AS realized_pnl_micros,
 (SELECT count(*)::int FROM public.v13_production_position pos WHERE pos.account_id=a.id AND pos.quantity_hundredths<>0) AS open_positions,
 (SELECT count(*)::int FROM public.v13_production_intent i WHERE i.account_id=a.id AND (NOT i.terminal OR i.state NOT IN ('TERMINAL','BLOCKED'))${economicExitNotDischarged('i.account_id','i.client_order_id')}) AS unresolved_intents,
 (SELECT count(*)::int FROM private.kalshi_account_worker_lease w WHERE w.execution_account_id=a.id AND (w.state='owned' OR w.arm_requested)) AS active_workers,
 (SELECT count(*)::int FROM private.kalshi_owner_topups t WHERE t.execution_account_id=a.id AND t.state='active') AS pending_topups
 FROM public.v13_production_account a
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id AND c.financial_account_id=fa.id AND c.provider_connection_id=pc.id
 AND c.role='account_setup_execution' AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
 JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
 JOIN public.strata_configured_stake st ON st.execution_account_id=a.id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 LEFT JOIN private.strata_auto_withdrawal_maintenance m ON m.execution_account_id=a.id AND m.owner_user_id=a.owner_user_id
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2`;
async function owned(owner:string,db:Pick<PoolClient,'query'>=pool,lock=false){
 if(!UUID.test(owner))return null;
 const r=await db.query(OWNER_SQL+(lock?' FOR UPDATE OF a FOR SHARE OF c,st,p':''),[owner]);if(r.rows.length!==1)return null;
 const row=r.rows[0] as Row,creds=credential({...row,key_fingerprint:row.authority_fingerprint});
 return creds?{row,creds}:null;
}
function safe(a:Row,origin:'manual'|'automatic',allowPendingHold=false,recoveryOnly=false){
 const mode=origin==='manual'?a.kill_switch===true&&a.execution_enabled===false:
 (recoveryOnly?['reconciling','blocked','resume_requested']:['ready_to_transfer','reconciling']).includes(String(a.maintenance_state))&&a.maintenance_owner===a.owner_user_id&&(recoveryOnly||a.operator_interrupted===false);
 return mode&&a.commissioned===true&&a.policy_state==='APPROVED'&&Number(a.configured_stake_cents)<=Number(a.max_entry_stake_cents)&&
 (a.blocked_reason===null||allowPendingHold&&a.blocked_reason==='owner_cash_withdrawal_pending')&&a.cash_precision_verified===true&&String(a.reserved_micros)==='0'&&
 ['open_positions','unresolved_intents','active_workers','pending_topups'].every(k=>a[k]===0);
}
type Cash={bot:bigint;cashier:bigint;intermediate:bigint;observedAtMs:number};
async function signedBalances(c:Credential,get:Get):Promise<Cash|null>{
 const observedAtMs=Date.now();try{const values=await Promise.all([
 get(c,BALANCE_PATH,'?subaccount=1&exchange_index=2'),get(c,BALANCE_PATH,'?subaccount=0&exchange_index=0'),get(c,BALANCE_PATH,'?subaccount=0&exchange_index=2')]);
 const bot=exactCashMicros(values[0],1,2),cashier=exactCashMicros(values[1],0,0),intermediate=exactCashMicros(values[2],0,2);
 return bot!==null&&cashier!==null&&intermediate!==null&&Date.now()-observedAtMs<=15000?{bot,cashier,intermediate,observedAtMs}:null;
 }catch{return null;}}
const cents=(v:bigint)=>{requireProof(v>=0n&&v/10000n<=BigInt(Number.MAX_SAFE_INTEGER),'transfer_cash_range');return Number(v/10000n);};
const floor=(row:Row,cash:Cash,retain:number)=>protectedTransferCash({stakeCents:row.configured_stake_cents,ownerRetainCents:retain,cashMicros:String(cash.bot),reservedMicros:String(row.reserved_micros)});
async function exposureClear(c:Credential,get:Get,expected:bigint){
 const f=await readOwnedKalshiFeeds(c,Date.now(),get,{mode:'bounded_history_reads_v1'});
 return f.ok&&f.historicalCoverageComplete===true&&BigInt(f.cashMicros)===expected&&
 f.positions.every(v=>{const r=v as Row,n=r.position_fp??r.position??r.net_position_fp;return n!==null&&n!==undefined&&Number.isFinite(Number(n))&&Number(n)===0;})&&
 f.orders.every(v=>['executed','filled','canceled','cancelled','expired'].includes(String((v as Row).status).toLowerCase()));
}
export async function observeAutomaticSweepCash(owner:string){try{const a=await owned(owner);if(!a)return null;const b=await signedBalances(a.creds,getScopedKalshiJson);if(!b)return null;
 const required=requiredTradingCapitalCents(a.row.configured_stake_cents);return {accountId:String(a.row.id),botCashCents:cents(b.bot),cashierCashCents:cents(b.cashier),
 initialCapitalCents:required,requiredCapitalCents:required,killSwitch:a.row.kill_switch===true,executionEnabled:a.row.execution_enabled===true,cashPrecisionVerified:a.row.cash_precision_verified===true};
 }catch{return null;}}
export async function sweepAvailability(owner:string,minimumRetainedCents=0,get:Get=getScopedKalshiJson,origin:'manual'|'automatic'='manual'):Promise<SweepResult>{
 if(exact(minimumRetainedCents)===null)return fail('invalid_minimum_retained_cash');
 try{const a=await owned(owner);if(!a)return fail('withdrawal_account_or_signer_unverified');const b=await signedBalances(a.creds,get);if(!b)return fail('kalshi_scoped_cash_unverified');
 const f=floor(a.row,b,minimumRetainedCents);
 const pending=await pool.query(`SELECT id FROM ${TABLE} WHERE execution_account_id=$1 AND (state IN ('attempted','pending','uncertain') OR state='prepared' AND expires_at>now()) LIMIT 1`,[a.row.id]);
 const transferEligible=safe(a.row,origin)&&String(a.row.cash_micros)===String(b.bot)&&pending.rows.length===0;
 return {...fail(''),ok:true,reason:!withdrawalTransfersEnabled()?'withdrawal_feature_disabled':transferEligible?'withdrawal_available':'withdrawal_requires_stopped_flat_reconciled_account',
 botCashCents:cents(b.bot),botCashMicros:String(b.bot),cashierCashCents:cents(b.cashier),...f,savedStakeCents:Number(a.row.configured_stake_cents),
 transferEligible,observedAt:new Date(b.observedAtMs).toISOString(),realizedPnlMicros:String(a.row.realized_pnl_micros)};
 }catch{return fail('withdrawal_read_unavailable');}}
export async function quoteManualSweep(owner:string,input:unknown,get:Get=getScopedKalshiJson,origin:'manual'|'automatic'='manual'):Promise<SweepResult>{
 if(!withdrawalTransfersEnabled())return fail('withdrawal_feature_disabled');
 if(!input||typeof input!=='object'||Array.isArray(input))return fail('invalid_request');const v=input as Row;
 const amount=exact(v.amountCents),retain=exact(v.minimumRetainedCents);if(amount===null||amount<1||amount>1e11||retain===null)return fail('invalid_amount');
 let tx:PoolClient|undefined,committed=false,commitSent=false;
 try{await assertCashTransferSchema(pool);const a=await owned(owner);if(!a||!safe(a.row,origin))return fail('withdrawal_account_not_safely_stopped_or_authorized');
 const b=await signedBalances(a.creds,get);if(!b||String(b.bot)!==String(a.row.cash_micros))return fail('kalshi_scoped_cash_unverified');
 tx=await pool.connect();await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms';SET LOCAL statement_timeout='5000ms'");
 const current=await owned(owner,tx,true);if(!current||!safe(current.row,origin)||current.row.id!==a.row.id||current.row.authority_fingerprint!==a.row.authority_fingerprint||String(current.row.cash_micros)!==String(b.bot))throw Error('withdrawal_account_changed');
 const f=floor(current.row,b,retain);if(amount>f.maximumCents)throw Error('withdrawal_exceeds_verified_unreserved_cash');
 await new ProductionLedger(pool,String(a.row.id)).assertConservation(tx,current.row as unknown as Account);
 await tx.query(`UPDATE ${TABLE} SET state='expired',updated_at=now() WHERE execution_account_id=$1 AND state='prepared' AND expires_at<now()`,[a.row.id]);
 const r=await tx.query(`INSERT INTO ${TABLE}(id,owner_user_id,execution_account_id,state,amount_cents,retain_cents,bot_before_cents,cashier_before_cents,
 authority_fingerprint,bot_before_micros,cashier_before_micros,intermediate_before_micros,stake_revision,policy_hash)
 VALUES($1,$2,$3,'prepared',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[randomUUID(),owner,a.row.id,amount,f.minimumRetainedCents,cents(b.bot),cents(b.cashier),a.row.authority_fingerprint,String(b.bot),String(b.cashier),String(b.intermediate),current.row.stake_revision,current.row.policy_hash]);
 commitSent=true;await tx.query('COMMIT');committed=true;return exposed(r.rows[0],'withdrawal_quote_prepared');
 }catch(e){return fail(e instanceof Error&&/^withdrawal_[a-z_]+$/.test(e.message)?e.message:'withdrawal_quote_unverified');}
 finally{if(tx){if(!committed&&!commitSent)await tx.query('ROLLBACK').catch(()=>undefined);tx.release(commitSent&&!committed?Error('withdrawal_quote_commit_unknown'):undefined);}}}
export async function confirmManualSweep(owner:string,input:unknown,get:Get=getScopedKalshiJson,post:Post=postScopedKalshiCashierSweep,automaticAuthorization=false):Promise<SweepResult>{
 if(!withdrawalTransfersEnabled())return fail('withdrawal_feature_disabled');const v=input&&typeof input==='object'?input as Row:{};
 if(v.confirmation!==CASHIER_SWEEP_CONFIRMATION||typeof v.quoteId!=='string'||!UUID.test(v.quoteId))return fail('explicit_confirmation_required');
 const origin=automaticAuthorization?'automatic':'manual';let claimed=false,row:Row|undefined;
 try{await assertCashTransferSchema(pool);const a=await owned(owner);if(!a||!safe(a.row,origin))return fail('withdrawal_account_not_safely_stopped_or_authorized');
 const plan=await pool.query(`SELECT * FROM ${TABLE} WHERE id=$1 AND owner_user_id=$2::uuid AND execution_account_id=$3`,[v.quoteId,owner,a.row.id]);
 row=plan.rows[0];if(plan.rows.length!==1||row?.state!=='prepared')return fail('quote_missing_or_already_used');
 if((row.origin==='automatic')!==automaticAuthorization)return fail('withdrawal_origin_mismatch');
 const amount=amountValue(row,'amount_cents'),retain=amountValue(row,'retain_cents');
 if(!amount||retain===null||row.bot_before_micros===null||!(row.expires_at instanceof Date)||row.expires_at.getTime()<=Date.now())return fail('quote_expired_or_unverified');
 if(!await exposureClear(a.creds,get,BigInt(String(row.bot_before_micros))))return fail('withdrawal_signed_exposure_unverified');
 const b=await signedBalances(a.creds,get);if(!b||String(b.bot)!==String(row.bot_before_micros)||String(b.cashier)!==String(row.cashier_before_micros)||String(b.intermediate)!==String(row.intermediate_before_micros))return fail('cash_changed_requote_required');
 const tx=await pool.connect();let commitSent=false;try{
 await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms';SET LOCAL statement_timeout='5000ms'");
 const current=await owned(owner,tx,true);
 requireProof(current&&safe(current.row,origin)&&current.row.id===a.row.id&&current.row.authority_fingerprint===row.authority_fingerprint&&String(current.row.stake_revision)===String(row.stake_revision)&&current.row.policy_hash===row.policy_hash&&String(current.row.cash_micros)===String(b.bot)&&floor(current.row,b,retain).maximumCents>=amount,'withdrawal_scope_or_capital_changed');
 if(automaticAuthorization){const rule=await tx.query(`SELECT r.id FROM private.strata_auto_profit_withdrawal_rules r JOIN private.strata_auto_withdrawal_maintenance m ON m.rule_id=r.id
 WHERE r.id=$1 AND r.owner_user_id=$2::uuid AND r.execution_account_id=$3 AND r.enabled AND r.revision=$4 AND r.latched AND r.last_attempt_id=$5
 AND m.state='reconciling' AND m.transfer_id=$5 AND NOT m.operator_interrupted AND m.rule_revision=r.revision FOR SHARE OF r,m`,[row.auto_rule_id,owner,a.row.id,row.auto_rule_revision,row.id]);requireProof(rule.rows.length===1,'withdrawal_automatic_consent_changed');}
 const claim=await tx.query(`UPDATE ${TABLE} SET state='attempted',attempted_at=now(),updated_at=now() WHERE id=$1 AND owner_user_id=$2::uuid AND state='prepared' AND expires_at>now() RETURNING id`,[row.id,owner]);
 requireProof(claim.rows.length===1,'withdrawal_quote_already_claimed');
 const hold=await tx.query("UPDATE public.v13_production_account SET blocked_reason='owner_cash_withdrawal_pending',revision=revision+1 WHERE id=$1 AND owner_user_id=$2::uuid AND blocked_reason IS NULL RETURNING id",[a.row.id,owner]);
 requireProof(hold.rows.length===1,'withdrawal_hold_not_recorded');commitSent=true;await tx.query('COMMIT');claimed=true;
 }finally{if(!claimed&&!commitSent)await tx.query('ROLLBACK').catch(()=>undefined);tx.release(commitSent&&!claimed?Error('withdrawal_claim_unknown'):undefined);}
 // Claim is durable BEFORE one provider POST. Hold account/policy/credential
 // locks at the send boundary; START cannot race the unresolved journal.
 const wire=await pool.connect(),connection=transactionConnectionFence(wire);let transferId:string|null=null;
 try{await wire.query('BEGIN');await wire.query("SET LOCAL lock_timeout='1500ms';SET LOCAL statement_timeout='5000ms'");const last=await owned(owner,wire,true);
 requireProof(last&&safe(last.row,origin,true)&&last.row.id===a.row.id&&last.row.authority_fingerprint===row.authority_fingerprint&&String(last.row.stake_revision)===String(row.stake_revision)&&last.row.policy_hash===row.policy_hash&&String(last.row.cash_micros)===String(b.bot)&&floor(last.row,b,retain).maximumCents>=amount&&withdrawalTransfersEnabled()&&Date.now()-b.observedAtMs<=15000,'withdrawal_final_fence_closed');
 if(automaticAuthorization){const consent=await wire.query(`SELECT r.id FROM private.strata_auto_profit_withdrawal_rules r JOIN private.strata_auto_withdrawal_maintenance m ON m.rule_id=r.id WHERE r.id=$1 AND r.owner_user_id=$2::uuid AND r.enabled AND r.revision=$3 AND m.transfer_id=$4 AND NOT m.operator_interrupted AND m.state='reconciling' FOR SHARE OF r,m`,[row.auto_rule_id,owner,row.auto_rule_revision,row.id]);requireProof(consent.rows.length===1,'withdrawal_automatic_consent_changed');}
 connection.assertLive();const response=await post(last.creds,amount);if(response.status===200&&!response.unreadable)transferId=response.transferId;
 }catch{/* An ambiguous financial request is NEVER retried. */}finally{let discard=connection.broken();try{await wire.query('ROLLBACK');}catch{discard=true;}connection.close();wire.release(discard?Error('withdrawal_wire_connection_discarded'):undefined);connection.cleanup(discard);}
 const state=transferId?'pending':'uncertain';await pool.query(`UPDATE ${TABLE} SET state=$3,exchange_transfer_id=$4,failure_reason=$5,updated_at=now() WHERE id=$1 AND owner_user_id=$2::uuid AND state='attempted'`,[row.id,owner,state,transferId,transferId?null:'kalshi_transfer_response_unconfirmed']).catch(()=>undefined);
 return exposed({...row,state,exchange_transfer_id:transferId},transferId?'transfer_submitted_reconcile_before_cashier_claim':'transfer_outcome_uncertain',!!transferId);
 }catch{return row&&claimed?exposed({...row,state:'uncertain'},'transfer_outcome_uncertain',false):fail('withdrawal_claim_or_scope_unverified');}}
/** Receipt and signed cash reads only at the exchange; local accounting commits
 * atomically once. No repeat POST and no assumption that a cash delta is a receipt. */
export async function reconcileManualSweep(owner:string,id:unknown,get:Get=getScopedKalshiJson):Promise<SweepResult>{
 if(typeof id!=='string'||!UUID.test(id))return fail('invalid_withdrawal_id');
 let row:Row|undefined;try{const r=await pool.query(`SELECT * FROM ${TABLE} WHERE id=$1 AND owner_user_id=$2::uuid`,[id,owner]);row=r.rows[0];if(r.rows.length!==1||!row)return fail('withdrawal_not_found');
 if(row.state==='completed'){const proof=await pool.query('SELECT id FROM private.strata_owner_cash_flow_receipt WHERE id=$1 AND owner_user_id=$2::uuid AND direction=\'WITHDRAWAL\'',[id,owner]);return exposed(row,proof.rows.length===1?'withdrawal_completed':'withdrawal_accounting_receipt_unverified',proof.rows.length===1);}
 if(row.state==='prepared'||row.state==='expired')return exposed(row,'withdrawal_not_submitted');
 if(typeof row.exchange_transfer_id!=='string')return exposed(row,'transfer_unconfirmed_manual_review_required',false);
 const a=await owned(owner),origin=row.origin==='automatic'?'automatic':'manual';if(!a||a.row.id!==row.execution_account_id||!safe(a.row,origin,true,true))return exposed(row,'reconciliation_owner_or_safety_unproven',false);
 const raw=await get(a.creds,TRANSFER_PATH+'/'+encodeURIComponent(row.exchange_transfer_id),'');
 const t=raw&&typeof raw==='object'?(raw as Row).transfer:null;if(!t||typeof t!=='object'||Array.isArray(t))return exposed(row,'exchange_receipt_invalid',false);const receipt=t as Row;
 const amount=amountValue(row,'amount_cents');if(!amount||receipt.transfer_id!==row.exchange_transfer_id||receipt.source!=='event_contract'||receipt.destination!=='event_contract'||receipt.source_exchange_shard!==2||receipt.destination_exchange_shard!==0||receipt.source_subaccount!==undefined&&receipt.source_subaccount!==1||receipt.destination_subaccount!==undefined&&receipt.destination_subaccount!==0)return exposed(row,'exchange_receipt_identity_mismatch',false);
 if(!['complete','completed'].includes(String(receipt.status)))return exposed(row,'exchange_transfer_still_pending_or_incomplete',false);
 const receiptAmount=exactCashMicros({balance_dollars:receipt.amount},0,0);if(receiptAmount!==BigInt(amount)*10000n)return exposed(row,'exchange_receipt_amount_mismatch',false);
 const before=BigInt(String(row.bot_before_micros));if(!await exposureClear(a.creds,get,before-BigInt(amount)*10000n))return exposed(row,'withdrawal_signed_exposure_unverified',false);
 const b=await signedBalances(a.creds,get);if(!b||b.bot!==before-BigInt(amount)*10000n||b.cashier!==BigInt(String(row.cashier_before_micros))+BigInt(amount)*10000n||b.intermediate!==BigInt(String(row.intermediate_before_micros)))return exposed(row,'cashier_and_bot_balance_reconciliation_pending',false);
 const tx=await pool.connect();let done=false,commitSent=false;
 try{await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='1500ms';SET LOCAL statement_timeout='5000ms'");const current=await owned(owner,tx,true);
 requireProof(current&&safe(current.row,origin,true,true)&&current.row.id===a.row.id&&String(current.row.cash_micros)===String(before),'withdrawal_reconciliation_scope_changed');
 const changed=await tx.query(`UPDATE ${TABLE} SET state='completed',completed_at=now(),updated_at=now(),failure_reason=NULL WHERE id=$1 AND owner_user_id=$2::uuid AND state IN ('attempted','pending','uncertain') AND exchange_transfer_id=$3 RETURNING *`,[id,owner,row.exchange_transfer_id]);
 requireProof(changed.rows.length===1,'withdrawal_already_reconciled');
 await recordOwnerCashFlow(tx,current.row as unknown as Account,{id,owner,direction:'WITHDRAWAL',providerId:row.exchange_transfer_id,beforeMicros:String(before),afterMicros:String(b.bot),observedAtMs:b.observedAtMs,evidence:{receipt,bot:String(b.bot),cashier:String(b.cashier),intermediate:String(b.intermediate)}});
 const released=await tx.query("UPDATE public.v13_production_account SET blocked_reason=NULL,revision=revision+1 WHERE id=$1 AND owner_user_id=$2::uuid AND blocked_reason='owner_cash_withdrawal_pending' RETURNING id",[a.row.id,owner]);
 requireProof(released.rows.length===1,'withdrawal_pending_hold_changed');
 if(origin==='automatic')await tx.query(`UPDATE private.strata_auto_withdrawal_maintenance m SET state='completed',operator_interrupted=true,completed_at=now(),changed_at=now(),last_reason='transfer_reconciled_restart_not_authorized'
 WHERE m.owner_user_id=$1::uuid AND m.execution_account_id=$2 AND m.transfer_id=$3 AND
 (m.operator_interrupted OR $4::boolean OR NOT EXISTS(SELECT 1 FROM private.strata_auto_profit_withdrawal_rules r WHERE r.id=m.rule_id AND r.enabled AND r.revision=m.rule_revision))`,[owner,a.row.id,id,process.env.STRATA_AUTOMATIC_WITHDRAWALS_ENABLED!=='true']);
 commitSent=true;await tx.query('COMMIT');done=true;return exposed(changed.rows[0],'withdrawal_completed');
 }finally{if(!done&&!commitSent)await tx.query('ROLLBACK').catch(()=>undefined);tx.release(commitSent&&!done?Error('withdrawal_accounting_commit_unknown'):undefined);}
 }catch{return row?exposed(row,'withdrawal_reconciliation_unavailable',false):fail('withdrawal_reconciliation_unavailable');}}
export interface CashierRouteDiagnostic{ok:boolean;reason:string;documentedRoute:boolean;signedBalancesVerified:boolean;transferHistoryReadVerified:boolean;liveTransfersEnabled:boolean;source:string;destination:string;cashierCashCents:number|null;botCashCents:number|null;}
export async function inspectCashierRouteReadOnly(owner:string):Promise<CashierRouteDiagnostic>{
 const result:CashierRouteDiagnostic={ok:false,reason:'signed_route_not_verified',documentedRoute:true,signedBalancesVerified:false,transferHistoryReadVerified:false,liveTransfersEnabled:withdrawalTransfersEnabled(),source:'subaccount_1_index_2',destination:'primary_subaccount_0_index_0',cashierCashCents:null,botCashCents:null};
 try{const a=await owned(owner);if(!a)return result;const b=await signedBalances(a.creds,getScopedKalshiJson);if(!b)return result;
 const h=await getScopedKalshiJson(a.creds,TRANSFER_PATH,'?limit=1');const valid=!!h&&typeof h==='object'&&Array.isArray((h as Row).transfers);
 return {...result,ok:valid,reason:valid?'read_only_routing_verified_live_destination_receipt_unproven':'authenticated_transfer_history_invalid',signedBalancesVerified:true,transferHistoryReadVerified:valid,botCashCents:cents(b.bot),cashierCashCents:cents(b.cashier)};
 }catch{return result;}}
export async function listManualSweeps(owner:string):Promise<SweepResult[]>{const r=await pool.query(`SELECT * FROM ${TABLE} WHERE owner_user_id=$1::uuid ORDER BY created_at DESC LIMIT 20`,[owner]);return r.rows.map(row=>exposed(row,row.state==='completed'?'withdrawal_completed':'withdrawal_not_yet_confirmed'));}
