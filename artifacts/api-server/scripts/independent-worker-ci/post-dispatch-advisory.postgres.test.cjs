'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const {runInNewContext}=require('node:vm');
const {transformSync}=require('esbuild');

const root=path.join(__dirname,'../../src/lib/v13-production');
const sha='a'.repeat(40),policyHash='b'.repeat(64);
const identity={accountId:'isolated-account',ownerId:'10000000-0000-4000-8000-000000000001',releaseSha:sha,
 sourceId:'20000000-0000-4000-8000-000000000001'};
const observedAtMs=Date.parse('2026-01-01T00:00:00.000Z');
const current=observedAtMs+1000;

function fixture({dispatchFailure=false,analyticsFailure=false}={}){
 const modules=new Map(),seen=[],events=[];
 const forbidden=()=>{throw Error('real database, timers or network are forbidden in this fixture');};
 class FixtureDate extends Date{
  constructor(...args){super(...(args.length?args:[current]));}
  static now(){return current;}
 }
 function load(name){
  if(modules.has(name))return modules.get(name).exports;
  const mod={exports:{}};modules.set(name,mod);
  const file=path.join(root,name+'.ts');
  const {code}=transformSync(fs.readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'node24'});
  function loadPort(p){
   if(p==='node:crypto')return require(p);
   if(p==='@workspace/db')return {pool:{connect:forbidden,query:forbidden}};
   if(p==='@workspace/v13-strategy')return {V13_CHAMPION_PARAMETER_HASH:'c'.repeat(64),
    V13_CHAMPION_PARAMETER_SET:{parameters:{fixture:true}}};
   if(p==='../strata/deployedGitSha')return {deployedGitSha:()=>sha,requireIndependentPaperCutover:()=>true};
   if(p==='../strata/ownedFeeFailureDiagnostic')return {getOwnedFeeFailureStage:()=>undefined};
   if(p==='./boundedAnalyticsQueue')return load(p);
   if(name==='./worker'&&p==='./liveDecisionAnalytics'){
    const actual=load(p);
    return {...actual,enqueueLiveDecision(input){
     events.push('analytics');
     if(analyticsFailure)throw Error('fixture_analytics_down');
     const row=actual.normalizeLinkedLiveDecision(input);
     assert.ok(row);seen.push(row);
    }};
   }
   return new Proxy(Object.create(null),{get:forbidden});
  }
  runInNewContext(code,{module:mod,exports:mod.exports,require:loadPort,
   process:Object.freeze({env:Object.freeze({NODE_ENV:'test'})}),Date:FixtureDate,Buffer,
   fetch:forbidden,setTimeout:forbidden,clearTimeout:forbidden},{filename:file});
  return mod.exports;
 }
 const {ProductionWorker}=load('./worker');
 const {normalizeLinkedLiveDecision:normalize}=load('./liveDecisionAnalytics');
 const original=normalize({...identity,observedAtMs,stage:'OBSERVATION',outcome:'QUALIFIED',
  reasonCode:'fixture_original_qualification',market:'KXBTC15M-SYNTHETIC',direction:'UP',signal:'CONFIRM',
  policyHash,policyRevision:7,configuredStakeCents:500,allocationPreset:'fixture',facts:{btcPrice:102000,target:101950}});
 assert.equal(original?.market_ticker,'KXBTC15M-SYNTHETIC');
 const exec={independentSourceBound:true,accountOwnerUserId:identity.ownerId,exchange:{mode:'LIVE'},
  ledger:{accountId:identity.accountId,pool:{async query(sql){events.push('held_lookup');assert.match(sql,/FROM v13_production_position/);return {rows:[]};}}},
  async reconcile(){events.push('reconcile');},
  async captureIndependentEntry(){events.push('observe');return identity.sourceId;},
  async prepareEntry(id){assert.equal(id,identity.sourceId);events.push('prepare');return 'fixture-intent';},
  async dispatch(id){assert.equal(id,'fixture-intent');events.push('dispatch');if(dispatchFailure)throw Error('production_fixture_dispatch_refused');}
 };
 return {worker:new ProductionWorker(exec,2500,()=>{},()=>true,async()=>{},undefined,null,true),normalize,seen,events};
}

test('post-return qualification links rich original observation without creating an order or replacing it',async()=>{
 const {worker,normalize,seen,events}=fixture();
 try{await worker.tick();}finally{worker.stop();}
 assert.deepEqual(events,['reconcile','held_lookup','observe','prepare','dispatch','analytics']);
 assert.equal(seen.length,1);
 const r=seen[0];
 assert.equal(r.direct_source_id,identity.sourceId);
 assert.equal(r.stage,'DISPATCH');
 assert.equal(r.outcome,'QUALIFIED');
 assert.equal(r.reason_code,'direct_entry_observed_dispatch_returned');
 assert.equal(r.market_ticker,'KXBTC15M-SYNTHETIC');
 assert.equal(r.policy_hash,policyHash);
 assert.equal(r.direction,'UP');
 assert.equal(r.signal,'CONFIRM');
 assert.equal(r.facts.btcPrice,102000);
 assert.equal(r.facts.sourceObservationAtMs,observedAtMs);
 for(const key of ['order_id','submitted_orders','postAttempted','fill_count'])assert.ok(!(key in r));
 const later=normalize({...identity,observedAtMs:current+1,stage:'PREPARE',outcome:'BLOCKED',reasonCode:'fixture_later_decision'});
 assert.equal(later.market_ticker,r.market_ticker);
 assert.equal(later.facts.sourceObservationAtMs,observedAtMs);
 const foreign=normalize({...identity,accountId:'unrelated-fixture',observedAtMs:current+1,stage:'PREPARE',outcome:'BLOCKED',reasonCode:'fixture_later_decision'});
 assert.equal(foreign.market_ticker,null);
 assert.equal(foreign.facts.sourceObservationAtMs,undefined);
});

test('a failed dispatch is BLOCKED and an advisory write failure cannot replay a resolved callback',async()=>{
 const bad=fixture({dispatchFailure:true});
 try{await assert.rejects(bad.worker.tick(),{message:'production_fixture_dispatch_refused'});}finally{bad.worker.stop();}
 assert.equal(bad.seen.length,1);
 assert.equal(bad.seen[0].outcome,'BLOCKED');
 assert.equal(bad.seen[0].facts.sourceObservationAtMs,observedAtMs);
 const advisoryDown=fixture({analyticsFailure:true});
 try{await advisoryDown.worker.tick();}finally{advisoryDown.worker.stop();}
 assert.equal(advisoryDown.events.filter(v=>v==='dispatch').length,1);
 assert.equal(advisoryDown.events.filter(v=>v==='analytics').length,1);
});
