import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {generateKeyPairSync} from 'node:crypto';
import {build} from 'esbuild';
import path from 'node:path';
// Execute the real supervisor START/open callback and real executor factory.
// Only authority/provider/DB ports and timer scheduling are synthetic. This is
// wiring evidence, NOT an authorization, native database, or live efficacy test.
const root=process.cwd();mkdirSync(path.join(root,'dist'),{recursive:true});const dir=mkdtempSync(path.join(root,'dist/wiring-'));
const G='globalThis.__snapshotWiringFixture';
const intercepted=new Set();
const plugin={name:'synthetic-authority-and-scheduler',setup(b){b.onLoad({filter:/[\\/](personalExecutionSupervisor|accountProductionSession|personalExchangeRead|protectiveExitStartupRelease|continuousExecutionAuthorization|durableFeeConsumers)\.ts$/},args=>{
 const file=args.path.replaceAll('\\','/');intercepted.add(file.split('/').at(-1));
 let s=readFileSync(args.path,'utf8');
 function replace(name,body){const pattern=new RegExp('export (async )?function '+name+'\\(');assert.match(s,pattern);s=s.replace(pattern,(_m,a)=>`${a??''}function original_${name}(`);s+=`\nexport function ${name}(...args:any[]){${body}}\n`;}
 if(file.endsWith('/personalExecutionSupervisor.ts')){
  const declaration='let heldRecoveryScope:RecoveryHoldScope|null=null;';assert.ok(s.includes(declaration));
  s=s.replace(declaration,declaration+`${G}.setHeld=(scope:any,signal:any)=>{heldRecoveryScope=scope;heldReadAbort=signal;};`);
 }
 if(file.endsWith('/accountProductionSession.ts')){
  replace('openOwnedExecutionSession',`const session=original_openOwnedExecutionSession(...args);${G}.captured={session,input:args[0]};return session;`);
  replace('scheduleOwnedAccountWorker',`args[0].worker.isScheduled=()=>true;return Promise.resolve({ok:true,reason:'synthetic_no_timer',workerStarted:true,executionActive:false});`);
 }
 if(file.endsWith('/personalExchangeRead.ts'))replace('readOwnedKalshiFeeds',`${G}.reads.push(args[3]);return original_readOwnedKalshiFeeds(...args);`);
 if(file.endsWith('/protectiveExitStartupRelease.ts'))replace('verifyProtectiveExitStartupRelease',`return Promise.resolve(${G}.release?{ok:true}:{ok:false,reason:'fixture_release_missing'});`);
 if(file.endsWith('/continuousExecutionAuthorization.ts'))replace('hasContinuousGrantHistory','return Promise.resolve(false);');
 if(file.endsWith('/durableFeeConsumers.ts'))replace('verifyDurableFeeStage',`return Promise.resolve(${G}.fee?{ok:true,sourceDigest:'c'.repeat(64),verifiedAtMs:${G}.now}:{ok:false,reason:'fixture_consent_revoked'});`);
 return {contents:s,loader:'ts',resolveDir:path.dirname(args.path)};
});}};
const out=path.join(dir,'fixture.cjs');
await build({stdin:{contents:`export {createProductionPersonalSession} from './src/lib/strata/personalExecutionSupervisor';export {ProductionExecutor} from './src/lib/v13-production/executor';export {dedicatedSignerFingerprint} from './src/lib/strata/commissioning';export {readPublicMetadataPrefetchConfig} from './src/lib/strata/publicMetadataPrefetchConfig';`,resolveDir:root,loader:'ts'},outfile:out,bundle:true,platform:'node',format:'cjs',plugins:[plugin],external:['pg-native','pino','pino-pretty','pdfjs-dist'],logLevel:'silent'});
assert.deepEqual([...intercepted].sort(),['personalExecutionSupervisor.ts','accountProductionSession.ts','personalExchangeRead.ts','protectiveExitStartupRelease.ts','continuousExecutionAuthorization.ts','durableFeeConsumers.ts'].sort(),'Every authority port must be intercepted on this platform');
const mod=createRequire(import.meta.url)(out);
const owner='11111111-1111-4111-8111-111111111111',now=Date.parse('2026-11-18T12:00:00Z');
const material={keyId:'synthetic-only',privateKey:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'}).toString()};
const fingerprint=mod.dedicatedSignerFingerprint(material.keyId,material.privateKey);
function fixture(patch={}){
 const f=globalThis.__snapshotWiringFixture={release:true,fee:true,now,reads:[],captured:null,...patch};
 const row={key_fingerprint:fingerprint,credential_fingerprint:fingerprint,decrypted_secret:JSON.stringify({api_key_id:material.keyId,private_key:material.privateKey}),commissioned:true,execution_enabled:true,kill_switch:false,cash_precision_verified:true,cash_micros:'25000000',reserved_micros:'0',reconciled_at:new Date(now).toISOString(),fee_artifact_digest:'c'.repeat(64),policy_hash:'b'.repeat(64),fee_policy_version:'owner_approved_canonical_terms_v1',fee_source_url:'strata-durable-owner-fee://22222222-2222-4222-8222-222222222222',fee_formula_version:'standard-quadratic-0.07-v1',policy_state:'APPROVED',configured_stake_cents:'100',financial_account_id:owner,provider_connection_id:owner,vault_secret_id:owner,...patch.row};
 const queries=[];
 const db={async query(sql){queries.push(sql);
 if(sql.includes('personal-session:signer'))return {rows:f.missing?[]:[row]};
 if(sql.includes('live_execution_config'))return {rows:[{live_execution_enabled:true,manual_kill_switch:false}]};
 if(sql.includes('to_regclass'))return {rows:[{name:'lease'}]};
 if(sql.includes('SELECT state, account_kill'))return {rows:[{state:'released',account_kill:false}]};
 if(sql.includes('account-worker:arm')||sql.includes('account-worker:acquire'))return {rows:[{fencing_token:'1'}]};
 if(sql.includes('WITH unresolved_intents'))return {rows:[{n:'0'}]};
 if(sql.includes('SELECT request FROM'))return {rows:[]};
 if(sql.includes('account-worker:heartbeat'))return {rows:[{fencing_token:'1',arm_requested:true,account_kill:false,state:'owned'}]};
 if(sql.includes('SELECT arm_requested'))return {rows:[{arm_requested:true,account_kill:false,state:'owned'}]};
 throw Error('unexpected fixture SQL '+sql.slice(0,80));
 }};
 const get=async(_c,p)=>p.endsWith('/balance')?{balance_dollars:'25.0000',subaccount:1,exchange_index:2}:{[p.endsWith('/positions')?'market_positions':p.split('/').at(-1)]:[]};
 return {f,db,get,queries};
}
for(const value of [undefined,false,true,'true',1])test(`actual START wires only boolean true (${String(value)})`,async()=>{
 const {f,db,get}=fixture();const controls=mod.createProductionPersonalSession(db,{now:()=>now,kalshiGet:get,overlapFinalAccountSnapshot:value,boundedHistoryReads:value});
 const r=await controls.start({userId:owner,accountId:'fixture-account',action:'START'});assert.equal(r.ok,true,JSON.stringify(r));
 assert.ok(f.captured.session.executor instanceof mod.ProductionExecutor);assert.equal(f.captured.session.executor.overlapFinalAccountSnapshot,value===true);
 assert.equal(f.reads[0]?.mode,value===true?'bounded_history_reads_v1':undefined);
 await f.captured.input.readSnapshot();assert.equal(f.reads[1]?.mode,value===true?'bounded_history_reads_v1':undefined);
 assert.equal(f.captured.input.entriesOpen(),false,'technical reconciliation gate remains closed');
});
test('actual snapshot callback selects exact ENTRY transaction only, EXIT remains serial',async()=>{
 const {f,db,get,queries}=fixture();const controls=mod.createProductionPersonalSession(db,{now:()=>now,kalshiGet:get,overlapFinalAccountSnapshot:true,boundedHistoryReads:true});
 assert.equal((await controls.start({userId:owner,accountId:'fixture-account',action:'START'})).ok,true);
 // Synthetic transaction context; native locking/rollback behavior is covered
 // separately. Here the actual supervisor callback must choose this exact port.
 const ledger=f.captured.session.executor.ledger;let borrowed=0;
 ledger.currentTransaction=()=>({query:async(...args)=>{borrowed++;return db.query(...args);}});
 ledger.currentFinalSnapshotEntry=()=> 'entry-fixture';
 await f.captured.input.readSnapshot();assert.equal(f.reads.at(-1)?.mode,'bounded_history_reads_v1');assert.ok(borrowed>0);
 assert.ok(queries.some(sql=>sql.includes('RETURNING fencing_token::text AS fencing_token, arm_requested, account_kill, state')));
 ledger.currentFinalSnapshotEntry=()=>null;
 await f.captured.input.readSnapshot();assert.equal(f.reads.at(-1),undefined,'FINAL EXIT cannot opt in');
});
test('unsupported fee source and held recovery callback remain serial with flags enabled',async()=>{
 const legacy=fixture({row:{fee_source_url:'https://kalshi.com/fees',fee_policy_version:'standing'}});
 const controls=mod.createProductionPersonalSession(legacy.db,{now:()=>now,kalshiGet:legacy.get,verifyFee:async()=>({valid:true,digest:'c'.repeat(64),verifiedAt:now}),overlapFinalAccountSnapshot:true,boundedHistoryReads:true});
 assert.equal((await controls.start({userId:owner,accountId:'fixture-account',action:'START'})).ok,true);
 assert.equal(legacy.f.captured.session.executor.overlapFinalAccountSnapshot,false);assert.equal(legacy.f.reads[0],undefined);
 await legacy.f.captured.input.readSnapshot();assert.equal(legacy.f.reads.at(-1),undefined);
 const {f,db,get}=fixture();assert.equal((await mod.createProductionPersonalSession(db,{now:()=>now,kalshiGet:get,boundedHistoryReads:true}).start({userId:owner,accountId:'fixture-account',action:'START'})).ok,true);
 // Test-only setter supplies held lexical context; actual callback and selector
 // remain unchanged. It is not a substitute for native held lifecycle tests.
 for(const [scope,signal] of [[{},null],[null,new AbortController().signal]]){
  f.setHeld(scope,signal);await f.captured.input.readSnapshot();assert.equal(f.reads.at(-1),undefined);
 }
});
for(const patch of [{row:{kill_switch:true}},{missing:true},{release:false},{fee:false}])test('flags do not bypass missing/KILL/revoked authority '+JSON.stringify(patch),async()=>{
 const {f,db,get}=fixture(patch);const r=await mod.createProductionPersonalSession(db,{now:()=>now,kalshiGet:get,overlapFinalAccountSnapshot:true,boundedHistoryReads:true}).start({userId:owner,accountId:'fixture-account',action:'START'});
 assert.equal(r.ok,false);assert.equal(f.captured,null);
});
test('environment options use exact string true/default off independently',()=>{
 for(const v of [undefined,'false','TRUE','1',true,null,' true '])assert.equal(mod.readPublicMetadataPrefetchConfig(v).enabled,false);
 assert.equal(mod.readPublicMetadataPrefetchConfig('true').enabled,true);
 const s=readFileSync('src/lib/strata/sharedPersonalTradingControls.ts','utf8');
 for(const key of ['STRATA_FINAL_ACCOUNT_SNAPSHOT_OVERLAP_ENABLED','STRATA_BOUNDED_HISTORY_READS_ENABLED'])assert.ok(s.includes(`readPublicMetadataPrefetchConfig(process.env.${key})`));
 assert.match(s,/overlapFinalAccountSnapshot:finalAccountSnapshotOverlap.enabled/);assert.match(s,/boundedHistoryReads:boundedHistoryReads.enabled/);
});
test.after(()=>{delete globalThis.__snapshotWiringFixture;rmSync(dir,{recursive:true,force:true});});
