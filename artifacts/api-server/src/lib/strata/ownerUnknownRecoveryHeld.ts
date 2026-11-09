import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from '@workspace/db';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import {transactionConnectionFence} from '../v13-production/transactionConnectionFence';
import {requireProof,type Snapshot,type Request} from '../v13-production/types';
import {personalAccountSnapshot,type OwnedKalshiRead} from './personalExchangeRead';
import {dedicatedSignerFingerprint} from './commissioning';
import {OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION,ownerUnknownEvidenceDigest as hash,
 planOwnerUnknownReconciliation} from './ownerUnknownRecoveryPlan';

/** Dependency-injected accounting collector. No default DB, signer loader, provider
 * transport or worker is constructed. Integrators must supply reviewed trusted
 * server dependencies, never request-body functions, credentials or evidence.
 * The only public operation consumes identity/intent/receipt/confirmation; it
 * never accepts a caller's snapshot, cash, order request or account selector.
 */
type Row=Record<string,unknown>;
type Query={query(sql:string,args?:unknown[]):Promise<{rows:Row[]}>};
type Material={keyId:string;privateKey:string};
type Input={ownerId:string;targetIntentId:string;fenceReceiptId:string;confirmation:unknown};
type Dependencies={
 db:Pool;now:()=>number;isScheduled:(owner:string,account:string)=>boolean;
 material:(db:Query,account:{owner_id:string;kalshi_connection_id:string;key_fingerprint:string})=>Promise<Material|null>;
 readFeeds:(material:Material,observedAtMs:number)=>Promise<OwnedKalshiRead|{ok:false;reason:string}>;
};
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const integer=(x:unknown):x is string=>typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x);
const millis=(x:unknown):number=>x instanceof Date?x.getTime():typeof x==='string'?Date.parse(x):NaN;
const validClock=(x:number)=>Number.isSafeInteger(x)&&x>0&&x<=8640000000000000-15000;
const identity=(x:Row)=>({subaccount:1,exchangeIndex:2,keyFingerprint:String(x.key_fingerprint)});
const no=(reason:string,extra:Record<string,unknown>={})=>({ok:false as const,reason,
 ordersSubmitted:false as const,workerStarted:false as const,tradingAuthorized:false as const,
 riskFreezeCleared:false as const,...extra});

const ACCOUNT_SQL=`SELECT a.id,a.owner_user_id::text,a.kalshi_connection_id::text,
 a.subaccount,a.exchange_index,a.key_fingerprint,a.revision::text,a.cash_micros::text,
 a.reserved_micros::text,a.blocked_reason,a.kill_switch,a.execution_enabled,a.commissioned,
 a.cash_precision_verified,w.state,w.arm_requested,w.account_kill,w.fencing_token::text,
 w.owner_user_id::text AS lease_owner,w.credential_fingerprint,
 jsonb_build_object('account',a.xmin::text,'lease',w.xmin::text,'credential',c.xmin::text,
  'policy',p.xmin::text,'financial',fa.xmin::text,'provider',pc.xmin::text) AS revisions
 FROM public.v13_production_account a
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
  AND p.created_by=a.owner_user_id::text AND p.state='APPROVED'
 JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id AND fa.provider='kalshi'
 JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
 JOIN private.kalshi_connection_credentials c ON c.owner_user_id=a.owner_user_id
  AND c.financial_account_id=fa.id AND c.provider_connection_id=pc.id
  AND c.role='restricted_execution' AND c.revoked_at IS NULL AND c.verified_at IS NOT NULL
  AND c.verification_reason='credential_verified' AND c.key_fingerprint=a.key_fingerprint
 WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2`;
const HISTORY_SQL=`SELECT id,account_id,kind,state,terminal,created_at,request,
 reserved_micros::text,filled_hundredths::text,exchange_order_id,client_order_id,
 decision,policy_hash,fee_fingerprint,capability_digest,xmin::text AS row_revision
 FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id`;
const COUNTS_SQL=`SELECT
 (SELECT count(*)::text FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1
  AND state IN ('PREPARED','DISPATCHED','UNKNOWN')) AS exits,
 ((SELECT count(*) FROM private.strata_manual_profit_withdrawals WHERE execution_account_id=$1
   AND state IN ('prepared','attempted','pending','uncertain'))+
  (SELECT count(*) FROM private.strata_auto_withdrawal_maintenance WHERE execution_account_id=$1 AND state<>'completed')+
  (SELECT count(*) FROM private.kalshi_owner_topups WHERE execution_account_id=$1 AND state='active')+
  (SELECT count(*) FROM private.kalshi_owner_pilot_transfers WHERE execution_account_id=$1 AND state<>'completed')+
  (SELECT count(*) FROM private.kalshi_owner_shard_allocations WHERE execution_account_id=$1 AND state<>'completed'))::text AS transfers`;
