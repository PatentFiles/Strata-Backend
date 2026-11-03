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
 CREATE TABLE public.v13_live_money_policy(id text,execution_account_id text,policy_hash text,state text,approved_at timestamptz,fee_policy_version text,fee_formula_version text,fee_source_url text);
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
 CREATE TABLE public.v13_production_intent(id text,parent_id text,account_id text,client_order_id text,market text,kind text,state text,terminal boolean,exchange_order_id text,filled_hundredths bigint,reserved_micros bigint,side text,request jsonb,dispatch_at timestamptz);
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
 for(const scenario of ['valid-unknown','revoke-after-provider','change-proof-after-provider','expire-during-query','expire-after-commit','stale-provider-delay','stale-provider-pool-wait','stale-provider-commit-delay','first-proof-only-stale','stale-provider-signing-delay'] as const){
  await db.query(`TRUNCATE public.v13_production_position,public.v13_production_intent,private.strata_emergency_exit_reservations,private.strata_protective_exit_local_no_send`);
  await db.query(`UPDATE private.strata_api_fee_standing_models SET valid_until=clock_timestamp()+interval '1 hour',revoked_at=NULL`);
  await db.query(`UPDATE private.strata_api_fee_standing_delegations SET valid_until=clock_timestamp()+interval '50 minutes',revoked_at=NULL`);
  const reservationId=randomUUID(),clientId='v13p-'+randomUUID(),market='KXBTC15M-26NOV031945-45';
  const order={ticker:market,client_order_id:clientId,side:'ask',count:'2.00',price:'0.5500',time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:true,subaccount:1,exchange_index:2};
  const request={action:'SELL',reduceOnly:true,timeInForce:'IOC',market,side:'YES',clientOrderId:clientId,contracts:2,limitMicros:550000};
  const digest=createHash('sha256').update(JSON.stringify(order)).digest('hex');
  await insert('public.v13_production_position',{id:'parent',account_id:account,market,side:'YES',quantity_hundredths:300});
  await insert('public.v13_production_intent',{id:'parent',account_id:account,kind:'ENTRY',state:'FILLED',terminal:true});
  await insert('public.v13_production_intent',{id:'exit',parent_id:'parent',account_id:account,client_order_id:clientId,market,kind:'EXIT',state:'PREPARED',terminal:false,filled_hundredths:0,reserved_micros:0,side:'YES',request:JSON.stringify(request)});
  await insert('private.strata_emergency_exit_reservations',{reservation_id:reservationId,owner_user_id:owner,execution_account_id:account,client_order_id:clientId,market_ticker:market,reducing_side:'YES',quantity_hundredths:200,worker_holder_id:'worker',worker_fencing_token:8,state:'PREPARED',trading_authorized:false,order_digest:digest,initial_position_fp:'3.00',created_at:new Date(),updated_at:new Date()});
  await db.query('UPDATE private.kalshi_account_worker_lease SET heartbeat_at=clock_timestamp()');
  let lastProviderAt=0,providerAgeAtFinal=0;
  let connections=0;
  let feeCalls=0,providerCalls=0,authorityCalls=0,posts=0,finalSuccessorQueries=0,finalFenceQueries=0,commitDelayed=false;
  const txDb={connect:async()=>{
   connections++;if(connections===2&&scenario==='stale-provider-pool-wait')await new Promise(r=>setTimeout(r,3100));
   const c=await pool.connect();let finalAuthority=false;
   return {release:()=>c.release(),query:async(sql:string,args?:unknown[])=>{
    if(sql.includes('SELECT d.delegation_id')){
     finalAuthority=true;finalSuccessorQueries++;
     if(scenario==='expire-during-query')await c.query('SELECT pg_sleep(0.35)');
     if(scenario==='stale-provider-delay')await c.query('SELECT pg_sleep(3.10)');
    }
    if(sql.includes('AS reservation_age_ms')){finalFenceQueries++;providerAgeAtFinal=Date.now()-lastProviderAt;}
    const out=await c.query(sql,args);
    if(sql==='COMMIT'&&finalAuthority&&(scenario==='expire-after-commit'||scenario==='stale-provider-commit-delay')&&!commitDelayed){
     commitDelayed=true;await new Promise(r=>setTimeout(r,scenario==='expire-after-commit'?350:3100));
    }
    return out;
   }};
  }};
  const verifyFee=async()=>{
   feeCalls++;
   return verifyReviewedProtectiveExitFee(owner,account,market,{
    db:pool,sha:()=>sha,readFee:async()=>{
     providerCalls++;
     if(providerCalls===2){
      if(scenario==='revoke-after-provider')await pool.query('UPDATE private.strata_api_fee_standing_delegations SET revoked_at=clock_timestamp()');
      if(scenario==='change-proof-after-provider')await pool.query('UPDATE private.strata_standing_execution_reviews SET release_id=$1',[randomUUID()]);
      if(scenario.startsWith('expire-'))await pool.query(`UPDATE private.strata_api_fee_standing_models SET valid_until=clock_timestamp()+interval '0.25 second'; UPDATE private.strata_api_fee_standing_delegations SET valid_until=clock_timestamp()+interval '0.20 second'`);
     }
     lastProviderAt=Date.now();return {ok:true,marketTicker:market,marketOpen:true,observedAtMs:lastProviderAt,fingerprint:'c'.repeat(64)} as never;
    },
   });
  };
  const input={ownerId:owner,accountId:account,reservationId,material,order,lease:{holderId:'worker',fencingToken:8}};
  const ports={db:txDb,verifyFee:verifyFee as never,
   verifyFeeAuthority:async(o:string,a:string,s:string,c:any)=>{authorityCalls++;return verifyReviewedProtectiveExitFeeAuthority(o,a,s,c);},
   mark:async()=>{const marked=await markOwnedEmergencyExitUnknownForReview(owner,account,reservationId,material,order,input.lease,{db:txDb,inspect:async()=>({diagnosticEligible:true,tradingAuthorized:false,verifiedPositionFp:'3.00',verifiedPositionObservedAtMs:Date.now()}) as never});if(scenario==='first-proof-only-stale')await new Promise(r=>setTimeout(r,3100));return marked;},
   post:async()=>{posts++;throw Error('isolated_uncertain_transport');},
  };
  if(scenario==='stale-provider-signing-delay'){
   const sign=Sign.prototype.sign;
   t.mock.method(Sign.prototype,'sign',function(this:any,...args:any[]){
    const result=(sign as any).apply(this,args),start=performance.now();
    while(performance.now()-start<3100){} // isolated synthetic synchronous signing delay
    return result;
   });
   t.mock.method(globalThis,'fetch',async()=>{posts++;throw Error('raw_fetch_must_not_run');});
   (ports as any).post=undefined;
  }
  const result=await dispatchReviewedProtectiveExitOnce(input,ports);
  assert.equal(feeCalls,2,scenario+' actual public verifier twice');assert.equal(providerCalls,2);
  assert.equal(authorityCalls,1);assert.equal(finalSuccessorQueries,1);
  assert.equal(finalFenceQueries,scenario==='revoke-after-provider'||scenario==='change-proof-after-provider'||scenario==='expire-during-query'?0:1);
  assert.equal(posts,(scenario==='valid-unknown'||scenario==='first-proof-only-stale')?1:0,scenario+JSON.stringify(result));
  assert.equal(result.postAttempted,scenario==='valid-unknown'||scenario==='first-proof-only-stale');assert.equal(result.mayRetry,false);
  const state=(await db.query('SELECT state FROM private.strata_emergency_exit_reservations')).rows[0].state;
  assert.equal(state,(scenario==='expire-after-commit'||scenario.startsWith('stale-provider-'))?'VOID':'UNKNOWN');
  assert.equal(result.state,(scenario==='expire-after-commit'||scenario.startsWith('stale-provider-'))?'BLOCKED':'UNKNOWN');
  const priorPosts=posts;
  const repeated=await dispatchReviewedProtectiveExitOnce(input,ports);
  assert.equal(posts,priorPosts);assert.equal(repeated.postAttempted,false);assert.equal(repeated.mayRetry,false);
  assert.equal((await db.query('SELECT state FROM private.strata_emergency_exit_reservations')).rows[0].state,state,'repeat preserves original durable reservation distinction');
  assert.equal((await db.query("SELECT state FROM public.v13_production_intent WHERE kind='EXIT'")).rows[0].state,(scenario==='expire-after-commit'||scenario.startsWith('stale-provider-'))?'BLOCKED':'DISPATCHED');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM private.strata_protective_exit_local_no_send')).rows[0].n,(scenario==='expire-after-commit'||scenario.startsWith('stale-provider-'))?1:0,'repeat cannot manufacture or duplicate no-send audit');
  assert.equal((await db.query('SELECT quantity_hundredths FROM public.v13_production_position')).rows[0].quantity_hundredths,'300');
  results.push({scenario,providerAgeAtFinal,state:result.state,ledger:state,posts,feeCalls,authorityCalls,finalSuccessorQueries,finalFenceQueries,repeatState:repeated.state});
 }
 console.log('REAL_AUTHORITY_DISPATCH_RESULTS '+JSON.stringify(results));
 }finally{db.release();await pool.end();}
});
