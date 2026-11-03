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
const out=path.resolve(argument('--out-dir')??await mkdtemp(path.join(tmpdir(),'strata-final-supervisor-wiring-')));
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
 './ownerFeeEmergencyExitWorkerRecovery':forbidden('reconcileOwnedProtectiveExits'),
 './ownerFeeEmergencyExitReserve':forbidden('reserveOwnedEmergencyExitProof'),
 './ownerFeeEmergencyExitSignedDispatch':forbidden('dispatchReviewedProtectiveExitOnce')+forbidden('isDurableProtectiveExitNoSend'),
 'pdfjs-dist/legacy/build/pdf.mjs':`export function getDocument(){throw Error('offline_pdf_forbidden');}`,
};
const entry=`export * from ${JSON.stringify(strata+'/sharedPersonalTradingControls.ts')};
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
  export function openOwnedExecutionSession(input){const bound=real.openOwnedExecutionSession(input);globalThis.fixture.bound=bound;globalThis.fixture.openInput=input;return bound;}
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
  export function emptySnapshot(identity,feeds){return {identity,observedAtMs:globalThis.fixture.now,cashMicros:feeds.cashMicros,authenticated:true,complete:true,cashExact:true,unexplainedCashActivity:false,orders:[],positions:[],fills:[],settlements:[]};}
  `:stubs[args.path]}));
 b.onLoad({filter:/\.[cm]?[jt]s$/,namespace:'file'},async args=>{if(args.path.startsWith(base+'/')){const bytes=await readFile(args.path);sourceInputs.set(args.path,sha(bytes));return {contents:bytes,loader:args.path.endsWith('.ts')?'ts':'js'};}});
}}]});
await writeFile(out+'/bundle.cjs',built.outputFiles[0].contents);
await writeFile(out+'/bundle-metafile.json',JSON.stringify(built.metafile,null,2)+'\n');
const owner='11111111-1111-4111-8111-111111111111',account='offline-account',grant='55555555-5555-4555-8555-555555555555';
const market='KXBTC15M-26NOV031700-00',event='KXBTC15M-26NOV031700';
const at=Date.parse('2026-11-03T16:55:00Z'),release='53bb032eab8e77a45b5cc88692e4c19fb8d8c708';
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
 const f={now:at,digest:'d'.repeat(64),policy:'b'.repeat(64),logs:[],warnings:[],calls:[],sql:[],scheduleCalls:[],startupReleaseCalls:0,standingHistoryCalls:0,startupFeedReads:0,monetaryCalls:0,workerStops:0,books:0,externalNetworkCalls:0,orderTransportCalls:0,realTimers:0,abortSignalDeadlines:[],timers:new Map(),publicPages:pages(),stopExposure:false,reviewMutator:r=>r};
 f.oldFlag=old;
 f.source=api?'strata-api-reviewed://kxbtc15m/'+grant:'https://kalshi.com/docs/kalshi-fee-schedule.pdf';
 f.row={key_fingerprint:fingerprint,credential_fingerprint:fingerprint,cash_micros:'60000000000',reserved_micros:'0',reconciled_at:iso(at-1000),commissioned:true,execution_enabled:true,kill_switch:false,blocked_reason:null,fee_artifact_digest:f.digest,cash_precision_verified:true,subaccount:1,exchange_index:2,financial_account_id:'financial-offline',provider_connection_id:'provider-offline',vault_secret_id:'vault-offline',decrypted_secret:JSON.stringify({api_key_id:keyId,private_key:privateKey}),policy_hash:f.policy,fee_policy_version:'strata_api_fee_source_signed_review_v2',fee_source_url:f.source,fee_formula_version:'standard-quadratic-0.07-v1',policy_state:'APPROVED',configured_stake_cents:500};
 f.review=()=>f.reviewMutator({grant_id:grant,owner_user_id:owner,issuer_admin_id:'22222222-2222-4222-8222-222222222222',rate_decision_digest:f.exports.PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,fee_model_version:f.exports.PDF_FREE_RATE_REVIEW_VECTOR_VERSION,policy_version:'strata_api_fee_source_signed_review_v2',scope:'KXBTC15M:INDEX2',issued_at:iso(at-20000),expires_at:iso(at+60000),revoked_at:null,authorized_stages:['STEP_9','STEP_11','ORDER_ENTRY'],consent_owner:owner,confirmed_at:iso(at-15000),consent_revoked_at:null,first_review_id:'66666666-6666-4666-8666-666666666666',first_reviewer:'22222222-2222-4222-8222-222222222222',first_digest:f.exports.PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,first_model:f.exports.PDF_FREE_RATE_REVIEW_VECTOR_VERSION,first_scope:'KXBTC15M:INDEX2',first_signed:iso(at-30000),first_expires:iso(at+70000),first_revoked:null});
 const query=async(sql,args=[])=>{
  f.sql.push({sql,args});
  if(sql.includes('-- personal-session:signer'))return {rows:[f.row]};
  if(sql.includes("FROM live_execution_config WHERE id = 'singleton'"))return {rows:[{live_execution_enabled:true,manual_kill_switch:false}]};
  if(sql==='SELECT request FROM v13_production_intent WHERE account_id = $1')return {rows:[]};
  if(sql.includes('-- api-fee:two-person-source-stage.'))return {rows:[f.review()]};
  if(sql.includes("to_regclass('private.kalshi_account_worker_lease')"))return {rows:[{name:'offline-test-port'}]};
  if(sql.includes('SELECT state, account_kill FROM private.kalshi_account_worker_lease'))return {rows:[{state:'released',account_kill:false}]};
  if(sql.includes('-- account-worker:arm'))return {rows:[{id:account}]};
  if(sql.includes('-- account-worker:acquire'))return {rows:[{fencing_token:'3'}]};
  if(sql.includes('WITH unresolved_intents AS'))return {rows:[{n:'0'}]};
  if(sql.startsWith('BEGIN; SELECT * FROM v13_production_account'))return [{command:'BEGIN',rows:[]},{command:'SELECT',rows:[{id:account}]}];
  if(sql.includes('SELECT a.id')&&sql.includes('FOR SHARE OF a,p,live,c,lease'))return {rows:f.accountFenceClosed?[]:[{id:account}]};
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('SET '))return {rows:[]};
  if(sql.startsWith('SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE'))return {rows:[{id:account}]};
  if(sql.includes('AS positions')&&sql.includes('AS unresolved'))return {rows:[{positions:f.stopExposure?1:0,orders:0,unresolved:0}]};
  if(sql.includes('-- account-worker:release')||sql.includes('-- account-worker:hold')||sql.includes('-- account-worker:kill'))return {rows:[{id:account}]};
  throw Error('unexpected_offline_sql:'+sql);
 };
 f.db={query,connect:async()=>{f.sql.push({offlineConnect:true});return {query,release(){f.sql.push({offlineRelease:true});}};}};
 f.signedGet=async(_material,p)=>{assert.equal(p,`/trade-api/v2/markets/${market}/orderbook`);f.books++;return {orderbook_fp:{yes_dollars:[['0.5000','100000']],no_dollars:[['0.5000','100000']]}};};
 f.fetch=async(input,init)=>{const url=String(input);if((init?.method??'GET')!=='GET'){f.orderTransportCalls++;throw Error('offline_order_transport_forbidden');}assert.ok(url.startsWith('https://external-api.kalshi.com/trade-api/v2/'));assert.equal(init?.redirect,'error');const p=url.replace('https://external-api.kalshi.com/trade-api/v2','');assert.ok(p in f.publicPages,'unexpected fixture public path '+p);f.calls.push({path:p,at:f.now,signal:init?.signal});if(f.pausePublic)await f.pausePublic;return Response.json(f.publicPages[p]);};
 class ClockDate extends Date{constructor(...a){super(...(a.length?a:[f.now]));}static now(){return f.now;}}
 const env=Object.freeze({[oldFlag]:old,...(value===undefined?{}:{[finalFlag]:value}),NODE_ENV:'production',RAILWAY_GIT_COMMIT_SHA:release,STRATA_PROTECTIVE_EXIT_SIGNED_RELEASE:'true'});
 const OfflineAbortSignal={timeout(ms){const controller=new AbortController();f.abortSignalDeadlines.push({ms,controller});return controller.signal;},abort:AbortSignal.abort.bind(AbortSignal),any:AbortSignal.any.bind(AbortSignal)};
 const allowedModules=new Set(['node:crypto','node:async_hooks','node:buffer','node:path','node:util','node:events']);
 const context={fixture:f,module:{exports:{}},process:{env},console:{warn:(...x)=>f.warnings.push(x),info:(...x)=>f.logs.push(x),log:(...x)=>f.logs.push(x)},Date:ClockDate,performance:{now:()=>0},fetch:f.fetch,Response,Request,Headers,URL,URLSearchParams,AbortController,AbortSignal:OfflineAbortSignal,ReadableStream,TextDecoder,TextEncoder,Buffer,queueMicrotask,structuredClone,
  setTimeout(fn,ms){const id={unref(){}};f.timers.set(id,{fn,ms});return id;},clearTimeout(id){f.timers.delete(id);},setInterval(){throw Error('real_timer_forbidden');},clearInterval(){throw Error('real_timer_forbidden');},
  require(name){if(name==='node:perf_hooks')return {performance:{now:()=>0}};if(name==='node:fs/promises')return {readFile(){throw Error('runtime_filesystem_forbidden');}};if(!allowedModules.has(name))throw Error('runtime_import_forbidden:'+name);return require(name);}};
 context.exports=context.module.exports;runInNewContext(built.outputFiles[0].text,context,{timeout:3000});f.exports=context.module.exports;
 f.start=()=>f.exports.personalTradingSession.start({userId:owner,accountId:account,action:'START'});
 f.stop=(action='STOP')=>f.exports.personalTradingSession.stop({userId:owner,accountId:account,action});
 return f;
}
const results=[];
async function check(name,body){return test(name,async()=>{try{const details=await body();results.push({name,status:'passed',details:details??{}});}catch(error){results.push({name,status:'failed',error:String(error),stack:error?.stack});throw error;}});}
const turns=async(n=150)=>{for(let i=0;i<n;i++)await Promise.resolve();};
async function start(f){const r=await f.start();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.workerStarted,true);assert.equal(f.exports.dedicatedSignerFingerprint(keyId,privateKey),fingerprint);assert.ok(f.bound.executor instanceof f.exports.ProductionExecutor);assert.ok(f.bound.executor.ledger instanceof f.exports.ProductionLedger);assert.ok(f.bound.exchange instanceof f.exports.AccountScopedExchange);assert.ok(f.bound.worker instanceof f.exports.ProductionWorker);assert.equal(f.controls.session,f.exports.personalTradingSession);assert.equal(typeof f.bound.executor.prefetchCommittedPublicMetadata,f.oldFlag==='true'?'function':'object');return f;}
function source(id='evaluation-offline'){return {evaluationId:id,marketTicker:market,evaluatedAtMs:at-100,btcProviderAgeMs:100,btcReceiveAgeMs:0,marketAgeMs:0};}
function phaseContext(id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'){return {intentId:id,invocation:Symbol('offline-invocation'),source:source(id)};}
function phases(f){assert.ok(f.bound.executor.finalPublicMetadata instanceof f.exports.FinalPublicMetadataPhases);return f.bound.executor.finalPublicMetadata;}
async function cleaned(f){await turns();const d=f.exports.processCommittedPublicMetadata.diagnostics();assert.equal(d.activeRequests,0);assert.equal(d.queuedRequests,0);assert.equal(d.accounts,0);assert.equal(f.orderTransportCalls,0);assert.equal(f.externalNetworkCalls,0);assert.equal(f.realTimers,0);const inertExpiryTimers=f.timers.size;return {...JSON.parse(JSON.stringify(d)),inertExpiryTimers,virtualAbortSignalDeadlines:f.abortSignalDeadlines.length};}
const order=c=>({ticker:market,subaccount:1,exchange_index:2,reduce_only:false,time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,client_order_id:'v13p-'+c.intentId,side:'bid',count:'1.00',price:'0.5000'});
async function wire(f,c){return f.bound.executor.ledger.transaction(async()=>f.bound.exchange.fetchImpl('https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders',{method:'POST',body:JSON.stringify(order(c))}));}
try{
 await check('exact final flag through real shared module and supervisor construction matrix',async()=>{
  const rows=[];for(const value of [undefined,'false','true','','TRUE','False',' true','true ','1','0','yes',true,false,null]){const f=await start(fixture(value));assert.equal(f.bound.executor.finalPublicMetadata instanceof f.exports.FinalPublicMetadataPhases,value==='true');assert.equal(f.bound.executor.prefetchCommittedPublicMetadata,null);assert.equal(f.warnings.length,[undefined,'false','true'].includes(value)?0:1);assert.deepEqual(f.scheduleCalls,['entries']);await f.stop();await cleaned(f);rows.push({value:value===undefined?'<unset>':value,installed:value==='true',oldFlag:'false',startupFeeReviewQueries:f.sql.filter(x=>x.sql?.includes('-- api-fee:two-person-source-stage.')).length});}return {rows};
 });
 await check('final true does not install phases for non-API source',async()=>{const f=await start(fixture('true',{api:false}));assert.equal(f.bound.executor.finalPublicMetadata,null);assert.equal(f.monetaryCalls,1);await f.stop();return cleaned(f);});
 await check('real FINAL_MARKET consumes supervisor metadata callback and real market/fee validators',async()=>{
  const f=await start(fixture('true')),p=phases(f),c=phaseContext();const before=f.calls.length;
  p.start('FINAL_MARKET',c);await turns();assert.equal(f.calls.length-before,5);
  const evidence=await p.finalMarket(c,()=>f.bound.exchange.market(market,'YES'));
  assert.equal(f.calls.length-before,5);assert.equal(f.books,1);assert.ok(evidence.publicMetadataCapture);assert.equal(evidence.publicMetadataCapture.manifest.records.length,5);
  assert.equal(f.sql.filter(x=>x.sql?.includes('-- api-fee:two-person-source-stage.')).length,2);
  await f.stop();return {publicGets:5,bookReads:1,reviewQueries:2,capture:evidence.publicMetadataCapture,cleanup:await cleaned(f)};
 });
 await check('real WIRE_FEE consumes original guarded callback and reaches unchanged missing-clock refusal',async()=>{
  const f=await start(fixture('true')),p=phases(f),c=phaseContext();const before=f.calls.length;p.start('WIRE_FEE',c);await turns();assert.equal(f.calls.length-before,5);
  await assert.rejects(wire(f,c),/production_final_wire_clock_missing/);assert.equal(f.calls.length-before,5);
  assert.equal(f.sql.filter(x=>x.sql?.includes('FOR SHARE OF a,p,live,c,lease')).length,1);
  assert.equal(f.sql.filter(x=>x.sql?.includes('-- api-fee:two-person-source-stage.')).length,2);
  p.finish(c.intentId,c.invocation);await f.stop();return {publicGets:5,finalAccountFenceQueries:1,realFeeReviewQueries:2,rawOrderTransportCalls:0,expectedRefusal:'production_final_wire_clock_missing',cleanup:await cleaned(f)};
 });
 await check('original constructor admission guards suppress starts for each held authority state',async()=>{
  const rows=[];for(const [key,value] of [['armRequested',false],['entriesAuthorized',false],['accountKill',true],['globalKill',true],['presentedToken',-1]]){const f=await start(fixture('true')),p=phases(f),c=phaseContext();f.bound.exchange.state[key]=value;const before=f.calls.length;p.start('FINAL_MARKET',c);await turns();assert.equal(f.calls.length,before);assert.equal(f.exports.processCommittedPublicMetadata.diagnostics().accounts,0);await f.stop();await cleaned(f);rows.push({key,value,started:false});}return {rows};
 });
 await check('original constructor consume guard rejects after authorization changes without fresh fallback',async()=>{
  const rows=[];for(const [key,value] of [['armRequested',false],['entriesAuthorized',false],['accountKill',true],['globalKill',true],['presentedToken',-1]]){const f=await start(fixture('true')),p=phases(f),c=phaseContext();const before=f.calls.length;p.start('FINAL_MARKET',c);await turns();f.bound.exchange.state[key]=value;await assert.rejects(p.finalMarket(c,()=>f.bound.exchange.market(market,'YES')),/phase_metadata_authority_hold/);assert.equal(f.calls.length-before,5);assert.equal(f.books,0);await f.stop();await cleaned(f);rows.push({key,value,refused:'phase_metadata_authority_hold'});}return {rows};
 });
 await check('STOP invokes real disarm, cancels metadata, prevents fallback, and stops flat fixture worker',async()=>{
  const f=await start(fixture('true')),p=phases(f),c=phaseContext();const before=f.calls.length;p.start('WIRE_FEE',c);await turns();const result=await f.stop();assert.equal(result.workerStopped,true);assert.equal(result.managingExposure,false);assert.equal(f.workerStops,1);assert.equal(f.bound.exchange.state.entriesAuthorized,false);
  assert.throws(()=>p.consumeWire('v13p-'+c.intentId,market),/phase_metadata_authority_hold/);assert.equal(f.calls.length-before,5);assert.ok(f.calls.slice(before).every(x=>x.signal.aborted));assert.ok(f.sql.some(x=>x.sql?.includes('-- account-worker:release')));p.finish(c.intentId,c.invocation);return {result,cleanup:await cleaned(f)};
 });
 await check('STOP exposure retention cancels public phases while retaining inert protective worker',async()=>{
  const f=await start(fixture('true')),p=phases(f),c=phaseContext();f.stopExposure=true;p.start('FINAL_MARKET',c);await turns();const result=await f.stop();assert.equal(result.managingExposure,true);assert.equal(f.workerStops,0);assert.ok(f.sql.some(x=>x.sql?.includes('-- account-worker:hold')));await assert.rejects(p.finalMarket(c,()=>f.bound.exchange.market(market,'YES')),/phase_metadata_authority_hold/);await f.stop('KILL');return {result,cleanup:await cleaned(f)};
 });
 await check('STOP during queued public reads aborts the original attempt and drains without replacement',async()=>{
  const f=await start(fixture('true')),p=phases(f),c=phaseContext();let releaseHeaders;f.pausePublic=new Promise(resolve=>{releaseHeaders=resolve;});const before=f.calls.length;p.start('WIRE_FEE',c);await turns();assert.equal(f.calls.length-before,3);assert.equal(f.exports.processCommittedPublicMetadata.diagnostics().activeRequests,3);await f.stop();assert.ok(f.calls.slice(before).every(x=>x.signal.aborted));assert.throws(()=>p.consumeWire('v13p-'+c.intentId,market),/phase_metadata_authority_hold/);p.finish(c.intentId,c.invocation);releaseHeaders();const cleanup=await cleaned(f);assert.equal(f.calls.length-before,3);assert.equal(cleanup.inertExpiryTimers,0);return {publicGets:3,cleanup};
 });
 await check('supplemental both-flags case uses original FINAL_MARKET releasePrepare callback',async()=>{
  const f=await start(fixture('true',{old:'true'})),p=phases(f),c=phaseContext();const before=f.calls.length;
  const hint={...source('prepare-offline'),committedAtMs:at,qualifyingTrigger:true};
  const prepare=f.bound.executor.prefetchCommittedPublicMetadata(hint);assert.ok(prepare);await prepare.drained;assert.equal(f.calls.length-before,5);
  p.start('FINAL_MARKET',c);await turns();assert.equal(f.calls.length-before,10);assert.ok(f.calls.slice(before,before+5).every(x=>x.signal.aborted));
  const evidence=await p.finalMarket(c,()=>f.bound.exchange.market(market,'YES'));assert.ok(evidence.publicMetadataCapture);assert.equal(f.calls.length-before,10);await f.stop();return {oldFlag:'true only in supplemental releasePrepare test',publicGets:10,cleanup:await cleaned(f)};
 });
 await check('actual API verifier refuses revoked review before wire and never treats cached public bytes as authority',async()=>{
  const f=await start(fixture('true')),p=phases(f),c=phaseContext();p.start('WIRE_FEE',c);await turns();f.reviewMutator=r=>({...r,first_revoked:iso(at-1)});const before=f.calls.length;await assert.rejects(wire(f,c),/api_fee_final_order_grant_or_market_closed/);assert.equal(f.calls.length,before);p.finish(c.intentId,c.invocation);await f.stop();return {rawOrderTransportCalls:0,cleanup:await cleaned(f)};
 });
 await check('OFF retains fresh market/wire reads with the same guards',async()=>{
  const f=await start(fixture('false')),c=phaseContext();const before=f.calls.length;const evidence=await f.bound.exchange.market(market,'YES');assert.equal(f.calls.length-before,5);assert.equal(evidence.publicMetadataCapture,undefined);await assert.rejects(wire(f,c),/production_final_wire_clock_missing/);assert.equal(f.calls.length-before,10);await f.stop();return {publicGets:10,cleanup:await cleaned(f)};
 });
}finally{
 const binding=[];for(const [filename,before] of [...sourceInputs].sort()){const after=sha(await readFile(filename));assert.equal(after,before,'frozen source mutated');binding.push({path:path.relative(base,filename),sha256:before});}
 await writeFile(out+'/source-binding.json',JSON.stringify({sourceRoot:base,referenceFrozenMerge:release,referenceFrozenTree:'97ed06f602e27f5d10cec6371e4be77ddbb21a2f',allReadSourceFilesUnchanged:true,files:binding},null,2)+'\n');
 await writeFile(out+'/stub-boundaries.json',JSON.stringify({namedStubs:Object.keys(stubs),wrappers:['accountProductionSession scheduler boundary + capture real open','personalExchangeRead startup snapshot/feed fixtures only'],stubUses},null,2)+'\n');
 await writeFile(out+'/results.json',JSON.stringify({scope:'Offline actual construction and callback wiring qualification. No real worker START, timers, provider IO, database, order transport, economic replay, production authority, or historical full-path proof.',passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,results},null,2)+'\n');
}
