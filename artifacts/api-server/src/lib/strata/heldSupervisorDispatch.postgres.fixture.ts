import assert from 'node:assert/strict';
import {generateKeyPairSync,createPublicKey,verify,constants,randomUUID} from 'node:crypto';
import {pool} from '@workspace/db';
import pg from 'pg';
import {installRestrictedProtectiveRuntime,assertRestrictedAuthority,assertRestrictedOutcome} from './restrictedProtectiveRuntime.fixture';
import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH} from '@workspace/v13-strategy';
import {digest,type Request} from '../v13-production/types';
import {conservativeExitFeeMicros} from '../v13-production/fractionalExitFee';
import {maximumExitFeePerContractMicros} from '../microLiveEntryFees';
import {decodePolicy} from '../v13-production/ledger';
import {computeV13LiveMoneyPolicyHash} from '../v13LiveMoneyRisk';
import {dedicatedSignerFingerprint} from './commissioning';
import {createProductionPersonalSession,type PersonalSessionControl} from './personalExecutionSupervisor';
import {readExactEmergencyFeeEvidence} from './ownerFeeEmergencyExitMarket';
import {probeCurrentKalshiFeeApi} from './twoSourceFeeEvidence';
import {preparePdfFreeApiFeePolicyReview} from './apiFeePolicyReviewCandidate';
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from './apiFeeSourceStage';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION} from './apiFeeRateReference';
import {backendRole,installFullRecoverySchema} from './ownerUnknownRecoverySchema.fixture';

