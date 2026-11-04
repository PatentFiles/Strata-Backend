import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const argument=name=>{const at=process.argv.indexOf(name);return at<0?undefined:process.argv[at+1];};
const base=path.resolve(argument('--source-root')??fileURLToPath(new URL('../../../',import.meta.url)));
const out=path.resolve(argument('--out-dir')??await mkdtemp(path.join(tmpdir(),'strata-protective-roundtrip-')));
await mkdir(out,{recursive:true});
const lib=base+'/artifacts/api-server/src/lib';
const strata=lib+'/strata';
const require=createRequire(base+'/artifacts/api-server/package.json');
const {build}=require('esbuild');
const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceInputs=new Map(),stubUses=[];
const forbidden=(name)=>`export async function ${name}(){throw Error('offline_forbidden_${name}');}`;
const stubs={
 '@workspace/db':`export const pool=globalThis.fixture.db; export const db=new Proxy({},{get(){throw Error('offline_orm_forbidden');}}); export const microLiveConfigTable={},microLiveFeeVerificationTable={};`,
 './userScopeDatabase':`export function createDatabaseUserScopePort(pool,options){globalThis.fixture.controls={pool,...options};return Object.freeze({offlineControls:true,session:options.session});}`,
 '../logger':`export const logger={info:(...v)=>globalThis.fixture.logs.push(v),warn:(...v)=>globalThis.fixture.logs.push(v),error:(...v)=>globalThis.fixture.logs.push(v)};`,
 '../kalshiAccountClient':`export class KalshiApiError extends Error{}; export function reviewedKalshiCents(){throw Error('offline_signed_conversion_forbidden');} export function readKalshiDedicatedPairEvidence(){throw Error('offline_provider_forbidden');} export const getScopedKalshiJson=(...args)=>globalThis.fixture.signedGet(...args);`,
 './protectiveExitStartupRelease':`export async function verifyProtectiveExitStartupRelease(){globalThis.fixture.startupReleaseCalls++;return {ok:true,reason:'offline_fixture_release'};}`,
 './continuousExecutionAuthorization':`export async function hasContinuousGrantHistory(){globalThis.fixture.standingHistoryCalls++;return false;} ${['checkContinuousBootstrap','checkContinuousEligibility','renewContinuousTechnicalLease'].map(forbidden).join('\n')}`,
 './apiFeeStandingDelegation':forbidden('renewStandingFeeObservationLease'),
 './ownerFeeSourceStage':`export function parseOwnerFeeSource(){return null;} ${forbidden('verifyOwnerFeeSourceStage')}`,
 './monetaryFeeContract':`export async function verifyMonetaryFeeContract(){globalThis.fixture.monetaryCalls++;return {ok:true,monetaryFeeAuthorized:true,sourceDigest:globalThis.fixture.digest,verifiedAt:new Date(globalThis.fixture.now).toISOString()};}`,
 'pdfjs-dist/legacy/build/pdf.mjs':`export function getDocument(){throw Error('offline_pdf_forbidden');}`,
};
stubs['./ownerFeeEmergencyExitRead']=`export async function inspectOwnedEmergencyExitRead(){return globalThis.fixture.inspect();}`;
const entry=`export {verifyReviewedProtectiveExitFee} from ${JSON.stringify(strata+'/reviewedProtectiveExitFee.ts')};
export {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH} from "@workspace/v13-strategy";
export {computeV13LiveMoneyPolicyHash} from ${JSON.stringify(lib+'/v13LiveMoneyRisk.ts')};
export * from ${JSON.stringify(strata+'/sharedPersonalTradingControls.ts')};
export {FinalPublicMetadataPhases} from ${JSON.stringify(strata+'/finalPublicMetadataPhases.ts')};
export {processCommittedPublicMetadata} from ${JSON.stringify(strata+'/committedPublicMetadata.ts')};
export {ProductionExecutor} from ${JSON.stringify(lib+'/v13-production/executor.ts')};
export {ProductionLedger} from ${JSON.stringify(lib+'/v13-production/ledger.ts')};
export {ProductionWorker} from ${JSON.stringify(lib+'/v13-production/worker.ts')};
export {AccountScopedExchange} from ${JSON.stringify(strata+'/accountProductionSession.ts')};
export {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from ${JSON.stringify(strata+'/apiFeeSourceStage.ts')};
export {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION} from ${JSON.stringify(strata+'/apiFeeRateReference.ts')};
export {dedicatedSignerFingerprint} from ${JSON.stringify(strata+'/commissioning.ts')};`;
const built=await build({stdin:{contents:entry,resolveDir:base,sourcefile:'offline-wiring-entry.ts',loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',metafile:true,logLevel:'warning',logLimit:0,conditions:['workspace'],plugins:[{name:'explicit-offline-boundaries',setup(b){
 b.onResolve({filter:/.*/},args=>{
  if(args.path==='@workspace/v13-strategy')return {path:base+'/lib/v13-strategy/src/index.ts'};
  if(stubs[args.path]){stubUses.push({importer:args.importer,path:args.path});return {path:args.path,namespace:'offline'};}
  if(args.path==='./accountProductionSession'&&args.importer===strata+'/personalExecutionSupervisor.ts')return {path:'session-wrapper',namespace:'offline'};
  if(args.path==='./personalExchangeRead'&&args.importer===strata+'/personalExecutionSupervisor.ts')return {path:'feeds-wrapper',namespace:'offline'};
 });
 b.onLoad({filter:/.*/,namespace:'offline'},args=>({loader:'js',resolveDir:base,contents:args.path==='session-wrapper'?`
  import * as real from ${JSON.stringify(strata+'/accountProductionSession.ts')};
  export function openOwnedExecutionSession(input){const bound=real.openOwnedExecutionSession(input);globalThis.fixture.bound=bound;globalThis.fixture.openInput=input;globalThis.fixture.boundByAccount.set(input.executionAccountId,bound);return bound;}
  export async function scheduleOwnedAccountWorker(bound,mode){
   globalThis.fixture.scheduleCalls.push(mode);
   const actual=bound.worker,stop=actual.stop.bind(actual);let scheduled=true;
   actual.isScheduled=()=>scheduled;
   actual.start=async()=>{throw Error('real_worker_start_forbidden');};actual.startRecovery=actual.start;actual.tick=actual.start;
   actual.stop=()=>{globalThis.fixture.workerStops++;scheduled=false;stop();};
   return {ok:true,reason:'offline_scheduler_only',workerStarted:true,executionActive:false};
  }`:args.path==='feeds-wrapper'?`
  export {PERSONAL_KALSHI_HOST,PERSONAL_MARKET_METADATA_HOST} from ${JSON.stringify(strata+'/personalExchangeRead.ts')};
  export async function readOwnedKalshiFeeds(){globalThis.fixture.startupFeedReads++;return {ok:true,cashMicros:'60000000000'};}
  export function emptySnapshot(identity,feeds){if(globalThis.fixture.snapshot)return globalThis.fixture.snapshot(identity);return {identity,observedAtMs:globalThis.fixture.now,cashMicros:feeds.cashMicros,authenticated:true,complete:true,cashExact:true,unexplainedCashActivity:false,orders:[],positions:[],fills:[],settlements:[]};}
  `:stubs[args.path]}));
 b.onLoad({filter:/\.[cm]?[jt]s$/,namespace:'file'},async args=>{if(args.path.startsWith(base+'/')){const bytes=await readFile(args.path);sourceInputs.set(args.path,sha(bytes));return {contents:bytes,loader:args.path.endsWith('.ts')?'ts':'js'};}});
}}]});
await writeFile(out+'/bundle.cjs',built.outputFiles[0].contents);
await writeFile(out+'/bundle-metafile.json',JSON.stringify(built.metafile,null,2)+'\n');
const owner='11111111-1111-4111-8111-111111111111',account='offline-account',grant='55555555-5555-4555-8555-555555555555';
const market='KXBTC15M-26NOV031700-00',event='KXBTC15M-26NOV031700';
const at=Date.parse('2026-11-03T16:55:00Z'),release='a'.repeat(40);
const finalFlag='STRATA_FINAL_PUBLIC_METADATA_PREFETCH_ENABLED',oldFlag='STRATA_PUBLIC_METADATA_PREFETCH_ENABLED';
const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
const keyId='offline-fixture-not-a-provider-key';
const fingerprint=sha(keyId+'\u001f'+privateKey.trim());
const iso=n=>new Date(n).toISOString();
function pages(){return {
 '/markets?series_ticker=KXBTC15M&status=open&limit=100':{markets:[{ticker:market,event_ticker:event,status:'active',close_time:iso(at+600000)}],cursor:''},
 ['/markets/'+market]:{market:{ticker:market,event_ticker:event,exchange_index:2,status:'active',open_time:iso(at-60000),close_time:iso(at+600000),expiration_time:iso(at+600000),expected_expiration_time:iso(at+600000),latest_expiration_time:iso(at+600000),price_level_structure:'deci_cent'}},
 ['/events/'+event]:{event:{event_ticker:event,series_ticker:'KXBTC15M',exchange_index:2,fee_type_override:null,fee_multiplier_override:null}},
 '/series/KXBTC15M':{series:{ticker:'KXBTC15M',exchange_index:2,fee_type:'quadratic',fee_multiplier:1}},
 '/series/fee_changes?series_ticker=KXBTC15M&show_historical=false':{series_fee_change_arr:[],cursor:''},
 ['/events/fee_changes?event_ticker='+event+'&limit=100']:{event_fee_changes:[],cursor:''},
};}
function fixture(value,{api=true,old='false'}={}){
 const f={now:at,digest:'d'.repeat(64),policy:'b'.repeat(64),logs:[],warnings:[],calls:[],sql:[],scheduleCalls:[],startupReleaseCalls:0,standingHistoryCalls:0,startupFeedReads:0,monetaryCalls:0,workerStops:0,books:0,orderTransportCalls:0,abortSignalDeadlines:[],timers:new Map(),publicPages:pages(),stopExposure:false,reviewMutator:r=>r};
 f.oldFlag=old;f.boundByAccount=new Map();f.accountRows=new Map();f.transportInFlight=0;f.maxTransportInFlight=0;
 f.source=api?'strata-api-reviewed://kxbtc15m/'+grant:'https://kalshi.com/docs/kalshi-fee-schedule.pdf';
 f.row={key_fingerprint:fingerprint,credential_fingerprint:fingerprint,cash_micros:'60000000000',reserved_micros:'0',reconciled_at:iso(at-1000),commissioned:true,execution_enabled:true,kill_switch:false,blocked_reason:null,fee_artifact_digest:f.digest,cash_precision_verified:true,subaccount:1,exchange_index:2,financial_account_id:'financial-offline',provider_connection_id:'provider-offline',vault_secret_id:'vault-offline',decrypted_secret:JSON.stringify({api_key_id:keyId,private_key:privateKey}),policy_hash:f.policy,fee_policy_version:'strata_api_fee_source_signed_review_v2',fee_source_url:f.source,fee_formula_version:'standard-quadratic-0.07-v1',policy_state:'APPROVED',configured_stake_cents:500};
 f.review=()=>f.reviewMutator({grant_id:grant,owner_user_id:owner,issuer_admin_id:'22222222-2222-4222-8222-222222222222',rate_decision_digest:f.exports.PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,fee_model_version:f.exports.PDF_FREE_RATE_REVIEW_VECTOR_VERSION,policy_version:'strata_api_fee_source_signed_review_v2',scope:'KXBTC15M:INDEX2',issued_at:iso(at-20000),expires_at:iso(at+60000),revoked_at:null,authorized_stages:['STEP_9','STEP_11','ORDER_ENTRY'],consent_owner:owner,confirmed_at:iso(at-15000),consent_revoked_at:null,first_review_id:'66666666-6666-4666-8666-666666666666',first_reviewer:'22222222-2222-4222-8222-222222222222',first_digest:f.exports.PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,first_model:f.exports.PDF_FREE_RATE_REVIEW_VECTOR_VERSION,first_scope:'KXBTC15M:INDEX2',first_signed:iso(at-30000),first_expires:iso(at+70000),first_revoked:null});
 f.accountRows.set(account,f.row);
 f.registerAccount=id=>{assert.ok(!f.accountRows.has(id));const row={...f.row,financial_account_id:'financial-'+id,provider_connection_id:'provider-'+id,vault_secret_id:'vault-'+id};f.accountRows.set(id,row);return row;};
 const ownedRow=(id,userId=owner)=>{assert.equal(userId,owner,'fixture owner must be explicit');assert.ok(f.accountRows.has(id),'unregistered fixture account '+id);return f.accountRows.get(id);};
 const query=async(sql,args=[])=>{
  f.sql.push({sql,args});
  if(f.queryHook){const answer=await f.queryHook(sql,args);if(answer!==undefined)return answer;}
  if(sql.includes('-- personal-session:signer'))return {rows:[ownedRow(args[1],args[0])]};
  if(sql.includes("FROM live_execution_config WHERE id = 'singleton'"))return {rows:[{live_execution_enabled:true,manual_kill_switch:false}]};
  if(sql==='SELECT request FROM v13_production_intent WHERE account_id = $1')return {rows:[]};
  if(sql.includes('-- api-fee:two-person-source-stage.'))return {rows:[f.review()]};
  if(sql.includes("to_regclass('private.kalshi_account_worker_lease')"))return {rows:[{name:'offline-test-port'}]};
  if(sql.includes('SELECT state, account_kill FROM private.kalshi_account_worker_lease'))return {rows:[{state:'released',account_kill:false}]};
  if(sql.includes('-- account-worker:arm')){ownedRow(args[0],args[1]);return {rows:[{id:args[0]}]};}
  if(sql.includes('-- account-worker:acquire')){ownedRow(args[0],args[7]);return {rows:[{fencing_token:'3'}]};}
  if(sql.includes('WITH unresolved_intents AS'))return {rows:[{n:'0'}]};
  if(sql.startsWith('BEGIN; SELECT * FROM v13_production_account'))return [{command:'BEGIN',rows:[]},{command:'SELECT',rows:[{id:account}]}];
  if(sql.includes('SELECT a.id')&&sql.includes('FOR SHARE OF a,p,live,c,lease'))return {rows:f.accountFenceClosed?[]:[{id:account}]};
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('SET '))return {rows:[]};
  if(sql.startsWith('SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE')){ownedRow(args[0],args[1]);return {rows:[{id:args[0]}]};}
  if(sql.includes('AS positions')&&sql.includes('AS unresolved'))return {rows:[{positions:f.stopExposure?1:0,orders:0,unresolved:0}]};
  if(sql.includes('-- account-worker:release')||sql.includes('-- account-worker:hold')||sql.includes('-- account-worker:kill'))return {rows:[{id:account}]};
  throw Error('unexpected_offline_sql:'+sql);
 };
 f.db={query,connect:async()=>{f.sql.push({offlineConnect:true});return {query,release(){f.sql.push({offlineRelease:true});}};}};
 f.signedGet=async(_material,p)=>{assert.equal(p,`/trade-api/v2/markets/${market}/orderbook`);f.books++;return {orderbook_fp:{yes_dollars:[['0.5000','100000']],no_dollars:[['0.5000','100000']]}};};
 f.fetch=async(input,init)=>{if(f.fetchHook){const answer=await f.fetchHook(input,init);if(answer!==undefined)return answer;}const url=String(input);if((init?.method??'GET')!=='GET'){f.orderTransportCalls++;throw Error('offline_order_transport_forbidden');}assert.ok(url.startsWith('https://external-api.kalshi.com/trade-api/v2/'));assert.equal(init?.redirect,'error');const p=url.replace('https://external-api.kalshi.com/trade-api/v2','');assert.ok(p in f.publicPages,'unexpected fixture public path '+p);const call={path:p,at:f.now,signal:init?.signal,index:f.calls.length};f.calls.push(call);f.transportInFlight++;f.maxTransportInFlight=Math.max(f.maxTransportInFlight,f.transportInFlight);try{if(f.pausePublic)await f.pausePublic;return f.respond?await f.respond(call):Response.json(f.publicPages[p]);}finally{f.transportInFlight--;}};
 class ClockDate extends Date{constructor(...a){super(...(a.length?a:[f.now]));}static now(){return f.now;}}
 const env=Object.freeze({[oldFlag]:old,...(value===undefined?{}:{[finalFlag]:value}),NODE_ENV:'production',RAILWAY_GIT_COMMIT_SHA:release,STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE:'true'});
 const OfflineAbortSignal={timeout(ms){const controller=new AbortController();f.abortSignalDeadlines.push({ms,controller});return controller.signal;},abort:AbortSignal.abort.bind(AbortSignal),any:AbortSignal.any.bind(AbortSignal)};
 const allowedModules=new Set(['node:crypto','node:async_hooks','node:buffer','node:path','node:util','node:events']);
 const context={fixture:f,module:{exports:{}},process:{env},console:{warn:(...x)=>f.warnings.push(x),info:(...x)=>f.logs.push(x),log:(...x)=>f.logs.push(x)},Date:ClockDate,performance:{now:()=>f.mono??0},fetch:f.fetch,Response,Request,Headers,URL,URLSearchParams,AbortController,AbortSignal:OfflineAbortSignal,ReadableStream,TextDecoder,TextEncoder,Buffer,queueMicrotask,structuredClone,
  setTimeout(fn,ms){const id={unref(){}};f.timers.set(id,{fn,ms});return id;},clearTimeout(id){f.timers.delete(id);},setInterval(){throw Error('real_timer_forbidden');},clearInterval(){throw Error('real_timer_forbidden');},
  require(name){if(name==='node:crypto'){const real=require(name);return {...real,createSign(...args){const signer=real.createSign(...args),sign=signer.sign.bind(signer);signer.sign=(...a)=>{const result=sign(...a);if(f.afterSign)f.afterSign();return result;};return signer;}};}if(name==='node:perf_hooks')return {performance:{now:()=>f.mono??0}};if(name==='node:fs/promises')return {readFile(){throw Error('runtime_filesystem_forbidden');}};if(!allowedModules.has(name))throw Error('runtime_import_forbidden:'+name);return require(name);}};
 context.exports=context.module.exports;runInNewContext(built.outputFiles[0].text,context,{timeout:3000});f.exports=context.module.exports;
 f.start=()=>f.exports.personalTradingSession.start({userId:owner,accountId:account,action:'START'});
 f.stop=(action='STOP')=>f.exports.personalTradingSession.stop({userId:owner,accountId:account,action});
 return f;
}

