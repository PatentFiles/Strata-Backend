import {readFileSync} from 'node:fs';
import {V13_ENTRY_POLICY_VERSION} from '@workspace/v13-strategy';
import {economicSettlementFixture} from './ownerEconomicSettlementFixture';
import {proveEconomicSettlement,economicSettlementPlan} from './ownerEconomicSettlementProof';
import {commitEconomicSettlement} from './ownerEconomicSettlementCommit';
import {proveEconomicDischarge} from './economicExitDischargeEvidence';
import {commitEconomicDischarge} from './economicExitDischargeCommit';
import {pinOwnerProtectiveHistory} from "./ownerProtectiveHistoryPreviewPin";
import assert from 'node:assert/strict';
import {generateKeyPairSync,createPublicKey,verify,constants,randomUUID} from 'node:crypto';
import {pool,type Pool} from '@workspace/db';
import {installRestrictedProtectiveRuntime,assertRestrictedAuthority,assertRestrictedOutcome,restrictedRuntimeDiagnostics,beginRestrictedRuntimeDiagnostics} from './restrictedProtectiveRuntime.fixture';
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
import {installCombinedPlatformShape,installCombinedRestrictedRuntime,assertCombinedAuthority,seedCombinedStanding,combinedHumanSnapshot,observeCombinedStatements} from './restrictedCombinedRuntime.fixture';

