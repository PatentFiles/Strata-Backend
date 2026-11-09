import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH} from "@workspace/v13-strategy";
import test from 'node:test';
import {createHash,generateKeyPairSync,randomUUID,Sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dispatchReviewedProtectiveExitOnce} from './ownerFeeEmergencyExitSignedDispatch';
import {markOwnedEmergencyExitUnknownForReview} from './ownerFeeEmergencyExitUnknownCommit';
import {dedicatedSignerFingerprint} from './commissioning';
import assert from 'node:assert/strict';
import {pool} from '@workspace/db';
import {verifyReviewedProtectiveExitFee,verifyReviewedProtectiveExitFeeAuthority} from './reviewedProtectiveExitFee';
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from './apiFeeSourceStage';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION} from './apiFeeRateReference';
const owner='11111111-1111-4111-8111-111111111111',admin='22222222-2222-4222-8222-222222222222';
const grant='33333333-3333-4333-8333-333333333333',model='44444444-4444-4444-8444-444444444444';
const review='55555555-5555-4555-8555-555555555555',consent='66666666-6666-4666-8666-666666666666';
const delegation='77777777-7777-4777-8777-777777777777',exit='88888888-8888-4888-8888-888888888888';
const sha='a'.repeat(40),policy='b'.repeat(64),account='protective-test';
test('actual successor verifier and dispatcher: real UNKNOWN, final standing/reservation fence, revocation and expiry',async(t)=>{
 const url=new URL(process.env.DATABASE_URL!);
 assert.ok(['127.0.0.1','localhost'].includes(url.hostname));assert.equal(process.env.NODE_ENV,'test');
 assert.match(url.pathname,/disposable/);
 const db=await pool.connect();
 try{
 await db.query(`CREATE SCHEMA IF NOT EXISTS private; CREATE SCHEMA IF NOT EXISTS auth;
 CREATE TABLE auth.users(id uuid,email text,email_confirmed_at timestamptz);
 CREATE TABLE private.role_assignments(email text,role text);
 CREATE TABLE public.profiles(id uuid,role text);
 CREATE TABLE public.v13_production_account(id text,owner_user_id uuid,policy_id text,subaccount int,exchange_index int,commissioned boolean,execution_enabled boolean,kill_switch boolean);
 CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,policy_hash text,state text,approved_at timestamptz,fee_policy_version text,fee_formula_version text,fee_source_url text,max_quote_age_ms integer DEFAULT 5000);
 CREATE TABLE private.strata_api_fee_source_grants(grant_id uuid,owner_user_id uuid,issuer_admin_id uuid,rate_decision_digest text,fee_model_version text,scope text,policy_version text,confirmation text,issued_at timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_api_fee_rate_reviews(review_id uuid,owner_user_id uuid,reviewer_user_id uuid,rate_decision_digest text,fee_model_version text,scope text,confirmation text,signed_at timestamptz,expires_at timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_api_fee_owner_consents(consent_id uuid,owner_user_id uuid,grant_id uuid,confirmation text,confirmed_at timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_api_fee_standing_models(model_id uuid,reviewer_admin_id uuid,rate_decision_digest text,fee_model_version text,scope text,release_commit_sha text,signed_at timestamptz,valid_until timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_api_fee_standing_delegations(delegation_id uuid,owner_user_id uuid,model_id uuid,grant_id uuid,policy_hash text,release_commit_sha text,confirmation text,granted_at timestamptz,valid_until timestamptz,lease_expires_at timestamptz,revoked_at timestamptz);
 CREATE TABLE private.strata_standing_execution_reviews(release_id uuid,owner_user_id uuid,execution_account_id text,policy_hash text,release_commit_sha text,independent_reviewer_id uuid,state text,confirmation text,created_at timestamptz,revoked_at timestamptz);`);
 const before=new Date(Date.now()-3600_000).toISOString(),prior=new Date(Date.now()-7200_000).toISOString(),future=new Date(Date.now()+3600_000).toISOString();
 const insert=async(table:string,row:Record<string,unknown>)=>{const keys=Object.keys(row);await db.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));};
 await insert('auth.users',{id:admin,email:'admin@test.invalid',email_confirmed_at:before});
 await insert('private.role_assignments',{email:'admin@test.invalid',role:'ADMIN'});
 await insert('public.profiles',{id:admin,role:'ADMIN'});
 await insert('public.v13_production_account',{id:account,owner_user_id:owner,policy_id:'p',subaccount:1,exchange_index:2,commissioned:true,execution_enabled:true,kill_switch:false});
 await insert('public.v13_live_money_policy',{id:'p',execution_account_id:account,policy_hash:policy,state:'APPROVED',approved_at:before,fee_policy_version:API_SOURCE_POLICY_VERSION,fee_formula_version:API_SOURCE_FORMULA_VERSION,fee_source_url:'strata-api-reviewed://kxbtc15m/'+grant});
 await insert('private.strata_api_fee_source_grants',{grant_id:grant,owner_user_id:owner,issuer_admin_id:admin,rate_decision_digest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,fee_model_version:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,scope:'KXBTC15M:INDEX2',policy_version:API_SOURCE_POLICY_VERSION,confirmation:'ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1',issued_at:before});
 await insert('private.strata_api_fee_rate_reviews',{review_id:review,owner_user_id:owner,reviewer_user_id:admin,rate_decision_digest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,fee_model_version:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,scope:'KXBTC15M:INDEX2',confirmation:'I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1',signed_at:prior,expires_at:future});
 await insert('private.strata_api_fee_owner_consents',{consent_id:consent,owner_user_id:owner,grant_id:grant,confirmation:'CONFIRM_REVIEWED_API_FEE_SOURCE_V1',confirmed_at:before});
 const check=()=>verifyReviewedProtectiveExitFeeAuthority(owner,account,sha,db);
 assert.equal((await check()).proofKind,'legacy');
 await db.query(`UPDATE private.strata_api_fee_rate_reviews SET expires_at=now()-interval '1 second'`);
 assert.equal((await check()).ok,false);
 await insert('private.strata_api_fee_standing_models',{model_id:model,reviewer_admin_id:admin,rate_decision_digest:PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,fee_model_version:PDF_FREE_RATE_REVIEW_VECTOR_VERSION,scope:'KXBTC15M:INDEX2',release_commit_sha:sha,signed_at:before,valid_until:future});
 await insert('private.strata_api_fee_standing_delegations',{delegation_id:delegation,owner_user_id:owner,model_id:model,grant_id:grant,policy_hash:policy,release_commit_sha:sha,confirmation:'I_AUTHORIZE_MY_ACCOUNT_FOR_STANDING_KXBTC15M_FEE_MODEL_V1',granted_at:before,valid_until:future,lease_expires_at:prior});
 assert.equal((await check()).ok,false,'monetary consent alone is not exit review');
 await insert('private.strata_standing_execution_reviews',{release_id:exit,owner_user_id:owner,execution_account_id:account,policy_hash:policy,release_commit_sha:sha,independent_reviewer_id:admin,state:'approved',confirmation:'I_INDEPENDENTLY_APPROVE_STANDING_ENTRIES_AND_REDUCE_ONLY_EXITS_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1',created_at:before});
 const original=await check();assert.equal(original.ok,true);assert.equal(original.proofKind,'standing_successor');
 await db.query(`ALTER TABLE public.v13_production_account ADD key_fingerprint text,ADD minimum_exit_micros bigint;
 CREATE TABLE public.live_execution_config(id text,live_execution_enabled boolean,manual_kill_switch boolean);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,holder_id text,fencing_token bigint,state text,credential_fingerprint text,account_kill boolean,heartbeat_at timestamptz);
 CREATE TABLE public.v13_production_position(id text,account_id text,market text,side text,quantity_hundredths bigint);
 CREATE TABLE public.v13_production_observation(account_id text,kind text);
 CREATE TABLE public.v13_production_intent(id text,parent_id text,account_id text,client_order_id text,market text,kind text,state text,terminal boolean,exchange_order_id text,filled_hundredths bigint,reserved_micros bigint,side text,request jsonb,decision jsonb,policy_hash text,dispatch_at timestamptz);
 CREATE TABLE private.strata_emergency_exit_reservations(reservation_id uuid,owner_user_id uuid,execution_account_id text,client_order_id text,market_ticker text,reducing_side text,quantity_hundredths bigint,worker_holder_id text,worker_fencing_token bigint,state text,trading_authorized boolean,order_digest text,initial_position_fp text,created_at timestamptz,updated_at timestamptz);
 CREATE TABLE private.strata_protective_exit_release(release_commit_sha text,state text,created_at timestamptz,expires_at timestamptz,revoked_at timestamptz,independent_reviewer_id uuid,operator_approver_id uuid);
 CREATE TABLE private.strata_protective_exit_local_no_send(reservation_id uuid PRIMARY KEY,owner_user_id uuid,execution_account_id text,client_order_id text,order_digest text,worker_holder_id text,worker_fencing_token bigint,reason text,evidence_sha256 text,signer_fingerprint text,market_ticker text,reducing_side text,quantity_hundredths bigint,limit_micros bigint);`);
 const quantitySql=readFileSync('../../sql/strata_protective_exit_fractional_quantity.sql','utf8');
 await db.query(quantitySql.slice(quantitySql.indexOf('CREATE OR REPLACE FUNCTION private.strata_exit_request_quantity_hundredths'),quantitySql.indexOf('REVOKE ALL ON FUNCTION private.strata_exit_request_quantity_hundredths')));
 const material={keyId:'isolated-test-only',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}).toString()};
 const fingerprint=dedicatedSignerFingerprint(material.keyId,material.privateKey);
 await db.query('UPDATE public.v13_production_account SET key_fingerprint=$1,minimum_exit_micros=400000',[fingerprint]);
 await insert('public.live_execution_config',{id:'singleton',live_execution_enabled:true,manual_kill_switch:false});
 await insert('private.kalshi_account_worker_lease',{execution_account_id:account,owner_user_id:owner,holder_id:'worker',fencing_token:8,state:'owned',credential_fingerprint:fingerprint,account_kill:false,heartbeat_at:new Date()});
 await insert('public.v13_production_observation',{account_id:account,kind:'OWNER_ACTIVATION_REQUEST'});
 const results=[];
 for(const scenario of ['valid-unknown','revoke-after-provider','change-proof-after-provider','expire-during-query','expire-after-commit','stale-provider-delay','stale-provider-pool-wait','stale-provider-commit-delay','first-proof-only-stale','stale-provider-signing-delay','stale-source-final','stale-source-final-no-send-rollback','future-source-final','stale-source-after-commit','malformed-source-final','no-send-audit-rollback','final-lock-probe','legacy-release-expiry'] as const){
  await db.query(`TRUNCATE public.v13_production_position,public.v13_production_intent,private.strata_emergency_exit_reservations,private.strata_protective_exit_local_no_send`);
  await db.query(`UPDATE private.strata_api_fee_standing_models SET valid_until=clock_timestamp()+interval '1 hour',revoked_at=NULL`);
  await db.query(`UPDATE private.strata_api_fee_standing_delegations SET valid_until=clock_timestamp()+interval '50 minutes',revoked_at=NULL`);
  await db.query('DROP TRIGGER IF EXISTS synthetic_block_failure ON public.v13_production_intent');
  if(scenario==='no-send-audit-rollback'||scenario==='stale-source-final-no-send-rollback'){
   await db.query(`CREATE OR REPLACE FUNCTION public.synthetic_block_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_block_failure'; END $$;
    CREATE TRIGGER synthetic_block_failure BEFORE UPDATE ON public.v13_production_intent FOR EACH ROW WHEN (NEW.state='BLOCKED') EXECUTE FUNCTION public.synthetic_block_failure()`);
  }
  if(scenario==='legacy-release-expiry'){
   await db.query('TRUNCATE private.strata_standing_execution_reviews,private.strata_api_fee_standing_models,private.strata_api_fee_standing_delegations');
   await db.query("UPDATE private.strata_api_fee_rate_reviews SET expires_at=clock_timestamp()+interval '1 hour'");
   await insert('private.strata_protective_exit_release',{release_commit_sha:sha,state:'approved',created_at:before,expires_at:future,independent_reviewer_id:admin,operator_approver_id:owner});
  }
  const noSend=scenario==='expire-after-commit'||scenario.startsWith('stale-provider-')||scenario==='stale-source-after-commit'||scenario==='stale-source-final'||scenario==='legacy-release-expiry';
  const reservationId=randomUUID(),clientId='v13p-'+randomUUID(),market='KXBTC15M-26NOV031945-45';
  const order={ticker:market,client_order_id:clientId,side:'ask',count:'2.00',price:'0.5500',time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:true,subaccount:1,exchange_index:2};
  const request={action:'SELL',reduceOnly:true,timeInForce:'IOC',market,side:'YES',clientOrderId:clientId,contracts:2,limitMicros:550000};
  const digest=createHash('sha256').update(JSON.stringify(order)).digest('hex');
  await insert('public.v13_production_position',{id:'parent',account_id:account,market,side:'YES',quantity_hundredths:300});
  await insert('public.v13_production_intent',{id:'parent',account_id:account,kind:'ENTRY',state:'FILLED',terminal:true});
  await insert('public.v13_production_intent',{id:'exit',parent_id:'parent',account_id:account,client_order_id:clientId,market,kind:'EXIT',state:'PREPARED',terminal:false,filled_hundredths:0,reserved_micros:0,side:'YES',request:JSON.stringify(request),policy_hash:policy,decision:JSON.stringify({ownedEvaluation:{sourcePaperEvaluationId:'synthetic-source',source:{id:'synthetic-source',market_ticker:market,evaluated_at:new Date(Date.now()-(scenario.startsWith('stale-source-final')?6001:scenario==='future-source-final'?-3600000:0)).toISOString(),feed_freshness:'current',strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,btc_provider_age_ms:0,btc_receive_age_ms:0,market_age_ms:0}}})});
  await insert('private.strata_emergency_exit_reservations',{reservation_id:reservationId,owner_user_id:owner,execution_account_id:account,client_order_id:clientId,market_ticker:market,reducing_side:'YES',quantity_hundredths:200,worker_holder_id:'worker',worker_fencing_token:8,state:'PREPARED',trading_authorized:false,order_digest:digest,initial_position_fp:'3.00',created_at:new Date(),updated_at:new Date()});
  if(scenario==='malformed-source-final')await db.query(`UPDATE public.v13_production_intent SET decision=jsonb_set(decision,'{ownedEvaluation,source,evaluated_at}','"not-a-timestamp"'::jsonb) WHERE kind='EXIT'`);
  await db.query('UPDATE private.kalshi_account_worker_lease SET heartbeat_at=clock_timestamp()');
  // These scenarios test exact boundary expiry, not host scheduling latency.
  // Wall time for provider/advisory evidence and monotonic elapsed share one
  // test-local clock; PostgreSQL predicates and returned budgets stay native.
  const wallBase=Date.now();let elapsedMs=0;
  const now=()=>wallBase+elapsedMs,advance=(ms:number)=>{assert.ok(Number.isSafeInteger(ms)&&ms>=0);elapsedMs+=ms;};
  t.mock.method(performance,'now',()=>elapsedMs);
  const failures:Array<{sql:string;code:string;message:string}>=[];let auditInsertAttempts=0;
  let markerOutcome:unknown=null;const feeProofs:Array<Awaited<ReturnType<typeof verifyReviewedProtectiveExitFee>>>=[];
  let authorityBudgetMs=NaN,sourceBudgetMs=NaN,releaseBudgetMs=NaN,heartbeatBudgetMs=NaN,reservationBudgetMs=NaN;
  let firstMarkerPrepared=false,finalFixturePrepared=false;
  let lastProviderAt=0,providerAgeAtFinal=0;
  let connections=0;
  let feeCalls=0,providerCalls=0,authorityCalls=0,posts=0,signCalls=0,finalSuccessorQueries=0,finalFenceQueries=0,commitDelayed=false;
  const txDb={connect:async()=>{
   connections++;if(connections===2&&scenario==='stale-provider-pool-wait')advance(3100);
   const c=await pool.connect();let finalAuthority=false;
   return {release:()=>c.release(),query:async(sql:string,args?:unknown[])=>{
    if(sql==='BEGIN'&&connections===1&&!firstMarkerPrepared){
     const out=await c.query(sql,args);firstMarkerPrepared=true;
     // Seed only the first PREPARED marker fixture. now() is this transaction's
     // start, so unrelated initial fee/setup latency cannot expire its lease.
     // Never refresh a consumed reservation, its updated_at, or a repeat.
     await c.query("UPDATE private.strata_emergency_exit_reservations SET created_at=now() WHERE reservation_id=$1 AND state='PREPARED'",[reservationId]);
     await c.query('UPDATE private.kalshi_account_worker_lease SET heartbeat_at=now() WHERE execution_account_id=$1',[account]);
     return out;
    }
    if(sql.includes('SELECT d.delegation_id')){
     finalAuthority=true;finalSuccessorQueries++;
     // Native successor SQL must itself reject the expired rows. The original
     // sleep happened before this same query; explicit fixture expiry removes
     // scheduler dependence without replacing SQL or its returned evidence.
     if(scenario==='expire-during-query')await db.query("UPDATE private.strata_api_fee_standing_models SET valid_until=clock_timestamp()-interval '1 second'; UPDATE private.strata_api_fee_standing_delegations SET valid_until=clock_timestamp()-interval '2 seconds'");
     if(scenario==='expire-after-commit')await db.query("UPDATE private.strata_api_fee_standing_models SET valid_until=clock_timestamp()+interval '2 seconds'; UPDATE private.strata_api_fee_standing_delegations SET valid_until=clock_timestamp()+interval '1 second'");
     if(scenario==='stale-provider-delay')advance(3100);
    }
    if(sql.includes('AS reservation_age_ms')){
     finalAuthority=true;finalFenceQueries++;providerAgeAtFinal=now()-lastProviderAt;
     assert.equal(finalFixturePrepared,false);finalFixturePrepared=true;
     // Separate autocommit fixture writes release their locks before the native
     // final fence, preserving the intent/policy SHARE-lock contention probes.
     // The real UNKNOWN reservation.updated_at is never refreshed here.
     await db.query('UPDATE private.kalshi_account_worker_lease SET heartbeat_at=clock_timestamp() WHERE execution_account_id=$1',[account]);
     if(scenario!=='malformed-source-final'){
      const sourceAge=scenario.startsWith('stale-source-final')?6001:scenario==='future-source-final'?-3600000:(scenario==='stale-source-after-commit'||scenario==='no-send-audit-rollback')?4000:0;
      await db.query(`UPDATE public.v13_production_intent SET decision=jsonb_set(decision,'{ownedEvaluation,source,evaluated_at}',to_jsonb(clock_timestamp()-($1::double precision * interval '1 millisecond'))) WHERE kind='EXIT'`,[sourceAge]);
     }
     if(scenario==='legacy-release-expiry')await db.query("UPDATE private.strata_protective_exit_release SET expires_at=clock_timestamp()+interval '1 second'");
    }
    if(sql.startsWith('INSERT INTO private.strata_protective_exit_local_no_send'))auditInsertAttempts++;
    let out;
    try{out=await c.query(sql,args);}catch(error:any){failures.push({sql,code:error.code,message:error.message});throw error;}
    if(sql.includes('SELECT d.delegation_id')&&scenario==='expire-after-commit'){
     assert.equal(out.rows.length,1,'positive native authority must be observed before commit expiry');
     assert.ok(Number.isFinite(out.rows[0].valid_for_ms)&&out.rows[0].valid_for_ms>0&&out.rows[0].valid_for_ms+1<3000);
    }
    if(sql.includes('AS reservation_age_ms')&&out.rows.length===1){
     sourceBudgetMs=Number(out.rows[0].max_quote_age_ms)-Number(out.rows[0].source_age_ms);
     releaseBudgetMs=Number(out.rows[0].release_remaining_ms);
     heartbeatBudgetMs=5000-Number(out.rows[0].heartbeat_age_ms);
     reservationBudgetMs=8000-Number(out.rows[0].reservation_age_ms);
     if(scenario.startsWith('stale-provider-')){
      const required=scenario==='stale-provider-signing-delay'||scenario==='stale-provider-commit-delay'?3100:0;
      assert.ok([sourceBudgetMs,heartbeatBudgetMs,reservationBudgetMs].every(b=>Number.isFinite(b)&&b>required),'provider expiry must not be masked by native source/heartbeat/reservation expiry');
      assert.ok(Number.isFinite(authorityBudgetMs)&&authorityBudgetMs>3100,'provider expiry must not be masked by authority expiry');
     }
    }
    if(sql.includes('AS reservation_age_ms')&&scenario==='final-lock-probe'){
     assert.equal(out.rows.length,1);assert.equal(typeof out.rows[0].source_age_ms,'number');
     assert.equal(typeof out.rows[0].max_quote_age_ms,'number');
     const contender=await pool.connect();
     try{
      for(const statement of ["UPDATE public.v13_production_intent SET policy_hash=policy_hash WHERE kind='EXIT'","UPDATE public.v13_live_money_policy SET max_quote_age_ms=max_quote_age_ms"]){
       await contender.query('BEGIN');await contender.query("SET LOCAL lock_timeout='50ms'");
       await assert.rejects(contender.query(statement),(error:any)=>error.code==='55P03');
       await contender.query('ROLLBACK');
      }
     }finally{contender.release();}
    }
    if(sql==='COMMIT'&&finalAuthority&&(scenario==='expire-after-commit'||scenario==='stale-provider-commit-delay'||scenario==='stale-source-after-commit'||scenario==='no-send-audit-rollback'||scenario==='legacy-release-expiry')&&!commitDelayed){
     commitDelayed=true;
     const budget=scenario==='expire-after-commit'?authorityBudgetMs:scenario==='legacy-release-expiry'?releaseBudgetMs:sourceBudgetMs;
     if(scenario!=='stale-provider-commit-delay')assert.ok(Number.isFinite(budget)&&budget>0&&budget<3000,'native expiry budget must be positive and isolate this boundary');
     const step=scenario==='stale-provider-commit-delay'?3100:Math.floor(budget)+1;
     if(scenario==='expire-after-commit'||scenario==='legacy-release-expiry'){
      assert.ok(sourceBudgetMs>step&&heartbeatBudgetMs>step&&reservationBudgetMs>step,'authority/release expiry must precede other native evidence expiry');
     }
     if(scenario==='stale-source-after-commit'||scenario==='no-send-audit-rollback')assert.ok(heartbeatBudgetMs>step&&reservationBudgetMs>step,'source expiry must precede heartbeat/reservation expiry');
     advance(step);
    }
    return out;
   }};
  }};
  const verifyFee=async()=>{
   feeCalls++;
   const proof=await verifyReviewedProtectiveExitFee(owner,account,market,{
    db:pool,sha:()=>sha,now,readFee:async()=>{
     providerCalls++;
     if(providerCalls===2){
      if(scenario==='revoke-after-provider')await pool.query('UPDATE private.strata_api_fee_standing_delegations SET revoked_at=clock_timestamp()');
      if(scenario==='change-proof-after-provider')await pool.query('UPDATE private.strata_standing_execution_reviews SET release_id=$1',[randomUUID()]);
     }
     lastProviderAt=now();return {ok:true,marketTicker:market,marketOpen:true,observedAtMs:lastProviderAt,fingerprint:'c'.repeat(64)} as never;
    },
   });
   feeProofs.push(proof);return proof;
  };
  const input={ownerId:owner,accountId:account,reservationId,material,order,lease:{holderId:'worker',fencingToken:8}};
  const ports={db:txDb,monotonicNow:()=>elapsedMs,verifyFee:verifyFee as never,
   verifyFeeAuthority:async(o:string,a:string,s:string,c:any)=>{
    authorityCalls++;const approved=await verifyReviewedProtectiveExitFeeAuthority(o,a,s,c);authorityBudgetMs=approved.validForMs??NaN;
    if(scenario==='expire-after-commit'){
     assert.equal(approved.ok,true);
     assert.ok(Number.isFinite(authorityBudgetMs)&&authorityBudgetMs>0&&authorityBudgetMs+1<3000);
    }
    return approved;
   },
   mark:async()=>{const marked=await markOwnedEmergencyExitUnknownForReview(owner,account,reservationId,material,order,input.lease,{db:txDb,now,inspect:async()=>({diagnosticEligible:true,tradingAuthorized:false,verifiedPositionFp:'3.00',verifiedPositionObservedAtMs:now()}) as never});markerOutcome=marked;if(scenario==='first-proof-only-stale')advance(3100);return marked;},
   post:async()=>{posts++;throw Error('isolated_uncertain_transport');},
  };
  if(scenario==='stale-provider-signing-delay'){
   const sign=Sign.prototype.sign;
   t.mock.method(Sign.prototype,'sign',function(this:any,...args:any[]){
    const result=(sign as any).apply(this,args);
    signCalls++;assert.equal(feeCalls,2,'signing must follow both real fee verifications');advance(3100);
    return result;
   });
   t.mock.method(globalThis,'fetch',async()=>{posts++;throw Error('raw_fetch_must_not_run');});
   (ports as any).post=undefined;
  }
  const result=await dispatchReviewedProtectiveExitOnce(input,ports);
  const diagnostic=JSON.stringify({scenario,result,feeProofs,markerOutcome,feeCalls,providerCalls,authorityCalls,posts,signCalls,connections,finalSuccessorQueries,finalFenceQueries,failures,elapsedMs,authorityBudgetMs,sourceBudgetMs,releaseBudgetMs,heartbeatBudgetMs,reservationBudgetMs});
  assert.equal(feeCalls,2,scenario+' actual public verifier twice '+diagnostic);assert.equal(providerCalls,2);
  if(scenario==='expire-after-commit'||scenario==='stale-provider-commit-delay'||scenario==='stale-source-after-commit'||scenario==='no-send-audit-rollback'||scenario==='legacy-release-expiry')assert.equal(commitDelayed,true,'intended expiry must occur after the real final COMMIT '+diagnostic);
  if(scenario==='stale-provider-signing-delay')assert.equal(signCalls,1,'intended expiry must occur inside real signing '+diagnostic);
  if(scenario==='stale-source-final')assert.equal(auditInsertAttempts,1,'intact already-expired evidence must receive audited no-send cleanup');
  if(scenario==='future-source-final')assert.equal(auditInsertAttempts,0,'future timestamps are invalid, never authenticated expiry');
  if(scenario==='malformed-source-final'){
   assert.ok(failures.some(f=>f.sql.includes('AS source_age_ms')&&f.code==='22007'),'actual timestamp cast must fail');
  }
  if(scenario==='no-send-audit-rollback'||scenario==='stale-source-final-no-send-rollback'){
   assert.equal(auditInsertAttempts,1,'audit insert precedes failing financial update');
   assert.ok(failures.some(f=>f.sql.startsWith("UPDATE public.v13_production_intent SET state='BLOCKED'")&&f.code==='P0001'&&f.message==='synthetic_block_failure'),'actual trigger must abort no-send transaction');
  }
  assert.equal(authorityCalls,1);assert.equal(finalSuccessorQueries,scenario==='legacy-release-expiry'?0:1);
  assert.equal(finalFenceQueries,scenario==='revoke-after-provider'||scenario==='change-proof-after-provider'||scenario==='expire-during-query'?0:1);
  assert.equal(posts,(scenario==='valid-unknown'||scenario==='first-proof-only-stale'||scenario==='final-lock-probe')?1:0,scenario+JSON.stringify(result));
  assert.equal(result.postAttempted,scenario==='valid-unknown'||scenario==='first-proof-only-stale'||scenario==='final-lock-probe');assert.equal(result.mayRetry,false);
  const state=(await db.query('SELECT state FROM private.strata_emergency_exit_reservations')).rows[0].state;
  assert.equal(state,noSend?'VOID':'UNKNOWN');
  assert.equal(result.state,noSend?'BLOCKED':'UNKNOWN');
  const priorPosts=posts;
  const repeated=await dispatchReviewedProtectiveExitOnce(input,ports);
  assert.notEqual(feeProofs.at(-1)?.reason,'protective_fee_clock_invalid','repeat must not pass merely because the test clock became fractional');
  assert.equal(posts,priorPosts);assert.equal(repeated.postAttempted,false);assert.equal(repeated.mayRetry,false);
  assert.equal((await db.query('SELECT state FROM private.strata_emergency_exit_reservations')).rows[0].state,state,'repeat preserves original durable reservation distinction');
  assert.equal((await db.query("SELECT state FROM public.v13_production_intent WHERE kind='EXIT'")).rows[0].state,noSend?'BLOCKED':'DISPATCHED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM private.strata_protective_exit_local_no_send')).rows[0].n,noSend?1:0,'repeat cannot manufacture or duplicate no-send audit');
  assert.equal((await db.query('SELECT quantity_hundredths FROM public.v13_production_position')).rows[0].quantity_hundredths,'300');
  results.push({scenario,providerAgeAtFinal,state:result.state,ledger:state,posts,signCalls,feeCalls,authorityCalls,finalSuccessorQueries,finalFenceQueries,repeatState:repeated.state,repeatFeeReason:feeProofs.at(-1)?.reason,elapsedMs,authorityBudgetMs,sourceBudgetMs,releaseBudgetMs,heartbeatBudgetMs,reservationBudgetMs});
  t.mock.restoreAll();
 }
 console.log('REAL_AUTHORITY_DISPATCH_RESULTS '+JSON.stringify(results));
 }finally{db.release();await pool.end();}
});