async function start(f){const r=await f.start();assert.equal(r.ok,true,JSON.stringify(r));assert.ok(f.bound.executor instanceof f.exports.ProductionExecutor);assert.ok(f.bound.executor.ledger instanceof f.exports.ProductionLedger);return f;}
// Stateful SQL/provider fixtures; no SQL execution or real network is claimed.
const parentId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function installExitFixture(f,spec){
 f.publicPages['/series/fee_changes?series_ticker=KXBTC15M&show_historical=false&limit=100']={series_fee_change_arr:[],cursor:''};
 f.publicPages['/events/fee_changes?event_ticker='+event+'&show_historical=false&limit=100']={event_fee_changes:[],cursor:''};
 f.mono=0;f.intents=[];f.reservations=[];f.audits=[];f.observations=[];f.posts=[];f.reconciliations=0;
 const p={id:'synthetic-policy',version:1,supersedesPolicyId:null,state:'APPROVED',strategyVersion:'V1.3',
 strategyParameterSetId:f.exports.V13_CHAMPION_PARAMETER_SET.id,strategyParameterHash:f.exports.V13_CHAMPION_PARAMETER_HASH,
 championSelectionReviewId:'synthetic-review',championSelectionEvidenceHash:'a'.repeat(64),championSelectedBy:owner,championSelectedAt:new Date(0),capitalLimitCents:6000000,maxEntryStakeCents:500,maxEntryAllInCents:625,maxOpenPositions:1,maxDailyLossCents:6000000,maxTotalLossCents:6000000,maxQuoteAgeMs:5000,maxFeeEvidenceAgeMs:15000,
 feePolicyVersion:f.row.fee_policy_version,feeSourceUrl:f.source,feeFormulaVersion:f.row.fee_formula_version,requireFullDepth:true,entryTimeInForce:'IOC',entryLimitSource:'SIGNAL_REFERENCE_OFFER',policyHash:null,createdBy:owner,approvedBy:owner,approvedAt:new Date(1)};
 p.policyHash=f.exports.computeV13LiveMoneyPolicyHash(p);f.policy=p.policyHash;
 const policyRow=Object.fromEntries(Object.entries(p).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),v]));
 Object.assign(f.row,{id:account,owner_user_id:owner,policy_id:p.id,policy_hash:p.policyHash,commissioning_digest:'c'.repeat(64),minimum_exit_micros:400000,reconciled_at:new Date(at),revision:'1',initial_cash_micros:'60000125000',reserved_micros:'1000000'});
 const parent={id:parentId,account_id:account,kind:'ENTRY',state:'TERMINAL',terminal:true,market,side:'YES',reserved_micros:'1000000',exit_fee_micros:'1000000',filled_hundredths:'25',exchange_order_id:'synthetic-entry',client_order_id:'v13p-'+parentId,created_at:new Date(at-10000)};
 f.position={id:parentId,account_id:account,market,side:'YES',quantity_hundredths:'25',basis_micros:'125000',realized_pnl_micros:'0'};f.intents.push(parent);
 f.source={id:'synthetic-paper-source',market_ticker:market,evaluated_at:new Date(at),evaluation_source:'paper',strategy_parameter_set_id:p.strategyParameterSetId,strategy_parameter_hash:p.strategyParameterHash,feed_freshness:'current',btc_price:99990,target:100000,signed_buffer:-10,velocity:-1,up_offer:.50,down_offer:.51,btc_provider_age_ms:0,btc_receive_age_ms:0,market_age_ms:0};
 f.inspect=()=>({diagnosticEligible:true,tradingAuthorized:false,verifiedPositionFp:'0.25',verifiedPositionObservedAtMs:f.now});
 f.snapshot=identity=>({identity,observedAtMs:f.now,cashMicros:f.row.cash_micros,authenticated:true,complete:!spec.badRecovery,cashExact:true,unexplainedCashActivity:false,historyFromMs:at-20000,orders:[],positions:[{market,side:'YES',quantityHundredths:'25'}],fills:[],settlements:[]});
 f.queryHook=async(sql,args)=>{
  const rows=(...rows)=>({rows});
  if(sql.includes('-- account-worker:heartbeat'))return rows({execution_account_id:account});
  if(sql.startsWith('SELECT arm_requested, account_kill, state'))return rows({arm_requested:true,account_kill:false,state:'owned'});
  if(sql.startsWith('BEGIN; SELECT * FROM v13_production_account'))return [{command:'BEGIN',rows:[]},{command:'SELECT',rows:[{...f.row}]}];
  if(sql.includes('AS standing_history'))return rows({standing_history:false});
  if(sql.includes('AS legacy_valid'))return rows({grant_id:grant,review_id:'synthetic-fee-review',consent_id:'synthetic-consent',policy_hash:p.policyHash,legacy_valid:true,valid_for_ms:60000});
  if(sql.startsWith('SELECT release_id FROM private.strata_standing_execution_reviews'))return spec.standing?rows({release_id:'standing'}):rows();
  if(sql.startsWith('SELECT r.release_id'))return spec.standing?rows({release_id:'standing'}):rows();
  if(sql.startsWith('SELECT * FROM v13_production_intent WHERE id='))return rows(parent);
  if(sql.includes('WITH uncertain AS MATERIALIZED'))return rows({has_uncertain_order:f.intents.some(i=>['DISPATCHED','UNKNOWN'].includes(i.state)),owner_user_id:owner});
  if(sql==='SELECT manual_kill_switch, live_execution_enabled FROM live_execution_config')return rows({manual_kill_switch:false,live_execution_enabled:true});
  if(sql.includes('SELECT p.policy_hash'))return rows({policy_hash:p.policyHash});
  if(sql.startsWith('SELECT p.* FROM v13_live_money_policy')||sql.startsWith('SELECT * FROM v13_live_money_policy'))return rows(policyRow);
  if(sql==="SELECT id FROM v13_live_money_policy WHERE state='APPROVED'")return rows({id:p.id});
  if(sql.startsWith('SELECT id FROM v13_production_intent WHERE parent_id'))return {rows:f.intents.filter(i=>i.parent_id===parentId&&!['TERMINAL','BLOCKED'].includes(i.state))};
  if(sql.startsWith('SELECT * FROM v13_production_position WHERE id='))return rows({...f.position});
  if(sql.includes('FROM forward_test_evaluations'))return rows({...f.source});
  if(sql.startsWith('INSERT INTO v13_production_intent')){
   const [id,account_id,parent_id,market,side,request,decision,policy_hash,fee_fingerprint,capability_digest,client_order_id]=args;
   f.intents.push({id,account_id,parent_id,kind:'EXIT',market,side,request:JSON.parse(request),decision:JSON.parse(decision),policy_hash,fee_fingerprint,capability_digest,client_order_id,state:'PREPARED',terminal:false,exchange_order_id:null,filled_hundredths:'0',reserved_micros:'0',created_at:new Date(f.now),dispatch_at:null});return rows();
  }
  if(sql.startsWith('UPDATE v13_production_account SET cash_micros=')){Object.assign(f.row,{cash_micros:args[1],reserved_micros:args[2],blocked_reason:args[3],revision:String(Number(f.row.revision)+1)});if(args[4])f.row.reconciled_at=args[4];return rows();}
  if(sql.startsWith('SELECT request FROM public.v13_production_intent')){f.now+=spec.sourceAge??0;f.mono+=spec.sourceAge??0;return rows({request:f.intents.find(i=>i.id===args[0]).request});}
  if(sql.startsWith('SELECT id FROM public.v13_production_account')||sql.startsWith('SELECT a.id FROM public.v13_production_account a '))return rows({id:account});
  if(sql.startsWith('INSERT INTO private.strata_emergency_exit_reservations')){
   const [reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,reducing_side,quantity_hundredths,order_digest,worker_fencing_token,worker_holder_id,initial_position_fp,position_observed_at_ms,order_request_json]=args;
   if(f.reservations.some(r=>r.client_order_id===client_order_id||['PREPARED','UNKNOWN'].includes(r.state)))return rows();
   f.reservations.push({reservation_id,owner_user_id,execution_account_id,market_ticker,client_order_id,reducing_side,quantity_hundredths,order_digest,worker_fencing_token,worker_holder_id,initial_position_fp,position_observed_at_ms,order_request_json,state:'PREPARED'});return rows({reservation_id});
  }
  const r=f.reservations.at(-1),intent=f.intents.at(-1);
  if(sql.startsWith('SELECT r.reservation_id')&&sql.includes('AS intent_id'))return r?.state==='UNKNOWN'&&intent.state==='DISPATCHED'?rows({reservation_id:r.reservation_id,intent_id:intent.id}):rows();
  if(sql.startsWith('SELECT r.reservation_id')&&sql.includes('AS reservation_age_ms')){
   assert.equal(intent.state,'DISPATCHED');assert.equal(r.state,'UNKNOWN');assert.equal(intent.request.clientOrderId,r.client_order_id);f.finalPending=true;
   return rows({reservation_id:r.reservation_id,reservation_age_ms:0,heartbeat_age_ms:0,owned_evaluation:intent.decision.ownedEvaluation,max_quote_age_ms:policyRow.max_quote_age_ms,source_age_ms:f.now-Date.parse(intent.decision.ownedEvaluation.source.evaluated_at),release_remaining_ms:spec.standing?null:(spec.releaseMs??60000)});
  }
  if(sql.startsWith('SELECT r.reservation_id'))return r?.state==='PREPARED'?rows({reservation_id:r.reservation_id}):rows();
  if(sql.startsWith("UPDATE private.strata_emergency_exit_reservations SET state='UNKNOWN'")){if(r.state!=='PREPARED')return rows();r.state='UNKNOWN';return rows({reservation_id:r.reservation_id,client_order_id:r.client_order_id});}
  if(sql.startsWith("UPDATE public.v13_production_intent SET state='DISPATCHED'")){intent.state='DISPATCHED';return rows({client_order_id:intent.client_order_id});}
  if(sql==='COMMIT'&&f.finalPending){f.finalPending=false;f.mono+=spec.commitDelay??0;f.now+=spec.commitDelay??0;return rows();}
  if(sql.startsWith('SELECT execution_account_id FROM private.kalshi_account_worker_lease'))return rows({execution_account_id:account});
  if(sql.startsWith('INSERT INTO private.strata_protective_exit_local_no_send')){f.audits.push(args);return rows({reservation_id:r.reservation_id});}
  if(sql.startsWith("UPDATE public.v13_production_intent SET state='BLOCKED'")){intent.state='BLOCKED';intent.terminal=true;return rows({id:intent.id});}
  if(sql.startsWith("UPDATE private.strata_emergency_exit_reservations SET state='VOID'")){r.state='VOID';return rows({reservation_id:r.reservation_id});}
  if(sql.startsWith('SELECT a.*,')&&sql.includes('reconciliation_history_floor')){f.reconciliations++;return rows({...f.row,reconciliation_history_floor:new Date(at-10000)});}
  if(sql.startsWith('SELECT * FROM v13_production_intent WHERE account_id='))return {rows:f.intents.map(i=>({...i}))};
  if(sql.startsWith('SELECT position.id,position.quantity_hundredths'))return rows({id:parentId,quantity_hundredths:'25'});
  if(sql.startsWith('SELECT market,side,quantity_hundredths FROM v13_production_position'))return rows({market,side:'YES',quantity_hundredths:'25'});
  if(sql.startsWith('SELECT e.cash,e.pnl,p.basis'))return rows({cash:'-125000',pnl:'0',basis:'125000',position_pnl:'0',amount:f.row.reserved_micros});
  if(sql.startsWith('INSERT INTO v13_production_observation')){f.observations.push({kind:args[2],payload:JSON.parse(args[3])});return rows();}
  return undefined;
 };
 f.afterSign=()=>{f.mono+=spec.signDelay??0;f.now+=spec.signDelay??0;};
 f.fetchHook=async(input,init)=>{if(init?.method==='POST'){assert.match(String(input),/\/portfolio\/events\/orders$/);const body=JSON.parse(init.body);assert.equal(body.reduce_only,true);f.posts.push(body);throw Error('synthetic_uncertain_transport');}};
 return f;
}
for(const spec of [
 {name:'source-4999',sourceAge:4999,posts:1},
 {name:'source-5000-inclusive',sourceAge:5000,posts:1},
 {name:'source-5001',sourceAge:5001,posts:0,blocked:true},
 {name:'source-6001',sourceAge:6001,posts:0,blocked:true},
 {name:'source-expires-signing',sourceAge:4500,signDelay:501,posts:0,blocked:true},
 {name:'finite-review-expires-signing',releaseMs:100,signDelay:184,posts:0,blocked:true},
 {name:'finite-review-expires-commit',releaseMs:100,commitDelay:100,posts:0,blocked:true},
 {name:'standing-has-no-ttl',standing:true,signDelay:501,posts:1},
 {name:'blocked-recovery-read-fails',sourceAge:4500,signDelay:501,posts:0,blocked:true,badRecovery:true},
 {name:'already-expired-recovery-read-fails',sourceAge:6001,posts:0,blocked:true,badRecovery:true},
])await test('actual producer → supervisor → signed dispatcher: '+spec.name,async()=>{
 const f=installExitFixture(await start(fixture('false')),spec);
 const selection={positionId:parentId,market,side:'YES',quantityHundredths:'25',minimumExitMicros:400000};
 const proof=await f.exports.verifyReviewedProtectiveExitFee(owner,account,market);assert.equal(proof.ok,true,JSON.stringify(proof));
 let error;try{await f.openInput.dispatchProtectiveExit(selection);}catch(e){error=e;}
 assert.equal(f.intents.length,2,String(error));assert.equal(f.reservations.length,1,String(error));
 assert.ok(f.sql.some(q=>q.sql?.includes('AS reservation_age_ms')),String(error));
 const intent=f.intents[1],reservation=f.reservations[0];
 assert.equal(intent.decision.ownedEvaluation.sourcePaperEvaluationId,f.source.id);assert.equal(intent.decision.ownedEvaluation.source.evaluated_at,iso(at));
 assert.equal(intent.request.quantityHundredths,'25');assert.equal(intent.request.reduceOnly,true);assert.equal(reservation.client_order_id,intent.request.clientOrderId);
 assert.equal(f.posts.length,spec.posts,String(error));assert.equal(f.audits.length,spec.blocked?1:0,String(error));
 assert.equal(intent.state,spec.blocked?'BLOCKED':'DISPATCHED',String(error));assert.equal(reservation.state,spec.blocked?'VOID':'UNKNOWN');
 assert.equal(f.reconciliations,spec.blocked?1:0,String(error));assert.equal(f.position.quantity_hundredths,'25');assert.equal(f.openInput.entriesOpen(),false,'owned exposure never grants entry authority');
 if(spec.blocked&&!spec.badRecovery){
  assert.equal(error,undefined);assert.ok(f.observations.some(x=>x.kind==='RECONCILIATION'));
  assert.equal(f.bound.exchange.state.entriesAuthorized,true,'proven no-send is not sticky STOP');
  const firstId=intent.id;
  // Only a fresh preparation with fresh strategy evidence can reduce again.
  Object.assign(spec,{sourceAge:0,signDelay:0,commitDelay:0,releaseMs:60000});
  f.source={...f.source,id:'synthetic-refreshed-paper',evaluated_at:new Date(f.now)};
  await assert.rejects(f.openInput.dispatchProtectiveExit(selection),/protective_exit/);
  assert.equal(f.intents.length,3);assert.notEqual(f.intents[2].id,firstId);
  assert.equal(f.posts.length,1);assert.equal(f.posts[0].client_order_id,f.intents[2].client_order_id);
  assert.equal(f.reservations[0].state,'VOID');assert.equal(f.audits.length,1);
 }
 else {assert.ok(error);assert.equal(f.bound.exchange.state.entriesAuthorized,false);}
 if(!spec.blocked){await assert.rejects(f.openInput.dispatchProtectiveExit(selection));assert.equal(f.posts.length,spec.posts);assert.equal(f.reservations.length,1);}
 // Isolation comes from the VM import allowlist and fake fetch/timers above, not counters.
});
await writeFile(out+'/stub-boundaries.json',JSON.stringify({namedStubs:Object.keys(stubs),stubUses,scope:'Actual supervisor callback, executor, ledger, reserve, UNKNOWN commit, fee verification, signing, no-send and reconciliation. Startup approvals and advisory inspection eligibility are stubbed; SQL and provider responses are synthetic. VM imports, fetch and timers exclude real networking/scheduling. No PostgreSQL execution or rollback proof.'},null,2)+'\n');

const binding=[];
for(const [filename,before] of [...sourceInputs].sort()){assert.equal(sha(await readFile(filename)),before,'source changed during test');binding.push({path:path.relative(base,filename),sha256:before});}
await writeFile(out+'/source-binding.json',JSON.stringify({syntheticRelease:release,files:binding},null,2)+'\n');