const NORMAL_ACCOUNT_PERSISTENCE=`UPDATE v13_production_account SET cash_micros=$2,reserved_micros=$3,
 blocked_reason=$4,revision=revision+1,reconciled_at=$5,evidence_digest=$6 WHERE id=$1`.replace(/\s+/g,' ').trim();
const INDEPENDENT_TABLES=[
 'kalshi_owner_pilot_transfers','kalshi_owner_shard_allocations','kalshi_owner_topups',
 'strata_auto_withdrawal_maintenance','strata_emergency_exit_reservations','strata_manual_profit_withdrawals',
] as const;
async function lockIndependentActivity(tx:PoolClient,accountId:string){
 // Lock inactive rows too: completed maintenance can be reactivated without
 // changing its account FK, so counting only active rows misses that race.
 for(const table of INDEPENDENT_TABLES)await tx.query(
  `SELECT execution_account_id FROM private.${table} WHERE execution_account_id=$1 FOR SHARE`,[accountId]);
 // New rows must acquire a conflicting key-share lock on our already locked
 // parent account. Prove the deployed schema actually enforces that contract;
 // missing/disabled/deferred FK checks are a blocker, not an assumption.
 const constraints=await tx.query(`SELECT DISTINCT child.relname AS relation
  FROM pg_catalog.pg_constraint c
  JOIN pg_catalog.pg_class child ON child.oid=c.conrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid=child.relnamespace
  JOIN pg_catalog.pg_attribute ca ON ca.attrelid=child.oid AND ca.attname='execution_account_id'
  JOIN pg_catalog.pg_attribute pa ON pa.attrelid=c.confrelid AND pa.attname='id'
  WHERE c.contype='f' AND c.convalidated AND NOT c.condeferrable
   AND ns.nspname='private' AND child.relname=ANY($1::text[])
   AND c.confrelid='public.v13_production_account'::regclass
   AND c.conkey=ARRAY[ca.attnum] AND c.confkey=ARRAY[pa.attnum]
   AND current_setting('session_replication_role')='origin'
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=c.oid
    AND t.tgrelid=child.oid AND (t.tgtype::int & 4)=4 AND t.tgenabled IN ('O','A'))
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=c.oid
    AND t.tgrelid=child.oid AND (t.tgtype::int & 16)=16 AND t.tgenabled IN ('O','A'))`,[INDEPENDENT_TABLES]);
 requireProof(constraints.rows.length===INDEPENDENT_TABLES.length&&
  INDEPENDENT_TABLES.every(name=>constraints.rows.some(r=>r.relation===name)),
  'recovery_independent_activity_fencing_schema_unverified');
}
type Held={account:Row;hold:Row;intents:Row[];readCompletedAtMs:number};

