const fs=require('fs');
// Test-only bundling selects durable discovery without adding a production override.
// Actual core verifier, dispatch, and RSA signing execute; no exchange calls.
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../artifacts/api-server');
// Externalized parser/logging modules resolve from the bundle's ancestors,
// not cwd or NODE_PATH. Keep disposable output beneath this package.
const outputRoot=path.join(root,'dist');
fs.mkdirSync(outputRoot,{recursive:true});
const temporary=fs.mkdtempSync(path.join(outputRoot,'durable-emergency-source-'));
const output=path.join(temporary,'regression.cjs');
const esbuild=require(root+'/node_modules/esbuild');
const dir=root+'/src/lib/strata';
const originalHarness=fs.readFileSync(dir+'/ownerFeeEmergencyExitSignedDispatch.test.ts','utf8');
assert.ok(originalHarness.includes('test("one committed UNKNOWN'),'harness extraction anchor changed');
let harness=originalHarness.split('test("one committed UNKNOWN')[0];
harness=harness.replace(/verifyFee:\(async\(\)=>\{[\s\S]*?\}\) as never,/, '');
assert.ok(!harness.includes('verifyFee:(async()=>'),'fee override must be removed');
let core=fs.readFileSync(dir+'/durableOwnerFeePolicy.test.ts','utf8');
assert.ok(core.includes("test('durable approved")&&core.includes('const row='),'core fixture anchors changed');
let fixture=core.split("test('durable approved")[0].split('\n').slice(1).join('\n');
fixture+=core.split('\n').find(l=>l.startsWith('const row='));
harness=harness.replace('const MARKET="KXBTC15M-26OCT161945-45";', 'const MARKET="KXBTC15M-26OCT15T2200";');
const tests=`
for (const delay of [1000,1001]) test('independent actual durable emergency post-RSA boundary '+delay,async t=>{
 process.env.STRATA_DURABLE_OWNER_FEE_ENABLED='true';
 let wall=fixtureClock, sourceMono=0;
 const proof=await verifyDurableOwnerFee({query:async()=>({rows:[row]})},scope,marketTicker,'PROTECTIVE_EXIT',{clock:()=>wall,monotonicNow:()=>sourceMono,fetcher:kalshiFeed(feeApiPages())});
 assert.equal(proof.ok,true);globalThis.__proof=proof;
 wall+=4000;sourceMono=4000;
 t.mock.method(Date,'now',()=>wall);
 const h=harness({rawSigned:true,finalize:true,standing:true,releaseRemainingMs:null});
 const original=Sign.prototype.sign;let signs=0,posts=0;
 t.mock.method(Sign.prototype,'sign',function(...args){const r=original.apply(this,args);signs++;sourceMono+=delay;wall=fixtureClock+3000;return r;});
 t.mock.method(globalThis,'fetch',async()=>{posts++;throw Error('synthetic exchange transport');});
 const result=await h.run();assert.equal(signs,1,'actual RSA hook must run');
 assert.equal(posts,delay===1000?1:0);assert.equal(result.postAttempted,delay===1000);
 assert.equal(result.mayRetry,false);assert.equal(result.state,delay===1000?'UNKNOWN':'BLOCKED');
 t.mock.restoreAll();
});`;
esbuild.build({stdin:{contents:harness+'\n'+fixture+'\n'+tests,resolveDir:dir,loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:output,external:['pg-native','pdfjs-dist','pino','pino-pretty'],plugins:[{name:'test-only-durable-ports',setup(build){build.onResolve({filter:/^\.\/(durableFeeConsumers|ownerStandingFeeAuthorization)$/},args=>{if(path.basename(args.importer)==='ownerFeeEmergencyExitSignedDispatch.ts')return {path:args.path,namespace:'independent-test'};});build.onLoad({filter:/.*/,namespace:'independent-test'},args=>({contents:args.path.includes('durableFeeConsumers')?`export async function verifyDurableFeeStage(){return globalThis.__proof;} export async function verifyDurableProtectiveAuthority(){return {ok:true,authorityFingerprint:'f'.repeat(64),validForMs:60000};}`:`export async function readOwnerV3ProtectiveSource(){return {mode:'OWNER_DURABLE',sourceUrl:'strata-durable-owner-fee://33333333-3333-4333-8333-333333333333'};} export async function verifyOwnerV3ProtectiveFee(){throw Error('wrong mode');} export async function verifyOwnerV3ProtectiveFeeAuthority(){throw Error('wrong mode');}`,loader:'ts'}));}}]}).then(()=>{
 const result=spawnSync(process.execPath,['--test',output],{stdio:'inherit',env:{...process.env,NODE_ENV:'test'}});
 if(result.error)throw result.error;
 process.exitCode=result.status??1;
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(temporary,{recursive:true,force:true}));