// Full real supervisor/native-ledger integration. Only external Vault storage
// and HTTP responses are fixture data. No executor, policy, reserve, dispatcher,
// outcome, scheduler or authority validator is replaced. No EXIT row is seeded.
// All approval records are SYNTHETIC and exist only in the pinned disposable DB.
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url));
const db=pool,owner='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222';
const financial='33333333-3333-4333-8333-333333333333',provider='44444444-4444-4444-8444-444444444444';
const secret='55555555-5555-4555-8555-555555555555',credential='66666666-6666-4666-8666-666666666666';
const reviewer='77777777-7777-4777-8777-777777777777',grant='88888888-8888-4888-8888-888888888888';
const account='full-schema-synthetic',policy='full-schema-policy',hash='a'.repeat(64),sha='a'.repeat(40);
const material={keyId:'offline-supervisor-only',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()};
const fingerprint=dedicatedSignerFingerprint(material.keyId,material.privateKey)!;
const sourceUrl='strata-api-reviewed://kxbtc15m/'+grant;
const request:Request={market:'KXBTC15M-SYNTHETIC',side:'NO',action:'BUY',contracts:3,limitMicros:430000,timeInForce:'IOC',reduceOnly:false,clientOrderId:`v13p-${target}`};
let policyHash=hash;
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(check:()=>Promise<boolean>,diagnostic:()=>Promise<unknown>,timeout=20000){
 const end=Date.now()+timeout;
 while(!await check()){if(Date.now()>end)assert.fail('native supervisor timeout: '+JSON.stringify(await diagnostic()));await pause(25);}
}
async function reset(artifact:string,db:pg.Pool=pool){
 await db.query("UPDATE public.live_execution_config SET mode='V13_PRODUCTION',live_execution_enabled=true,manual_kill_switch=false WHERE id='singleton'");
 // Fresh disposable cluster only. TRUNCATE is fixture reset, not a recovery path.
 await db.query('TRUNCATE vault.decrypted_secrets,private.strata_protective_exit_release CASCADE');
 await db.query(`TRUNCATE public.v13_production_account,public.v13_live_money_policy,
  public.financial_accounts,auth.users,vault.secrets,public.forward_test_evaluations CASCADE`);
 await db.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,\'owner@example.invalid\',now())',[owner]);
 await db.query('INSERT INTO vault.secrets(id) VALUES($1)',[secret]);
 await db.query('INSERT INTO public.financial_accounts(id,user_id,provider) VALUES($1,$2,\'kalshi\')',[financial,owner]);
 await db.query('INSERT INTO private.provider_connections(id,financial_account_id) VALUES($1,$2)',[provider,financial]);
 await db.query(`INSERT INTO private.kalshi_connection_credentials(id,owner_user_id,financial_account_id,
  provider_connection_id,role,vault_secret_id,key_fingerprint,verified_at,verification_reason)
  VALUES($1,$2,$3,$4,'restricted_execution',$5,$6,now(),'credential_verified')`,[credential,owner,financial,provider,secret,fingerprint]);
 await db.query(`INSERT INTO public.v13_production_account(id,owner_user_id,kalshi_connection_id,subaccount,
  exchange_index,key_fingerprint,cash_micros,reserved_micros,initial_cash_micros,revision,blocked_reason)
  VALUES($1,$2,$3,1,2,$4,25000000,0,25000000,0,NULL)`,[account,owner,financial,fingerprint]);
 await db.query(`INSERT INTO public.v13_live_money_policy(id,version,state,execution_account_id,created_by,
  champion_selection_review_id,champion_selection_evidence_hash,champion_selected_by,champion_selected_at,
  capital_limit_cents,max_entry_stake_cents,max_entry_all_in_cents,max_daily_loss_cents,max_total_loss_cents,
  max_quote_age_ms,max_fee_evidence_age_ms,fee_policy_version,fee_source_url,fee_formula_version,
  approved_by,approved_at,policy_hash)
  VALUES($1,1,'APPROVED',$2,$3,'offline-review',$4,$3,now(),2500,500,600,500,500,
   5000,5000,$5,$6,$7,$3,now(),$4)`,[policy,account,owner,hash,API_SOURCE_POLICY_VERSION,sourceUrl,API_SOURCE_FORMULA_VERSION]);
 await db.query(`UPDATE public.v13_production_account SET policy_id=$2,commissioning_digest=$3,
  minimum_exit_micros=400000,fee_artifact_digest=$4,reconciled_at=clock_timestamp(),commissioned=true,cash_precision_verified=true,kill_switch=false,execution_enabled=true WHERE id=$1`,[account,policy,hash,artifact]);

 const row=(await db.query('SELECT * FROM public.v13_live_money_policy WHERE id=$1',[policy])).rows[0];
 policyHash=computeV13LiveMoneyPolicyHash(decodePolicy(row));
 await db.query('UPDATE public.v13_live_money_policy SET policy_hash=$2 WHERE id=$1',[policy,policyHash]);
 await db.query(`INSERT INTO strata_configured_stake(id,execution_account_id,configured_stake_cents,revision,updated_at)
  VALUES($1,$1,200,1,clock_timestamp())`,[account]);
 await db.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'reviewer@example.invalid',clock_timestamp())",[reviewer]);
 await db.query('DELETE FROM private.role_assignments');
 await db.query("INSERT INTO private.role_assignments VALUES('reviewer@example.invalid','ADMIN')");
 const reviewed=new Date(Date.now()-30000),issued=new Date(Date.now()-20000),consented=new Date(Date.now()-10000);
 await db.query(`INSERT INTO private.strata_api_fee_rate_reviews(owner_user_id,reviewer_user_id,rate_decision_digest,
  fee_model_version,confirmation,review_note,verified_rate_source,signed_at,expires_at)
  VALUES($1,$2,$3,$4,'I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1',$5,'kalshi_official_fee_publication',$6,$7)`,
  [owner,reviewer,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION,
   'SYNTHETIC DISPOSABLE TEST ONLY. This is not a human approval or a production fee review. '.repeat(2),reviewed,new Date(Date.now()+3600000)]);
 await db.query(`INSERT INTO private.strata_api_fee_source_grants(grant_id,owner_user_id,issuer_admin_id,rate_decision_digest,
  fee_model_version,authorized_stages,confirmation,issued_at,expires_at)
  VALUES($1,$2,$3,$4,$5,ARRAY['STEP_9','STEP_11','ORDER_ENTRY'],'ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1',$6,$7)`,
  [grant,owner,reviewer,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION,issued,new Date(Date.now()+600000)]);
 await db.query(`INSERT INTO private.strata_api_fee_owner_consents(grant_id,owner_user_id,confirmation,confirmed_at)
  VALUES($1,$2,'CONFIRM_REVIEWED_API_FEE_SOURCE_V1',$3)`,[grant,owner,consented]);
 const qualification=randomUUID();
 await db.query(`INSERT INTO private.strata_protective_release_qualification(qualification_id,release_commit_sha,owner_user_id,execution_account_id,evidence_digest)
  VALUES($1,$2,$3,$4,$5)`,[qualification,sha,owner,account,hash]);
 await db.query(`INSERT INTO private.strata_owner_sha_approvals(owner_user_id,execution_account_id,release_commit_sha,qualification_id,qualification_digest)
  VALUES($1,$2,$3,$4,$5)`,[owner,account,sha,qualification,hash]);
 await db.query(`INSERT INTO private.strata_protective_exit_release(release_commit_sha,independent_reviewer_id,operator_approver_id,
  review_url,release_evidence_digest,expires_at) VALUES($1,$2,$3,'https://github.com/PatentFiles/Strata-Backend/pull/1',$4,clock_timestamp()+interval '1 hour')`,[sha,reviewer,owner,hash]);
 await db.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest)
  VALUES($1,$2,'OWNER_ACTIVATION_REQUEST','{}',$3)`,[randomUUID(),account,hash]);
 await db.query('INSERT INTO vault.decrypted_secrets(id,decrypted_secret) VALUES($1,$2)',[secret,JSON.stringify({api_key_id:material.keyId,private_key:material.privateKey})]);
 await db.query(`INSERT INTO public.forward_test_evaluations(id,evaluated_at,market_ticker,btc_price,target,signed_buffer,
  absolute_buffer,seconds_remaining,feed_freshness,previous_side,current_side,fresh_cross,crossing_consumed,signal,direction,
  qualifying_trigger,reason,position_was_open,strategy_parameter_set_id,strategy_parameter_hash,velocity,up_offer,down_offer,
  btc_provider_age_ms,btc_receive_age_ms,market_age_ms)
  VALUES('supervisor-source',clock_timestamp(),$1,101,100,1,1,100,'current','UP','UP',false,false,'PASS','UP',false,
   'synthetic external paper feed',false,$2,$3,1,.60,.41,0,0,0)`,[request.market,V13_CHAMPION_PARAMETER_SET.id,V13_CHAMPION_PARAMETER_HASH]);
}
async function acknowledgedEntry(db:pg.Pool=pool){
 // Input boundary only: an already acknowledged BUY from the same running
 // session. Every EXIT intent and reservation must be produced by production.
 const decision={},capability=digest({id:target,request,decision,policyHash,fee:hash});
 const at=Date.now()-1000;
 // The acknowledged boundary retains the real conservative fragmented-fill
 // exit-loss reserve, not the much smaller fee for one whole-contract fill.
 const perContractExit=maximumExitFeePerContractMicros(1,undefined,'no');
 assert(perContractExit!==null);
 const reservedExitFeeCents=Math.ceil(perContractExit*request.contracts!/10000);
 const exitReserve=Number(conservativeExitFeeMicros({contracts:request.contracts!,reservedExitFeeCents},String(request.contracts!*100)));
 assert.equal(exitReserve,3000000);
 assert(exitReserve+1280000<=6000000,'synthetic initial reservation covers entry and conservative exit');
 const c=await db.connect();
 try{
  await c.query('BEGIN');await c.query('SELECT id FROM public.v13_production_account WHERE id=$1 FOR UPDATE',[account]);
  await c.query(`INSERT INTO public.v13_production_intent(id,account_id,evaluation_id,crossing_key,kind,market,side,state,
   request,decision,policy_hash,fee_fingerprint,capability_digest,client_order_id,exchange_order_id,reserved_micros,exit_fee_micros,created_at,dispatch_at)
   VALUES($1,$2,'supervisor-source','synthetic-acknowledged-crossing','ENTRY',$3,'NO','UNKNOWN',$4,'{}',$5,$6,$7,$8,
    'entry-order',6000000,$10,$9,$9)`,[target,account,request.market,JSON.stringify(request),policyHash,hash,capability,request.clientOrderId,new Date(at),exitReserve]);
  await c.query('INSERT INTO public.v13_production_position(id,account_id,market,side) VALUES($1,$2,$3,\'NO\')',[target,account,request.market]);
  await c.query('UPDATE public.v13_production_account SET reserved_micros=6000000,revision=revision+1 WHERE id=$1',[account]);
  const payload={id:target,outcome:'GET_RECONCILIATION_REQUIRED'};
  await c.query("INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES($1,$2,'POST_ATTEMPT',$3,$4)",[randomUUID(),account,JSON.stringify(payload),digest(payload)]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 return at;
}
type Scenario='partial_then_flat'|'durable_no_send'|'ambiguous_post';
function externalFixture(scenario:Scenario){
 const started=Date.now(),market={ticker:request.market,event_ticker:request.market+'-EVENT',series_ticker:'KXBTC15M',exchange_index:2,
  status:'active',price_level_structure:'deci_cent',open_time:new Date(started-60000).toISOString(),
  close_time:new Date(started+600000).toISOString(),expiration_time:new Date(started+660000).toISOString(),
  expected_expiration_time:new Date(started+660000).toISOString(),latest_expiration_time:new Date(started+660000).toISOString()};
 let phase:'flat'|'armed'|'entry'='flat',cash=25000000,quantity=0,entryAt=0,failHistory=true;
 let unblock!:()=>void;const ready=new Promise<void>(r=>{unblock=r;});
 let balances=0,posts=0,metadataFailures=0,requests=0;
 const postClients=new Set<string>(),orders:Record<string,unknown>[]=[],fills:Record<string,unknown>[]=[];
 const paths:string[]=[];
 const entryOrder=()=>({order_id:'entry-order',client_order_id:request.clientOrderId,ticker:request.market,book_side:'ask',side:'no',action:'buy',
  subaccount_number:1,exchange_index:2,created_time:new Date(entryAt).toISOString(),status:'executed',yes_price_dollars:'0.5700',initial_count_fp:'3.00',fill_count_fp:'3.00',remaining_count_fp:'0.00'});
 const entryFill=()=>({trade_id:'entry-fill',order_id:'entry-order',ticker:request.market,count_fp:'3.00',yes_price_dollars:'0.5900',no_price_dollars:'0.4100',fee_cost:'0.0500',
  subaccount_number:1,exchange_index:2,created_time:new Date(entryAt+100).toISOString()});
 const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 const transport:typeof fetch=async(input,init)=>{
  const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  assert.equal(u.origin,'https://external-api.kalshi.com');
  const method=init?.method??'GET';const path=u.pathname;requests++;paths.push(method+' '+path);
  assert(paths.length<1000,'unexpected transport loop');
  if(method==='POST'){
   assert.equal(path,'/trade-api/v2/portfolio/events/orders');assert.equal(phase,'entry');
   const body=JSON.parse(String(init?.body));assert.equal(body.reduce_only,true);assert.equal(body.side,'bid');
   assert.equal(body.subaccount,1);assert.equal(body.exchange_index,2);assert.equal(body.ticker,request.market);
   assert(!postClients.has(body.client_order_id),'uncertain order replay');postClients.add(body.client_order_id);posts++;
   const h=new Headers(init?.headers),timestamp=h.get('KALSHI-ACCESS-TIMESTAMP')!;
   assert.equal(h.get('KALSHI-ACCESS-KEY'),material.keyId);
   assert(verify('sha256',Buffer.from(timestamp+'POST'+path),{key:createPublicKey(material.privateKey),padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(h.get('KALSHI-ACCESS-SIGNATURE')!,'base64')));
   const marker=(await db.query(`SELECT r.state,w.arm_requested,i.state AS intent_state FROM private.strata_emergency_exit_reservations r
    JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=r.execution_account_id
    JOIN public.v13_production_intent i ON i.client_order_id=r.client_order_id WHERE r.client_order_id=$1`,[body.client_order_id])).rows[0];
   assert.deepEqual(marker,{state:'UNKNOWN',arm_requested:false,intent_state:'DISPATCHED'});
   assert(scenario!=='durable_no_send','durable no-send must not transmit');
   if(scenario==='ambiguous_post')return response({message:'synthetic ambiguous response'},503);
   const count=Math.round(Number(body.count)*100);assert.equal(count,quantity);
   const filled=posts===1?100:quantity;assert(filled<=quantity);
   const at=Date.now(),id='exit-order-'+posts,fp=(filled/100).toFixed(2),remaining=((count-filled)/100).toFixed(2);
   quantity-=filled;cash+=filled*4000-10000;
   orders.push({order_id:id,client_order_id:body.client_order_id,ticker:request.market,book_side:'bid',side:'no',action:'sell',
    subaccount_number:1,exchange_index:2,created_time:new Date(at).toISOString(),status:filled===count?'executed':'canceled',yes_price_dollars:body.price,
    initial_count_fp:body.count,fill_count_fp:fp,remaining_count_fp:'0.00',reduce_only:true});
   fills.push({trade_id:'exit-fill-'+posts,order_id:id,ticker:request.market,count_fp:fp,yes_price_dollars:'0.6000',no_price_dollars:'0.4000',fee_cost:'0.0100',
    subaccount_number:1,exchange_index:2,created_time:new Date(at).toISOString()});
   return response({order_id:id,client_order_id:body.client_order_id,fill_count:fp,remaining_count:remaining,ts_ms:at},201);
  }
  assert.equal(method,'GET');
  if(path==='/trade-api/v2/portfolio/balance'){
   balances++;if(balances>=3&&phase==='armed')await ready;
   return response({balance_dollars:(cash/1000000).toFixed(4),subaccount:1,exchange_index:2});
  }
  if(path.includes('/historical/'))return response({orders:[],fills:[],cursor:''});
  if(path==='/trade-api/v2/portfolio/orders'){
   if(phase!=='entry')return response({orders:[],cursor:''});
   if(failHistory){failHistory=false;return response({orders:[{...entryOrder(),yes_price_dollars:'0.1234'}],cursor:''});}
   return response({orders:[entryOrder(),...orders],cursor:''});
  }
  if(path==='/trade-api/v2/portfolio/fills')return response({fills:phase==='entry'?[entryFill(),...fills]:[],cursor:''});
  if(path==='/trade-api/v2/portfolio/positions')return response({market_positions:phase==='entry'?[{ticker:request.market,position_fp:quantity?'-'+(quantity/100).toFixed(2):'0.00',subaccount_number:1,exchange_index:2}]:[],cursor:''});
  if(path==='/trade-api/v2/portfolio/settlements')return response({settlements:[],cursor:''});
  if(path.endsWith('/orderbook'))return response({orderbook_fp:{yes_dollars:[['0.5900','100.00']],no_dollars:[['0.4000','100.00']]}});
  if(path==='/trade-api/v2/markets')return response({markets:[market],cursor:''});
  if(path==='/trade-api/v2/markets/'+request.market){
   if(scenario==='durable_no_send'&&phase==='entry'){
    const unknown=(await db.query("SELECT count(*)::int AS n FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state='UNKNOWN'",[account])).rows[0].n;
    if(unknown){metadataFailures++;return response({message:'synthetic final public read outage'},503);}
   }
   return response({market});
  }
  if(path==='/trade-api/v2/series/KXBTC15M')return response({series:{ticker:'KXBTC15M',exchange_index:2,fee_type:'quadratic',fee_multiplier:'1'}});
  if(path==='/trade-api/v2/events/'+market.event_ticker)return response({event:{event_ticker:market.event_ticker,series_ticker:'KXBTC15M',exchange_index:2,fee_type_override:null,fee_multiplier_override:null}});
  if(path==='/trade-api/v2/series/fee_changes')return response({series_fee_change_arr:[],cursor:''});
  if(path==='/trade-api/v2/events/fee_changes')return response({event_fee_changes:[],cursor:''});
  throw Error('unexpected_external_path:'+path);
 };
 return {transport,arm(){phase='armed';},entry(at:number){entryAt=at;cash=23720000;quantity=300;phase='entry';unblock();},
  summary:()=>({balances,posts,quantity,metadataFailures,requests,paths:paths.slice(-20)})};
}
async function diagnostics(control:PersonalSessionControl,external:ReturnType<typeof externalFixture>){
 return {scheduled:control.isScheduled(owner,account),external:external.summary(),
  account:(await db.query('SELECT blocked_reason,revision,cash_micros FROM public.v13_production_account WHERE id=$1',[account])).rows,
  lease:(await db.query('SELECT state,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1',[account])).rows,
  intents:(await db.query('SELECT kind,state,terminal,filled_hundredths FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at',[account])).rows,
  markers:(await db.query('SELECT state FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1',[account])).rows};
}

export async function runHeldSupervisorDispatchScenario(scenario:'partial_then_flat'|'durable_no_send'|'ambiguous_post',restricted=false){
 // Each caller is a separate canonical-runner process with its own database.
 // Never restore real HTTP: a failed assertion may leave an in-flight task.

 let active:PersonalSessionControl|null=null,sourceTimer:ReturnType<typeof setInterval>|undefined;
 const setup=restricted?new pg.Pool({connectionString:url,max:2}):pool;
 try{
  const admin=await pool.connect();try{await installFullRecoverySchema(admin);}finally{admin.release();}
  // This test-only table is the external Vault read contract, not any trading
  // schema. It stores only this process's freshly generated ephemeral key.
  await pool.query(`CREATE TABLE vault.decrypted_secrets(id uuid PRIMARY KEY REFERENCES vault.secrets(id),decrypted_secret text NOT NULL);
   ALTER TABLE vault.decrypted_secrets OWNER TO ${backendRole}; REVOKE ALL ON vault.decrypted_secrets FROM PUBLIC`);
  if(!restricted){
  pool.on('connect',c=>{void c.query(`SET ROLE ${backendRole}`);});
  const existing=await pool.connect();try{await existing.query(`SET ROLE ${backendRole}`);}finally{existing.release();}
  assert.equal((await db.query('SELECT current_user AS name')).rows[0].name,backendRole);
  }
  // Exercise production checks, including real independent-release and owner
  // startup approval SQL. Do not use the NODE_ENV=test startup short circuit.
  process.env.NODE_ENV='production';process.env.RAILWAY_GIT_COMMIT_SHA=sha;
  // Generic demo configuration must not redirect this production-owned
  // supervisor's independent protective reads. All HTTP remains synthetic.
  process.env.KALSHI_API_ENVIRONMENT='demo';
  process.env.STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE='true';process.env.STRATA_UNKNOWN_ENTRY_PROTECTIVE_RECOVERY_ENABLED='true';
  {
   const external=externalFixture(scenario);globalThis.fetch=external.transport;
   const exact=await readExactEmergencyFeeEvidence(request.market);assert(exact.ok,JSON.stringify(exact));
   const probe=await probeCurrentKalshiFeeApi(globalThis.fetch,Date.now,request.market);
   const candidate=preparePdfFreeApiFeePolicyReview(probe);assert(candidate.ok,JSON.stringify(candidate));
   assert.notEqual(candidate.reviewCandidateDigest,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256);
   await reset(candidate.reviewCandidateDigest,setup);
   if(restricted){await installRestrictedProtectiveRuntime(setup);await assertRestrictedAuthority(setup,account);}
   const control=createProductionPersonalSession(db);active=control;
   external.arm();const started=await control.start({userId:owner,accountId:account,action:'START'});
   assert.equal(started.workerStarted,true,JSON.stringify(started));assert.equal(started.ok,true);
   const at=await acknowledgedEntry(setup);external.entry(at);
   let sourceFailure:unknown;
   sourceTimer=setInterval(()=>{void setup.query("UPDATE public.forward_test_evaluations SET evaluated_at=clock_timestamp() WHERE id='supervisor-source'").catch(e=>{sourceFailure=e;});},250);
   const detail=()=>diagnostics(control,external);
   const receiptCount=async()=>Number((await db.query("SELECT count(*)::int AS n FROM public.v13_production_observation WHERE account_id=$1 AND kind='HELD_RECONCILIATION_RECEIPT'",[account])).rows[0].n);
   const proveLaterCompletedTick=async()=>{
    const prior=await receiptCount();
    await until(async()=>await receiptCount()>prior,detail);
    // One tick can read balance for mandatory reconciliation and again for
    // its protective outcome. Three later reads therefore cross a completed
    // serialized tick boundary; an inserted no-send marker alone cannot pass.
    const balances=external.summary().balances;
    await until(async()=>external.summary().balances>=balances+3,detail);
    assert.equal(control.isScheduled(owner,account),true);
   };

   if(scenario==='partial_then_flat'){
    await until(async()=>external.summary().posts===2&&(await db.query('SELECT quantity_hundredths FROM public.v13_production_position WHERE id=$1',[target])).rows[0]?.quantity_hundredths==='0',detail);
    const exits=(await db.query("SELECT request,state,filled_hundredths FROM public.v13_production_intent WHERE account_id=$1 AND kind='EXIT' ORDER BY created_at,id",[account])).rows;
    assert.equal(exits.length,2);assert.deepEqual(exits.map(r=>r.filled_hundredths),['100','200']);assert(exits.every(r=>r.state==='TERMINAL'));
    assert.deepEqual(exits.map(r=>r.request.quantityHundredths),['300','200']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM private.strata_protective_exit_reconciliations WHERE execution_account_id=$1',[account])).rows[0].n,2);
    await until(async()=>(await db.query("SELECT count(*)::int AS n FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state='RECONCILED'",[account])).rows[0].n===2,detail);
    await proveLaterCompletedTick();
   }else if(scenario==='durable_no_send'){
    await until(async()=>(await db.query('SELECT count(*)::int AS n FROM private.strata_protective_exit_local_no_send WHERE execution_account_id=$1',[account])).rows[0].n===1,detail);
    assert.equal(external.summary().posts,0);assert(external.summary().metadataFailures>0);
    assert.equal((await db.query("SELECT state FROM public.v13_production_intent WHERE account_id=$1 AND kind='EXIT'",[account])).rows[0].state,'BLOCKED');
    assert.equal((await db.query('SELECT state FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1',[account])).rows[0].state,'VOID');
    await proveLaterCompletedTick();
    assert.equal(control.isScheduled(owner,account),true,'known no-send continues through a later completed held tick');
   }else{
    await until(async()=>external.summary().posts===1&&!control.isScheduled(owner,account),detail);
    assert.equal((await db.query('SELECT state FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1',[account])).rows[0].state,'UNKNOWN');
    const before=external.summary().requests;await pause(2700);
    assert.equal(external.summary().posts,1);assert.equal(external.summary().requests,before,'stopped scheduler must not poll or resend');
   }
   assert.equal(sourceFailure,undefined);
   if(restricted){
    // Stop scheduling. An already-running optional audit may still finish.
    const stopped=await control.stop({userId:owner,accountId:account,action:'KILL'});
    assert.equal(stopped.workerStopped,true);assert.equal(control.isScheduled(owner,account),false);
    assert.deepEqual((await db.query('SELECT state,account_kill,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1',[account])).rows[0],{state:'killed',account_kill:true,arm_requested:false});
    active=null;
    await assertRestrictedOutcome(setup,account);
   }
   const lease=(await db.query('SELECT arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1',[account])).rows[0];assert.equal(lease.arm_requested,false);
   assert.equal((await db.query("SELECT count(*)::int AS n FROM public.v13_production_intent WHERE account_id=$1 AND kind='ENTRY'",[account])).rows[0].n,1);
   assert((await db.query("SELECT count(*)::int AS n FROM public.v13_production_observation WHERE account_id=$1 AND kind='HELD_RECONCILIATION_RECEIPT'",[account])).rows[0].n>0);
  }
 }finally{
  if(sourceTimer)clearInterval(sourceTimer);
  try{if(active)await (active as PersonalSessionControl).stop({userId:owner,accountId:account,action:'KILL'});}
  finally{
   // No next scenario/reset exists in this process. Keep synthetic HTTP and
   // production-mode validation settings until process exit, including failures.
   try{await pool.end();}finally{if(restricted)await setup.end();}
  }
 }
}