async function captureHeld(db:Query,input:Input,deps:Dependencies,locked=false):Promise<Held>{
 const records=await db.query(ACCOUNT_SQL+(locked?' FOR SHARE OF p,c,fa,pc':''),[input.ownerId]);
 requireProof(records.rows.length===1,'recovery_owned_account_missing_or_ambiguous');
 const a=records.rows[0]!,id=String(a.id);
 requireProof(a.owner_user_id===input.ownerId&&a.lease_owner===input.ownerId&&a.credential_fingerprint===a.key_fingerprint&&
  a.commissioned===true&&a.cash_precision_verified===true,'recovery_account_or_credential_unverified');
 requireProof(a.kill_switch===true&&a.execution_enabled===false&&a.state==='killed'&&
  a.arm_requested===false&&a.account_kill===true&&deps.isScheduled(input.ownerId,id)===false,
  'recovery_durable_kill_required');
 requireProof(integer(a.revision)&&integer(a.fencing_token)&&integer(a.cash_micros)&&integer(a.reserved_micros)&&
  BigInt(a.reserved_micros)>0n,'recovery_unknown_reservation_required');
 const receipts=await db.query(`SELECT payload,digest,observed_at FROM public.v13_production_observation
  WHERE id=$1 AND account_id=$2 AND kind='OWNER_UNKNOWN_ACCOUNTING_KILL_FENCE'`,[input.fenceReceiptId,id]);
 requireProof(receipts.rows.length===1,'recovery_committed_kill_receipt_missing');
 const receipt=receipts.rows[0]!,p=receipt.payload as Row;
 requireProof(p&&typeof p==='object'&&hash(p)===receipt.digest&&p.ownerId===input.ownerId&&
  p.accountId===id&&p.targetIntentId===input.targetIntentId&&p.nextToken===a.fencing_token&&
  p.nextRevision===a.revision&&p.financialStateChanged===false&&p.tradingAuthorized===false&&
  integer(p.priorToken)&&BigInt(a.fencing_token as string)===BigInt(p.priorToken)+1n,
  'recovery_kill_receipt_binding_changed');
 const count=await db.query(COUNTS_SQL,[id]);
 requireProof(count.rows.length===1&&count.rows[0]!.exits==='0'&&count.rows[0]!.transfers==='0',
  'recovery_independent_exposure_or_transfer_pending');
 const history=await db.query(HISTORY_SQL+(locked?' FOR UPDATE':''),[id]);
 const intents=history.rows.map(i=>{
  const request=typeof i.request==='string'?JSON.parse(i.request):i.request;
  requireProof(request&&typeof request==='object'&&!Array.isArray(request),'recovery_history_unreadable');
  return {id:i.id,accountId:i.account_id,kind:i.kind,state:i.state,terminal:i.terminal,
   createdAtMs:millis(i.created_at),request,reservedMicros:i.reserved_micros,filledHundredths:i.filled_hundredths,
   exchangeOrderId:i.exchange_order_id,clientOrderId:i.client_order_id,decision:i.decision,
   policyHash:i.policy_hash,feeFingerprint:i.fee_fingerprint,capabilityDigest:i.capability_digest,rowRevision:i.row_revision};
 });
 const target=intents.find(i=>i.id===input.targetIntentId);
 requireProof(target&&target.kind==='ENTRY'&&target.state==='UNKNOWN'&&target.terminal===false&&
  integer(target.reservedMicros)&&BigInt(target.reservedMicros)>0n,'recovery_target_unknown_entry_required');
 // No prepared-exit recovery hook is silently skipped by the base ledger.
 requireProof(intents.every(i=>i.terminal===true||i.kind==='ENTRY'&&['UNKNOWN','DISPATCHED'].includes(String(i.state))),
  'recovery_prepared_or_protective_intent_requires_separate_workflow');
 const readCompletedAtMs=deps.now();requireProof(validClock(readCompletedAtMs),'recovery_clock_invalid');
 const recorded=millis(receipt.observed_at);
 requireProof(validClock(recorded)&&recorded<=readCompletedAtMs,'recovery_kill_receipt_time_unverified');
 return {account:a,intents,readCompletedAtMs,hold:{ownerId:input.ownerId,accountId:id,subaccount:1,exchangeIndex:2,
  keyFingerprint:a.key_fingerprint,executionEnabled:a.execution_enabled,killSwitch:a.kill_switch,
  leaseState:a.state,armRequested:a.arm_requested,accountKill:a.account_kill,localWorkerRunning:false,
  accountRevision:a.revision,fencingToken:a.fencing_token,preKillFencingToken:p.priorToken,
  // observed_at is a durable lower bound, not an exact COMMIT timestamp.
  // Collection additionally starts only AFTER this receipt is visible committed.
  killCommittedAtMs:recorded,revisions:a.revisions,activeProtectiveReservations:'0',pendingTransfers:'0',
  cashMicros:a.cash_micros,reservedMicros:a.reserved_micros,blockedReason:a.blocked_reason}};
}

