import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const source=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const compile=text=>ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
function harness(value){
 const env=value===undefined?{}:{STRATA_PAPER_ANALYTICS_PAUSED:value};
 const gate={exports:{},process:{env}};
 vm.runInNewContext(compile(source('./paperAnalyticsMaintenance.ts')),gate);
 const routes=new Map();let reads=0;
 const forbidden=()=>{reads++;throw new Error('database read reached');};
 const router={use(){},get(path,handler){routes.set(path,handler);}};
 const dependencies={
  '../lib/paperAnalyticsMaintenance':gate.exports,
  express:{Router:()=>router},
  '../lib/readOnlyAnalyticsCache':{createSingleFlightAnalyticsCache:()=>forbidden},
  '@workspace/db':{db:{select:forbidden},forwardTestPositionTable:{},forwardTestWindowTable:{}},
  '../lib/forwardTestRepository':{getEngineStatus:forbidden,aggregateForwardTestStatistics:forbidden},
 };
 const route={exports:{},process:{env},require:name=>dependencies[name]??{},Date};
 vm.runInNewContext(compile(source('../routes/forwardTest.ts')),route);
 return {gate:gate.exports,api:route.exports,routes,reads:()=>reads,env};
}
test('pause defaults off and requires exact true',()=>{
 for(const value of [undefined,'false','TRUE','1','']) assert.equal(harness(value).gate.paperAnalyticsPaused(),false);
 assert.equal(harness('true').gate.paperAnalyticsPaused(),true);
});
test('shared status and history functions reject before any DB or cache operation',async()=>{
 const h=harness('true');
 for(const name of ['readForwardTestStatus','readForwardTestHistory'])await assert.rejects(h.api[name](),/Paper analytics paused/);
 assert.equal(h.reads(),0);
 h.env.STRATA_PAPER_ANALYTICS_PAUSED='false';
 await assert.rejects(h.api.readForwardTestHistory(),/database read reached/);
 assert.equal(h.reads(),1);
});
test('legacy endpoints explicitly return uncached 503 and do not fabricate stats',async()=>{
 const h=harness('true');
 for(const path of ['/forward-test/status','/forward-test/history']){
  let status,body;const headers={};
  const response={setHeader(k,v){headers[k]=v;},status(s){status=s;return this;},json(v){body=v;}};
  await h.routes.get(path)({},response);
  assert.equal(status,503);assert.equal(body.error,h.gate.PAPER_ANALYTICS_PAUSE_MESSAGE);
  assert.equal(headers['Cache-Control'],'no-store');assert.equal(Object.keys(body).length,1);
 }
 assert.equal(h.reads(),0);
});
test('modern endpoints gate before injected reads; signal and reconciliation stay untouched',()=>{
 const router=source('../routes/strataRouter.ts');
 for(const endpoint of ['status','history']){
  const start=router.indexOf(`router.get("/forward-test/${endpoint}"`);
  const end=router.indexOf('\n  });',start);const block=router.slice(start,end);
  assert.ok(block.indexOf('paperAnalyticsPaused()')<block.indexOf('await deps.forwardTest'));
  assert.match(block,/res\.status\(503\)/);assert.match(block,/Cache-Control.*no-store/);
 }
 for(const path of ['./forwardTestWorker.ts','./microLive.ts','./strata/personalExecutionSupervisor.ts','./v13-production/ledger.ts'])
  assert.doesNotMatch(source(path),/paperAnalyticsPaused|assertPaperAnalyticsAvailable|STRATA_PAPER_ANALYTICS_PAUSED/);
});

test('modern router pauses paper reads, keeps authentication and live-state/stop handlers active',async()=>{
 const h=harness('true');const routes=new Map();let paperReads=0,liveReads=0,stops=0;
 const auth=()=>{};const router={use(){},get(path,...handlers){routes.set(path,handlers);},post(path,...handlers){routes.set(path,handlers);}};
 const fallback=new Proxy({}, {get:()=>()=>({})});
 const dependencies={
  '../lib/paperAnalyticsMaintenance':h.gate,
  express:{Router:()=>router},
  '../lib/strata/supabaseAuth':{createStrataAccess:()=>({requireUser:auth,requireDeveloper:auth})},
  '@workspace/api-zod':{EmergencyStopMicroLiveBody:{safeParse:()=>({success:true})}},
  '../lib/readOnlyAnalyticsCache':{createSingleFlightAnalyticsCache:()=>()=>{throw Error('unexpected research read');}},
 };
 const context={exports:{},process:{env:h.env},require:name=>dependencies[name]??fallback};
 vm.runInNewContext(compile(source('../routes/strataRouter.ts')),context);
 context.exports.createStrataRouter({
  forwardTestStatus:async()=>{paperReads++;return {ok:true};},
  forwardTestHistory:async()=>{paperReads++;return {ok:true};},
  microLiveState:async()=>{liveReads++;return {live:true};},
  emergencyStop:async()=>{stops++;return {stopped:true};},
 });
 async function call(path){let status=200,body;const headers={};const handlers=routes.get(path);
  assert.equal(handlers[0],auth);
  await handlers.at(-1)({body:{}},{setHeader(k,v){headers[k]=v;},status(s){status=s;return this;},json(v){body=v;}});
  return {status,body,headers};
 }
 for(const path of ['/forward-test/status','/forward-test/history']){
  const result=await call(path);assert.equal(result.status,503);
  assert.equal(result.headers['Cache-Control'],'no-store');
 }
 assert.equal(paperReads,0);
 assert.equal((await call('/micro-live/state')).body.live,true);
 assert.equal((await call('/micro-live/emergency-stop')).body.stopped,true);
 assert.equal(liveReads,1);assert.equal(stops,1);
 h.env.STRATA_PAPER_ANALYTICS_PAUSED='false';
 for(const path of ['/forward-test/status','/forward-test/history'])assert.equal((await call(path)).status,200);
 assert.equal(paperReads,2);
});