// Full real supervisor/native-ledger integration. Only external Vault storage
// and HTTP responses are fixture data. No executor, policy, reserve, dispatcher,
// outcome, scheduler or authority validator is replaced. No EXIT row is seeded.
// All approval records are SYNTHETIC and exist only in the pinned disposable DB.
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url));
// Match the workspace DB package's installed native driver; the API does not
// directly depend on pg. No alternative driver or connection fallback.
const NativePool=pool.constructor as new(config:{connectionString:string;max:number})=>Pool;
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
async function reset(artifact:string,db:Pool=pool){
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
async function acknowledgedEntry(db:Pool=pool){
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
function externalFixture(scenario:Scenario,allowFlatRenewal=false,beforeFinalMetadata?:()=>Promise<void>){
 const started=Date.now(),market={ticker:request.market,event_ticker:request.market+'-EVENT',series_ticker:'KXBTC15M',exchange_index:2,
  status:'active',price_level_structure:'deci_cent',open_time:new Date(started-60000).toISOString(),
  close_time:new Date(started+600000).toISOString(),expiration_time:new Date(started+660000).toISOString(),
  expected_expiration_time:new Date(started+660000).toISOString(),latest_expiration_time:new Date(started+660000).toISOString()};
 let phase:'flat'|'armed'|'entry'='flat',cash=25000000,quantity=0,entryAt=0,failHistory=true;
 let unblock!:()=>void;const ready=new Promise<void>(r=>{unblock=r;});
 let holdFlat=false,flatHeld!:()=>void,revocationDone=false;const flatBarrier=new Promise<void>(r=>{flatHeld=r;});
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
   balances++;if(balances>=3&&phase==='armed'&&(!allowFlatRenewal||holdFlat)){flatHeld();await ready;}
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
   if(beforeFinalMetadata&&!revocationDone&&phase==='entry'){
    const unknown=(await db.query("SELECT count(*)::int AS n FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state='UNKNOWN'",[account])).rows[0].n;
    if(unknown){await beforeFinalMetadata();revocationDone=true;}
   }
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
 return {transport,holdFlatRead(){holdFlat=true;return flatBarrier;},arm(){phase='armed';},entry(at:number){entryAt=at;cash=23720000;quantity=300;phase='entry';unblock();},
  summary:()=>({balances,posts,quantity,metadataFailures,requests,revocationDone,paths:paths.slice(-20)})};
}
async function diagnostics(control:PersonalSessionControl,external:ReturnType<typeof externalFixture>){
 return {scheduled:control.isScheduled(owner,account),external:external.summary(),runtimeQueryFailures:restrictedRuntimeDiagnostics(),
  account:(await db.query('SELECT blocked_reason,revision,cash_micros FROM public.v13_production_account WHERE id=$1',[account])).rows,
  lease:(await db.query('SELECT state,arm_requested FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1',[account])).rows,
  intents:(await db.query('SELECT kind,state,terminal,filled_hundredths FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at',[account])).rows,
  markers:(await db.query('SELECT state FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1',[account])).rows};
}

export async function runHeldSupervisorDispatchScenario(scenario:'partial_then_flat'|'durable_no_send'|'ambiguous_post',restricted=false,combined?:'success'|'revocation'){
 assert(!combined||restricted,'combined capability mode always uses a genuine restricted login');
 // Each caller is a separate canonical-runner process with its own database.
 // Never restore real HTTP: a failed assertion may leave an in-flight task.

 let active:PersonalSessionControl|null=null,sourceTimer:ReturnType<typeof setInterval>|undefined;
 const setup=restricted?new NativePool({connectionString:url!,max:2}):pool;
 const seen=new Set<string>();
 let standing:Awaited<ReturnType<typeof seedCombinedStanding>>|undefined,humanBefore:Record<string,unknown>|undefined;
 let heldTechnical:unknown,financialBeforeRevocation:unknown;
 const technical=async()=>({lease:(await setup.query('SELECT * FROM private.strata_continuous_execution_technical_lease ORDER BY grant_id')).rows,
  audit:(await setup.query('SELECT * FROM private.strata_continuous_execution_audit ORDER BY audit_id')).rows});
 const financial=async()=>({account:(await setup.query('SELECT cash_micros,reserved_micros FROM public.v13_production_account WHERE id=$1',[account])).rows,
  positions:(await setup.query('SELECT quantity_hundredths,basis_micros,realized_pnl_micros FROM public.v13_production_position WHERE account_id=$1 ORDER BY id',[account])).rows});
 try{
  const admin=await pool.connect();try{await installFullRecoverySchema(admin);}finally{admin.release();}
  // This test-only table is the external Vault read contract, not any trading
  // schema. It stores only this process's freshly generated ephemeral key.
  await pool.query(`CREATE TABLE vault.decrypted_secrets(id uuid PRIMARY KEY REFERENCES vault.secrets(id),decrypted_secret text NOT NULL);
   ALTER TABLE vault.decrypted_secrets OWNER TO ${backendRole}; REVOKE ALL ON vault.decrypted_secrets FROM PUBLIC`);
  if(combined)await installCombinedPlatformShape(setup);
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
   const external=externalFixture(scenario,Boolean(combined),combined==='revocation'?async()=>{
    assert(standing);assert(seen.has('successor'),'preliminary native successor read must have succeeded');
    assert(!seen.has('successor_refused'));financialBeforeRevocation=await financial();
    const result=await setup.query("UPDATE private.strata_standing_execution_reviews SET revoked_at=clock_timestamp(),revocation_reason='synthetic final-fence revocation' WHERE release_id=$1 RETURNING release_id",[standing.review]);
    assert.equal(result.rows.length,1);
   }:undefined);globalThis.fetch=external.transport;
   const exact=await readExactEmergencyFeeEvidence(request.market);assert(exact.ok,JSON.stringify(exact));
   const probe=await probeCurrentKalshiFeeApi(globalThis.fetch,Date.now,request.market);
   const candidate=preparePdfFreeApiFeePolicyReview(probe);assert(candidate.ok,JSON.stringify(candidate));
   assert.notEqual(candidate.reviewCandidateDigest,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256);
   await reset(candidate.reviewCandidateDigest,setup);
   if(combined){
    standing=await seedCombinedStanding(setup,{owner,reviewer,grant,account,policyHash,sha});
    await installCombinedRestrictedRuntime(setup,client=>observeCombinedStatements(client,seen));
    await assertCombinedAuthority(setup);
   }
   if(restricted){if(!combined)await installRestrictedProtectiveRuntime(setup);await assertRestrictedAuthority(setup,account,owner);}
   if(combined)humanBefore=await combinedHumanSnapshot(setup);
   if(restricted)beginRestrictedRuntimeDiagnostics();
   const control=createProductionPersonalSession(db);active=control;
   external.arm();const started=await control.start({userId:owner,accountId:account,action:'START'});
   assert.equal(started.workerStarted,true,JSON.stringify({started,external:external.summary(),runtimeQueryFailures:restrictedRuntimeDiagnostics()}));assert.equal(started.ok,true);
   if(combined){
    await until(async()=>seen.has('technical_renewal')&&Number((await technical()).lease[0]?.generation)===2,()=>diagnostics(control,external));
    assert(seen.has('fee_renewal'),'expired bootstrap grant must use actual standing fee renewal');
    const renewed=await technical();assert.equal(renewed.audit.length,1);assert.equal(renewed.audit[0].kind,'LEASE_RENEWED');
    assert.equal(new Date(renewed.lease[0].expires_at).getTime()-new Date(renewed.lease[0].observed_at).getTime(),300000);
    assert.equal((await setup.query('SELECT lease_expires_at>clock_timestamp() AS current FROM private.strata_api_fee_standing_delegations WHERE delegation_id=$1',[standing!.delegation])).rows[0].current,true);
    // Block the next serialized flat read before seeding the already-acknowledged
    // entry. This keeps the initial renewal outside held mode, as production requires.
    await Promise.race([external.holdFlatRead(),pause(10000).then(()=>{throw Error('combined_flat_read_barrier_timeout');})]);
    heldTechnical=await technical();
   }
   const at=await acknowledgedEntry(setup);external.entry(at);
   let sourceFailure:unknown;
   sourceTimer=setInterval(()=>{void setup.query("UPDATE public.forward_test_evaluations SET evaluated_at=clock_timestamp() WHERE id='supervisor-source'").catch((e:unknown)=>{sourceFailure=e;});},250);
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

   if(combined==='revocation'){
    await until(async()=>external.summary().revocationDone&&!control.isScheduled(owner,account),detail);
    assert(seen.has('successor_refused'),'native final successor query must refuse revoked technical review');
    assert.equal(external.summary().posts,0);
    assert.equal((await db.query('SELECT state FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1',[account])).rows[0].state,'UNKNOWN');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM private.strata_protective_exit_reconciliations WHERE execution_account_id=$1',[account])).rows[0].n,0);
    assert.deepEqual(await financial(),financialBeforeRevocation);
    const before=external.summary().requests;await pause(2700);
    assert.equal(external.summary().requests,before);assert.equal(external.summary().posts,0);
   }else if(scenario==='partial_then_flat'){
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
    const proofConn=await setup.connect();
    try{
     await proofConn.query('BEGIN');
     await proofConn.query("UPDATE private.kalshi_account_worker_lease SET state='owned',account_kill=false,arm_requested=false WHERE execution_account_id=$1",[account]);
     const i=(await proofConn.query("SELECT state,terminal,dispatch_at,exchange_order_id FROM public.v13_production_intent WHERE account_id=$1 AND kind='EXIT'",[account])).rows[0];
     assert.equal(i.state,'DISPATCHED');assert.equal(i.terminal,false);assert.ok(i.dispatch_at);assert.equal(i.exchange_order_id,null);
     assert.ok(await pinOwnerProtectiveHistory(proofConn,owner,sha),"matched owned, disarmed retained fence should pin");
     assert.equal(await pinOwnerProtectiveHistory(proofConn,reviewer,sha),null,"foreign owner must not pin");
     await proofConn.query("UPDATE private.kalshi_account_worker_lease SET arm_requested=true WHERE execution_account_id=$1",[account]);
     assert.equal(await pinOwnerProtectiveHistory(proofConn,owner,sha),null,"armed owner must not pin");
     await proofConn.query("UPDATE private.kalshi_account_worker_lease SET arm_requested=false,fencing_token=fencing_token+1 WHERE execution_account_id=$1",[account]);
     assert.equal(await pinOwnerProtectiveHistory(proofConn,owner,sha),null,"different lease token must not pin");
     console.log("PIN_INCIDENT_POSITIVE_ARMED_FOREIGN_STALE_FENCE_PASS");
    }finally{await proofConn.query('ROLLBACK');proofConn.release();}

   }
   assert.equal(sourceFailure,undefined);
   if(combined){
    assert(seen.has('successor'),'held EXIT must actually execute native standing successor SQL');
    assert.deepEqual(await technical(),heldTechnical,'held mode must not renew continuous entry technical evidence');
    const after=await combinedHumanSnapshot(setup);
    if(combined==='revocation'){
     const before=humanBefore!['private.strata_standing_execution_reviews'] as {row:Record<string,unknown>}[];
     const revoked=after['private.strata_standing_execution_reviews'] as {row:Record<string,unknown>}[];
     assert.equal(before.length,1);assert.equal(revoked.length,1);assert(revoked[0]!.row.revoked_at);
     assert.equal(revoked[0]!.row.revocation_reason,'synthetic final-fence revocation');
     const {revoked_at:_at,revocation_reason:_reason,...original}=before[0]!.row;
     const {revoked_at:_afterAt,revocation_reason:_afterReason,...actual}=revoked[0]!.row;
     assert.deepEqual(actual,original);
     after['private.strata_standing_execution_reviews']=before;
    }
    assert.deepEqual(after,humanBefore,'worker never changes human authority bytes');
   }
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

export async function runEconomicDischargeFullCycle(priceRetry=false){
 const setup=new NativePool({connectionString:url!,max:2});
 const controls:PersonalSessionControl[]=[];let control:PersonalSessionControl|undefined;
 const at=Date.now();let btc=99990,cash=0,qty=0,reads=0;
 let priceRefusal=priceRetry,entryBookReads=0;
 const ticker=request.market, orders:Record<string,unknown>[]=[],fills:Record<string,unknown>[]=[];
 const submitted:Array<{id:string;reduce:boolean;count:number}>=[],httpErrors:string[]=[];
 const open=new Date(at-90000).toISOString(),close=new Date(at+810000).toISOString();
 const market={ticker,event_ticker:ticker+'-EVENT',series_ticker:'KXBTC15M',exchange_index:2,
  status:'active',floor_strike:100000,price_level_structure:'deci_cent',open_time:open,close_time:close,
  expiration_time:close,expected_expiration_time:close,latest_expiration_time:close,
  yes_bid_dollars:'0.5000',yes_ask_dollars:'0.5000',no_bid_dollars:'0.5000',no_ask_dollars:'0.5000'};
 const held=economicSettlementFixture(at);
 // Keep the new live market distinct from the historical already-settled market.
 const successor='KXBTC15M-REHEARSAL-SUCCESSOR';market.ticker=successor;market.event_ticker=successor+'-EVENT';
 const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,init)=>{
  const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  const path=u.pathname,method=init?.method??'GET';
  if(u.origin==='https://api.exchange.coinbase.com'&&method==='GET'){
   reads++;return respond({price:String(btc),time:new Date().toISOString()});
  }
  try{
   assert.equal(u.origin,'https://external-api.kalshi.com');
   if(method==='POST'){
    assert.equal(path,'/trade-api/v2/portfolio/events/orders');
    const h=new Headers(init?.headers),ts=h.get('KALSHI-ACCESS-TIMESTAMP')!;
    assert.equal(h.get('KALSHI-ACCESS-KEY'),material.keyId);
    assert(verify('sha256',Buffer.from(ts+'POST'+path),{key:createPublicKey(material.privateKey),padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(h.get('KALSHI-ACCESS-SIGNATURE')!,'base64')));
    const b=JSON.parse(String(init?.body)),count=Math.round(Number(b.count)*100),id='venue-'+(submitted.length+1);
    assert.equal(b.ticker,successor);assert.equal(b.subaccount,1);assert.equal(b.exchange_index,2);
    assert.equal(b.time_in_force,'immediate_or_cancel');assert(!submitted.some(x=>x.id===b.client_order_id));
    assert(Number.isSafeInteger(count)&&count>0);assert.equal(b.reduce_only,submitted.length===1);
    const reducing=b.reduce_only===true,orderTime=new Date().toISOString();
    assert.equal(b.side,reducing?'ask':'bid');if(reducing)assert.equal(count,qty);
    const cents=Math.round(Number(b.price)*100),gross=count*cents*100,fee=10000;
    qty+=reducing?-count:count;cash+=reducing?gross-fee:-gross-fee;
    submitted.push({id:b.client_order_id,reduce:reducing,count});
    orders.push({order_id:id,client_order_id:b.client_order_id,ticker:successor,book_side:b.side,
     subaccount_number:1,exchange_index:2,created_time:orderTime,status:'executed',yes_price_dollars:b.price,
     initial_count_fp:b.count,fill_count_fp:b.count,remaining_count_fp:'0.00',reduce_only:reducing});
    fills.push({trade_id:'fill-'+id,order_id:id,ticker:successor,count_fp:b.count,
     yes_price_dollars:b.price,no_price_dollars:(1-Number(b.price)).toFixed(4),fee_cost:'0.0100',
     subaccount_number:1,exchange_index:2,created_time:orderTime});
    return respond({order_id:id,client_order_id:b.client_order_id,fill_count:b.count,remaining_count:'0.00',ts_ms:Date.now()},201);
   }
   assert.equal(method,'GET');
   const o=held.snapshot.orders[0]!,f=held.snapshot.fills[0]!;
   if(path==='/trade-api/v2/portfolio/balance')return respond({balance_dollars:(cash/1000000).toFixed(6),subaccount:1,exchange_index:2});
   if(path.includes('/historical/'))return respond({orders:[],fills:[],cursor:''});
   if(path==='/trade-api/v2/portfolio/orders')return respond({orders:[{
    client_order_id:o.request.clientOrderId,ticker:o.request.market,order_id:o.orderId,status:'executed',
    book_side:'ask',yes_price_dollars:'0.49',initial_count_fp:'3.00',fill_count_fp:'3.00',
    created_time:new Date(f.occurredAtMs-5000).toISOString(),subaccount_number:1,exchange_index:2},...orders],cursor:''});
   if(path==='/trade-api/v2/portfolio/fills')return respond({fills:[{
    trade_id:f.id,order_id:f.orderId,ticker:f.market,count_fp:'3.00',yes_price_dollars:'0.51',no_price_dollars:'0.49',
    fee_cost:'0.052500',created_time:new Date(f.occurredAtMs).toISOString(),subaccount_number:1,exchange_index:2},...fills],cursor:''});
   if(path==='/trade-api/v2/portfolio/positions')return respond({market_positions:submitted.length?[{ticker:successor,
    position_fp:(qty/100).toFixed(2),subaccount_number:1,exchange_index:2}]:[],cursor:''});
   if(path==='/trade-api/v2/portfolio/settlements')return respond({settlements:[held.rawSettlement],cursor:''});
   if(path.endsWith('/orderbook')){entryBookReads++;const noBid=priceRefusal&&entryBookReads>1?'0.4800':'0.5000';const resp=respond({orderbook_fp:{yes_dollars:[['0.5000','100.00']],no_dollars:[[noBid,'100.00']]}});Object.defineProperty(resp,'url',{value:u.href});return resp;}
   if(path==='/trade-api/v2/markets')return respond({markets:[market],cursor:''});
   if(path==='/trade-api/v2/markets/'+successor)return respond({market});
   if(path==='/trade-api/v2/series/KXBTC15M')return respond({series:{ticker:'KXBTC15M',exchange_index:2,fee_type:'quadratic',fee_multiplier:'1'}});
   if(path==='/trade-api/v2/events/'+market.event_ticker)return respond({event:{event_ticker:market.event_ticker,series_ticker:'KXBTC15M',exchange_index:2,fee_type_override:null,fee_multiplier_override:null}});
   if(path==='/trade-api/v2/series/fee_changes')return respond({series_fee_change_arr:[],cursor:''});
   if(path==='/trade-api/v2/events/fee_changes')return respond({event_fee_changes:[],cursor:''});
   throw Error('unrecognized synthetic request '+path);
  }catch(e){httpErrors.push(String(e));throw e;}
 };
 try{
  const admin=await setup.connect();try{await installFullRecoverySchema(admin);}finally{admin.release();}
  await setup.query("CREATE TABLE vault.decrypted_secrets(id uuid PRIMARY KEY REFERENCES vault.secrets(id),decrypted_secret text NOT NULL)");
  await installCombinedPlatformShape(setup);
  for(const migration of ['20261125205247_owner_arm_preparation','20261126004500_economic_settlement_receipt','20261126113609_economic_exit_obligation_discharge'])
   await setup.query(readFileSync('../../supabase/migrations/'+migration+'.sql','utf8'));
  if(priceRetry)await setup.query(readFileSync('../../supabase/migrations/20261127021634_direct_price_refusal_retry.sql','utf8'));
  Object.assign(process.env,{NODE_ENV:'production',RAILWAY_GIT_COMMIT_SHA:sha,
   ...(priceRetry?{STRATA_DIRECT_PRICE_RETRY_V1_SHA:sha}:{}),
   STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE:'true',STRATA_ECONOMIC_EXIT_FINALITY_ENABLED:'true',
   STRATA_INDEPENDENT_LIVE_SOURCE_V1:'true',
   STRATA_INDEPENDENT_LIVE_SOURCE_V1_SCOPES:JSON.stringify([{ownerId:owner,accountId:account,releaseSha:sha}])});
  const probe=await probeCurrentKalshiFeeApi(globalThis.fetch,Date.now,successor);
  const fee=preparePdfFreeApiFeePolicyReview(probe);assert(fee.ok,JSON.stringify(fee));
  await reset(fee.reviewCandidateDigest,setup);
  await setup.query("UPDATE public.strata_configured_stake SET configured_stake_cents=500,risk_capital_cents=2500 WHERE execution_account_id=$1",[account]);
  await setup.query("UPDATE public.v13_live_money_policy SET entry_policy_version=$2 WHERE id=$1",[policy,V13_ENTRY_POLICY_VERSION]);
  policyHash=computeV13LiveMoneyPolicyHash(decodePolicy((await setup.query("SELECT * FROM public.v13_live_money_policy WHERE id=$1",[policy])).rows[0]));
  await setup.query("UPDATE public.v13_live_money_policy SET policy_hash=$2 WHERE id=$1",[policy,policyHash]);
  await seedCombinedStanding(setup,{owner,reviewer,grant,account,policyHash,sha});
  const retired=await recordEconomicRehearsalReceipt(setup,held);
  cash=Number(held.snapshot.cashMicros);
  control=createProductionPersonalSession(db);controls.push(control);
  const started=await control.start({userId:owner,accountId:account,action:'START'});
  assert.equal(started.workerStarted,true,JSON.stringify({started,httpErrors}));
  const describe=async()=>({submitted,httpErrors,cash,qty,reads,
   account:(await setup.query("SELECT blocked_reason,cash_micros,reserved_micros FROM public.v13_production_account WHERE id=$1",[account])).rows,
   decisions:(await setup.query("SELECT stage,outcome,reason_code FROM private.strata_live_decision_log_v1 WHERE execution_account_id=$1 ORDER BY observed_at DESC LIMIT 8",[account])).rows,
   intents:(await setup.query('SELECT state,kind FROM public.v13_production_intent WHERE account_id=$1',[account])).rows});
  await until(async()=>reads>=1,describe);await pause(250);entryBookReads=0;btc=100020;
  if(priceRetry){
   await until(async()=>(await setup.query('SELECT count(*)::int n FROM private.strata_direct_price_refusal WHERE account_id=$1',[account])).rows[0].n===1,describe);
   assert.equal(submitted.length,0,'rejected price must create no order');
   assert.equal((await setup.query('SELECT count(*)::int n FROM public.v13_production_intent WHERE account_id=$1 AND market=$2',[account,successor])).rows[0].n,0);
   assert.equal((await setup.query('SELECT reserved_micros FROM public.v13_production_account WHERE id=$1',[account])).rows[0].reserved_micros,'0');
   const receipt=(await setup.query('SELECT * FROM private.strata_direct_price_refusal WHERE account_id=$1',[account])).rows[0];
   assert.equal(receipt.reference_micros,'500000');assert.equal(receipt.best_ask_micros,'520000');
   await assert.rejects(setup.query('UPDATE private.strata_direct_price_refusal SET reason=reason WHERE source_id=$1',[receipt.source_id]),/direct_price_refusal_immutable/);
   await assert.rejects(setup.query('DELETE FROM private.strata_direct_price_refusal WHERE source_id=$1',[receipt.source_id]),/direct_price_refusal_immutable/);
   priceRefusal=false;btc=99990;const before=reads;await until(async()=>reads>=before+2,describe);btc=100020;
  }
  await until(async()=>submitted.length===1&&Number((await setup.query("SELECT coalesce(sum(quantity_hundredths),0) AS qty FROM public.v13_production_position WHERE account_id=$1",[account])).rows[0].qty)>0,describe);
  if(priceRetry){
   const sources=(await setup.query('SELECT id,evidence_bytes::jsonb AS evidence FROM public.strata_direct_entry_source WHERE account_id=$1 AND market_ticker=$2 ORDER BY observed_at',[account,successor])).rows;
   assert.equal(sources.length,2);assert.equal(sources[1].evidence.source.price_retry_of,sources[0].id);
   assert.equal((await setup.query('SELECT count(*)::int n FROM public.v13_production_intent WHERE account_id=$1 AND market=$2 AND kind='ENTRY'',[account,successor])).rows[0].n,1);
  }
  btc=99980;
  await until(async()=>submitted.length===2&&Number((await setup.query("SELECT coalesce(sum(quantity_hundredths),0) AS qty FROM public.v13_production_position WHERE account_id=$1",[account])).rows[0].qty)===0,describe);
  assert.deepEqual(submitted.map(x=>x.reduce),[false,true]);assert.equal(submitted[0]!.count,submitted[1]!.count);
  const stopped=await control.stop({userId:owner,accountId:account,action:'STOP'});assert.deepEqual(stopped,{workerStopped:true,managingExposure:false});
  control=createProductionPersonalSession(db);controls.push(control);
  const restarted=await control.start({userId:owner,accountId:account,action:'START'});
  assert.equal(restarted.workerStarted,true,JSON.stringify({restarted,httpErrors}));
  const observed=reads;await until(async()=>reads>observed,describe);
  assert.equal(submitted.length,2);assert.equal(httpErrors.length,0,JSON.stringify(httpErrors));
  const final=(await setup.query("SELECT cash_micros,reserved_micros,blocked_reason FROM public.v13_production_account WHERE id=$1",[account])).rows[0];
  assert.deepEqual(final,{cash_micros:String(cash),reserved_micros:'0',blocked_reason:null});
   assert.deepEqual((await setup.query("SELECT (SELECT count(*)::int FROM private.strata_economic_settlement_receipt) booked,(SELECT count(*)::int FROM private.strata_economic_exit_discharge) discharged,(SELECT count(*)::int FROM public.v13_production_event WHERE kind='SETTLEMENT') settlement_events")).rows[0],{booked:1,discharged:1,settlement_events:1});
  assert.deepEqual((await setup.query("SELECT i.state,m.state AS marker FROM public.v13_production_intent i JOIN private.strata_emergency_exit_reservations m USING(client_order_id) WHERE i.id=$1",[retired])).rows,[{state:'DISPATCHED',marker:'UNKNOWN'}]);
 }finally{
  try{for(const c of controls)await c.stop({userId:owner,accountId:account,action:'KILL'});}
  finally{try{await pool.end();}finally{await setup.end();}}
 }
}

async function recordEconomicRehearsalReceipt(setup:Pool,held:ReturnType<typeof economicSettlementFixture>){
 Object.assign(held.account,{id:account,owner_user_id:owner,key_fingerprint:fingerprint});
 held.snapshot.identity.keyFingerprint=fingerprint;
 for(const i of held.history.rows)i.account_id=account;
 for(const e of held.history.events)e.account_id=account;
 for(const p of held.history.positions)p.account_id=account;
 for(const m of held.history.markers){m.execution_account_id=account;m.owner_user_id=owner;}
 const proof=proveEconomicSettlement(held),plan=economicSettlementPlan(proof);
 await setup.query(`INSERT INTO private.kalshi_account_worker_lease(execution_account_id,owner_user_id,financial_account_id,
  provider_connection_id,vault_secret_id,holder_id,fencing_token,state,credential_fingerprint,arm_requested,account_kill,heartbeat_at,released_at)
  VALUES($1,$2,$3,$4,$5,'offline-worker',7,'released',$6,false,false,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour')`,
  [account,owner,financial,provider,secret,fingerprint]);
 await setup.query("UPDATE public.v13_production_account SET cash_micros=$2,reserved_micros=$3,initial_cash_micros=$4,revision=$5 WHERE id=$1",
  [account,held.account.cash_micros,held.account.reserved_micros,held.account.initial_cash_micros,held.account.revision]);
 for(const i of held.history.rows)await setup.query(`INSERT INTO public.v13_production_intent(id,account_id,evaluation_id,crossing_key,parent_id,kind,market,side,state,
  request,decision,policy_hash,fee_fingerprint,capability_digest,client_order_id,exchange_order_id,reserved_micros,exit_fee_micros,
  filled_hundredths,terminal,dispatch_at,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
  [i.id,account,i.kind==='ENTRY'?'supervisor-source':null,i.kind==='ENTRY'?'historic-crossing':null,i.parent_id,i.kind,i.market,i.side,i.state,
   JSON.stringify(i.request),JSON.stringify(i.decision),i.policy_hash,i.fee_fingerprint,i.capability_digest,i.client_order_id,i.exchange_order_id,
   i.reserved_micros,i.exit_fee_micros,i.filled_hundredths,i.terminal,i.dispatch_at,i.created_at]);
 const p=held.history.positions[0]!;
 await setup.query("INSERT INTO public.v13_production_position(id,account_id,market,side,quantity_hundredths,basis_micros,realized_pnl_micros) VALUES($1,$2,$3,$4,$5,$6,0)",[p.id,account,p.market,p.side,p.quantity_hundredths,p.basis_micros]);
 for(const e of held.history.events)await setup.query(`INSERT INTO public.v13_production_event(account_id,event_id,intent_id,kind,digest,payload,cash_delta_micros,pnl_micros,occurred_at)
  VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,[account,e.event_id,e.intent_id,e.kind,e.digest,JSON.stringify(e.payload),e.cash_delta_micros,e.pnl_micros,e.occurred_at]);
 const m=held.history.markers[0]!;
 await setup.query(`INSERT INTO private.strata_emergency_exit_reservations(reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,
  reducing_side,quantity_hundredths,order_digest,worker_fencing_token,worker_holder_id,order_request_json,initial_position_fp,position_observed_at_ms)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,7,'offline-worker',$9,'-3.00',$10)`,
  [m.reservation_id,owner,account,m.market_ticker,m.client_order_id,m.reducing_side,m.quantity_hundredths,m.order_digest,m.order_request_json,held.nowMs-14000]);
 await setup.query("UPDATE private.strata_emergency_exit_reservations SET state='UNKNOWN' WHERE reservation_id=$1",[m.reservation_id]);
 const scope={requestId:randomUUID(),ownerId:owner,scopeDigest:'b'.repeat(64),releaseSha:sha,controlEpoch:'0',workerFence:'7'};
 const deps={db:setup,now:()=>held.nowMs,verifyLocked:async()=>{}};
 const settle=await commitEconomicSettlement(proof,scope,deps);assert.equal(settle.ok,true,JSON.stringify(settle));
 const posted=(await setup.query("SELECT * FROM public.v13_production_account WHERE id=$1",[account])).rows[0];
 const events=(await setup.query("SELECT * FROM public.v13_production_event WHERE account_id=$1 ORDER BY event_id",[account])).rows;
 const positions=(await setup.query("SELECT * FROM public.v13_production_position WHERE account_id=$1",[account])).rows;
 const evidence={...held,account:{...posted,subaccount:Number(posted.subaccount),exchange_index:Number(posted.exchange_index)},history:{...held.history,events,positions}};
 const booking=(await setup.query("SELECT * FROM private.strata_economic_settlement_receipt WHERE request_id=$1",[scope.requestId])).rows[0];
  const market={ticker:plan.settlement.market,exchange_index:2,market_type:'binary',status:'finalized',result:plan.settlement.result.toLowerCase(),
    settlement_ts:held.rawSettlement.settled_time,close_time:new Date(plan.settlement.occurredAtMs-1000).toISOString(),settlement_value_dollars:plan.settlement.result==='YES'?'1.0000':'0.0000'};
  const dischargeProof=proveEconomicDischarge({...evidence,booking,market,transfers:{subaccount:[],crossExchange:[],complete:true}});
  const disposed=await commitEconomicDischarge(dischargeProof,{...scope,requestId:randomUUID()},deps);
  assert.equal(disposed.status,'RECORDED',JSON.stringify(disposed));
  assert.deepEqual((await setup.query("SELECT execution_enabled,kill_switch,reserved_micros FROM public.v13_production_account WHERE id=$1",[account])).rows[0],
    {execution_enabled:false,kill_switch:true,reserved_micros:'0'});
  // Fixture-only owner reauthorization. The production discharge never enables
  // trading; actual owner ARM/consent is separately exercised in native browser CI.
  // This disposable full-cycle tests the REAL recurring worker, entry, protective
  // sender, STOP and restart after explicit synthetic owner authorization.
  await setup.query("UPDATE public.v13_production_account SET execution_enabled=true,kill_switch=false WHERE id=$1",[account]);
 return plan.exitId;
}