class HeldAccountingLedger extends ProductionLedger{
 readonly receiptId=randomUUID();commitMayHaveBeenAttempted=false;
 constructor(db:Pool,readonly input:Input,readonly held:Held,readonly snapshot:Snapshot,readonly deps:Dependencies){
  super(db,String(held.account.id));
 }
 // This narrow killed-account operation does not replace any pre-existing
 // freeze on failed evidence. The ordinary production ledger is unchanged.
 override async freeze(_reason:string):Promise<void>{}
 override async transaction<T>(body:(tx:PoolClient,account:Account)=>Promise<T>):Promise<T>{
  return super.transaction(async(tx,a)=>{
   const connection=transactionConnectionFence(tx);
   try{
    connection.assertLive();
    await tx.query("SET LOCAL statement_timeout='8000ms'");
    const leases=await tx.query(`SELECT fencing_token::text FROM private.kalshi_account_worker_lease
     WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE`,[this.accountId,this.input.ownerId]);
    requireProof(leases.rows.length===1,'recovery_locked_lease_missing');
    await lockIndependentActivity(tx,this.accountId);
    const current=await captureHeld(tx,this.input,this.deps,true);
    requireProof(hash(current.hold)===hash(this.held.hold)&&hash(current.intents)===hash(this.held.intents),
     'recovery_locked_context_changed');
    const at=this.deps.now();
    requireProof(validClock(at)&&at>=this.snapshot.observedAtMs&&at-this.snapshot.observedAtMs<=15000,
     'recovery_locked_evidence_expired');
    const priorReason=a.blocked_reason,accountId=this.accountId;let persisted=0;
    // The ordinary ledger uses ??= for some newly discovered risks. A prior
    // hold must not mask them. Neutralize ONLY this local object, never the DB.
    // Intercept its exact single persistence statement, reject new risk, and
    // bind the original hold before any account UPDATE reaches PostgreSQL.
    const accountingTx=new Proxy(tx,{get(target,key){
     if(key==='query')return (...args:unknown[])=>{
      requireProof(typeof args[0]==='string','recovery_accounting_query_shape_changed');
      const sql=args[0] as string,normalized=sql.replace(/\s+/g,' ').trim();
      if(/\b(?:UPDATE|INTO|FROM)\s+(?:public\.)?v13_production_account\b/i.test(sql)&&
        /\b(?:UPDATE|INSERT|DELETE)\b/i.test(sql)){
       const values=args[1];
       requireProof(normalized===NORMAL_ACCOUNT_PERSISTENCE&&args.length===2&&Array.isArray(values)&&
        values.length===6&&values[0]===accountId&&persisted===0,'recovery_accounting_persistence_shape_changed');
       requireProof(values[3]===null&&a.blocked_reason===null,'recovery_new_risk_hold_requires_review');
       const preserved=[...values];preserved[3]=priorReason;persisted++;
       return Reflect.apply(target.query,target,[sql,preserved]);
      }
      return Reflect.apply(target.query,target,args);
     };
     const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    let out:T;
    a.blocked_reason=null;
    try{
     out=await body(accountingTx,a);
     requireProof(a.blocked_reason===null&&persisted===1,'recovery_new_risk_hold_requires_review');
    }finally{a.blocked_reason=priorReason;}
    // Existing ledger reconciles all events and independently checks exact
    // financial invariants. Require the narrow terminal/flat endpoint as well.
    const final=await tx.query(`SELECT
     (SELECT count(*)::text FROM public.v13_production_intent WHERE account_id=$1
      AND (NOT terminal OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros<>0)) AS unresolved,
     (SELECT count(*)::text FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0) AS positions`,[this.accountId]);
    requireProof(final.rows.length===1&&final.rows[0]!.unresolved==='0'&&final.rows[0]!.positions==='0'&&a.reserved_micros==='0',
     'recovery_final_account_not_terminal_and_flat');
    const independent=await tx.query(COUNTS_SQL,[this.accountId]);
    requireProof(independent.rows.length===1&&independent.rows[0]!.exits==='0'&&independent.rows[0]!.transfers==='0',
     'recovery_independent_activity_changed');
    // Re-read final protection after all financial/audit writes, using the DB
    // clock. This forbids stale evidence after pool/lock/query delays.
    const event={ownerId:this.input.ownerId,accountId:this.accountId,targetIntentId:this.input.targetIntentId,
     killReceiptId:this.input.fenceReceiptId,priorRevision:this.held.hold.accountRevision,
     fencingToken:this.held.hold.fencingToken,holdDigest:hash(this.held.hold),historyDigest:hash(this.held.intents),
     snapshotDigest:hash(this.snapshot),observedAtMs:this.snapshot.observedAtMs,
     tradingAuthorized:false,riskFreezeCleared:false};
    await tx.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
     VALUES($1,$2,'OWNER_UNKNOWN_ACCOUNTING_RECONCILIATION',$3::jsonb,$4)`,
     [this.receiptId,this.accountId,JSON.stringify(event),hash(event)]);
    const guards=await tx.query(`SELECT 1 AS valid FROM public.v13_production_account a
     JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
     WHERE a.id=$1 AND a.owner_user_id=$2::uuid AND a.kill_switch=true AND a.execution_enabled=false
      AND w.state='killed' AND w.account_kill=true AND w.arm_requested=false AND w.fencing_token=$3::bigint
      AND a.blocked_reason IS NOT DISTINCT FROM $4::text AND a.revision=$5::bigint+1
      AND a.reserved_micros=0 AND clock_timestamp() BETWEEN $6::timestamptz AND $6::timestamptz+interval '15 seconds'`,
     [this.accountId,this.input.ownerId,this.held.hold.fencingToken,priorReason,
      this.held.hold.accountRevision,new Date(this.snapshot.observedAtMs)]);
    requireProof(guards.rows.length===1&&this.deps.isScheduled(this.input.ownerId,this.accountId)===false,
     'recovery_final_freshness_or_hold_changed');
    connection.assertLive();
    const completed=this.deps.now();requireProof(validClock(completed)&&completed>=this.snapshot.observedAtMs&&
     completed-this.snapshot.observedAtMs<=15000,'recovery_final_evidence_expired');
    // After this callback, the base transaction issues COMMIT. Any subsequent
    // exception is conservatively uncertain until the receipt is read.
    this.commitMayHaveBeenAttempted=true;
    return out;
   }finally{connection.close();connection.cleanup(false);}
  },{lockTimeoutMs:1200});
 }
}

/** All authenticated evidence stays in this closure. There is no separate
 * apply(snapshot) method and no serialized proof accepted from a client. */
export function createHeldUnknownAccountingRecovery(deps:Dependencies){
 return async(input:Input)=>{
  if(!uuid(input.ownerId)||!uuid(input.targetIntentId)||!uuid(input.fenceReceiptId)||
   input.confirmation!==OWNER_UNKNOWN_ACCOUNTING_CONFIRMATION)
   return no('explicit_authenticated_owner_confirmation_required',{accountingCommitted:false});
  if(typeof deps?.now!=='function'||typeof deps.isScheduled!=='function'||typeof deps.material!=='function'||
   typeof deps.readFeeds!=='function'||!deps.db||typeof deps.db.connect!=='function')
   return no('recovery_dependencies_unavailable',{accountingCommitted:false});
  let ledger:HeldAccountingLedger|null=null;
  try{
   const before=await captureHeld(deps.db,input,deps);
   // Load the restricted signer only after the committed killed-context gate.
   let material=await deps.material(deps.db,{owner_id:input.ownerId,
    kalshi_connection_id:String(before.account.kalshi_connection_id),key_fingerprint:String(before.account.key_fingerprint)});
   requireProof(material&&dedicatedSignerFingerprint(material.keyId,material.privateKey)===before.account.key_fingerprint,
    'recovery_restricted_signer_unverified');
   const started=deps.now();requireProof(validClock(started)&&started>=before.readCompletedAtMs,'recovery_clock_invalid');
   let feed:Awaited<ReturnType<Dependencies['readFeeds']>>;
   try{feed=await deps.readFeeds(material!,started);}finally{material=null;}
   requireProof(feed.ok,'recovery_signed_feed_unavailable');if(!feed.ok)throw Error('recovery_signed_feed_unavailable');
   requireProof(feed.observedAtMs===started&&feed.historicalCoverageComplete===true,'recovery_complete_signed_feed_required');
   const snapshot=personalAccountSnapshot(identity(before.account),feed,before.intents.map(i=>i.request as Request));
   requireProof('identity' in snapshot,'recovery_signed_history_mapping_failed');
   if(!('identity' in snapshot))throw Error('recovery_signed_history_mapping_failed');
   const after=await captureHeld(deps.db,input,deps);
   const plan=planOwnerUnknownReconciliation({ownerId:input.ownerId,targetIntentId:input.targetIntentId,
    confirmation:input.confirmation,nowMs:deps.now(),heldBefore:before.hold,heldAfter:after.hold,
    intents:before.intents,finalIntents:after.intents,historicalCoverageComplete:feed.historicalCoverageComplete,snapshot});
   requireProof(plan.ok,'recovery_plan_'+plan.reason);
   ledger=new HeldAccountingLedger(deps.db,input,before,snapshot,deps);
   const pointer=await ledger.reconcile(snapshot,String(before.account.revision),deps.now());
   return {ok:true as const,reason:'unknown_accounting_reconciled_execution_remains_killed',
    accountingCommitted:true as const,ordersSubmitted:false as const,workerStarted:false as const,
    tradingAuthorized:false as const,riskFreezeCleared:false as const,receiptId:ledger.receiptId,
    reconciliationObservationId:pointer.observationId,accountId:pointer.accountId};
  }catch(error){
   if(ledger?.commitMayHaveBeenAttempted)return no('recovery_accounting_commit_outcome_unverified',{
    accountingCommitted:null,outcomeUnknown:true,receiptId:ledger.receiptId});
   const reason=error instanceof Error&&/^(recovery|production)_[a-z_]+$/.test(error.message)?error.message:
    'recovery_accounting_failed';
   return no(reason,{accountingCommitted:false,outcomeUnknown:false});
  }
 };
}
