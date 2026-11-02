import test from 'node:test';import assert from 'node:assert/strict';
import {createOwnedFeedReadTiming,OwnedFeedTimingCapture,recordOwnedFeedReadTiming,isOwnedFeedReadTiming,type OwnedFeedReadTiming} from './ownedFeedReadTiming';
import {readOwnedKalshiFeeds,personalAccountSnapshot} from './personalExchangeRead';
import {canonical,digest} from '../v13-production/types';
import {KalshiApiError} from '../kalshiAccountClient';
import {beginExecutionStage,type StageTiming} from '../v13-production/stageTiming';
const creds={keyId:'never-log-key',privateKey:'never-log-secret'};
const response=(path:string)=>path.endsWith('/balance')?{subaccount:1,exchange_index:2,balance_dollars:'25.0000'}:{orders:[],fills:[],market_positions:[],settlements:[]};
test('actual seven-feed calls, args, return/proof bytes and authority clock count unchanged',async()=>{
 const calls:any[][]=[];let clockCalls=0;const now=()=>{clockCalls++;return 1234;};
 const get=async(...args:any[])=>{calls.push(args);return response(args[1]);};
 const plain=await readOwnedKalshiFeeds(creds,now(),get as never);const baseline=calls.splice(0);
 const cap=new OwnedFeedTimingCapture();let mono=0;
 const wrapped=createOwnedFeedReadTiming(get,recordOwnedFeedReadTiming,()=>++mono);
 const observed=await cap.run(async()=>{try{return await readOwnedKalshiFeeds(creds,now(),wrapped.get as never);}finally{wrapped.finish();}});
 assert.deepEqual(calls,baseline);assert.equal(calls.length,7);assert.equal(clockCalls,2);
 assert.equal(canonical(observed),canonical(plain));assert.equal(digest(observed),digest(plain));
 if(!plain.ok||!observed.ok)throw Error('fixture');
 const identity={subaccount:1 as const,exchangeIndex:2 as const,keyFingerprint:'fixture'};
 assert.equal(digest(personalAccountSnapshot(identity,plain,[])),digest(personalAccountSnapshot(identity,observed,[])));
 const event=cap.snapshot()!;assert.equal(event.groups.length,7);assert.ok(event.groups.every(g=>g.calls===1&&g.completed===1&&g.failed===0));
 const output=JSON.stringify(event);assert.ok(output.length<2048);assert.ok(!output.includes('never-log'));assert.ok(!output.includes('cursor'));assert.ok(!output.includes('/trade-api'));
});
test('429 stops actual reader at same request, failure is one count and no retry/fanout',async()=>{
 for(const instrumented of [false,true]){let calls=0;let event:OwnedFeedReadTiming|undefined;const get=async(_c:any,path:string)=>{calls++;if(calls===3)throw new KalshiApiError('HTTP_ERROR',429);return response(path);};const wrap=createOwnedFeedReadTiming(get,e=>{event=e;});
 const result=await readOwnedKalshiFeeds(creds,1234,(instrumented?wrap.get:get) as never);if(instrumented)wrap.finish();
 assert.deepEqual(result,{ok:false,reason:'kalshi_read_rate_limited'});assert.equal(calls,3);if(event){assert.equal(event.groups.at(-1)!.failed,1);assert.equal(event.groups.length,3);}}
});
test('pagination and archival unavailable retain original behavior, no new calls',async()=>{
 const run=async(instrumented:boolean)=>{const calls:string[]=[];let orderPage=0;const get=async(_c:any,path:string,q:string)=>{calls.push(path+q);if(path.endsWith('/portfolio/orders')&&orderPage++===0)return {orders:[],cursor:'opaque-cursor'};if(path.includes('/historical/'))throw new KalshiApiError('HTTP_ERROR',404);return response(path);};let event:OwnedFeedReadTiming|undefined;const w=createOwnedFeedReadTiming(get,e=>{event=e;});const value=await readOwnedKalshiFeeds(creds,1234,(instrumented?w.get:get) as never);w.finish();return {calls,value,event};};
 const a=await run(false),b=await run(true);assert.deepEqual(b.value,a.value);assert.deepEqual(b.calls,a.calls);assert.equal(b.calls.length,8);assert.equal(b.event!.groups.find(g=>g.group==='orders')!.calls,2);
});
test('wrapper preserves exact value and thrown object identity',async()=>{const value={private:'body'};const error=new Error('secret-error');const success=createOwnedFeedReadTiming(async(..._args:any[])=>value,()=>{});assert.equal(await success.get(null,'/trade-api/v2/portfolio/balance'),value);const fail=createOwnedFeedReadTiming(async(..._args:any[])=>{throw error;},()=>{});await assert.rejects(fail.get(null,'/trade-api/v2/portfolio/balance'),e=>e===error);fail.finish();});
test('throwing/rejecting observers and invalid clocks cannot change provider result',async()=>{
 for(const observer of [()=>{throw Error('observer');},()=>Promise.reject(Error('observer'))])for(const clock of [()=>NaN,()=>{throw Error('clock');},(()=>{let n=3;return()=>--n;})()]){
 const w=createOwnedFeedReadTiming(async(..._args:any[])=>42,observer,clock);assert.equal(await w.get(null,'/trade-api/v2/portfolio/balance'),42);w.finish();w.finish();}
 await new Promise(r=>setTimeout(r,0));
});
test('collector isolates concurrent async snapshots and does not leak across invocations',async()=>{
 const a=new OwnedFeedTimingCapture(),b=new OwnedFeedTimingCapture();
 await Promise.all([a.run(async()=>{const w=createOwnedFeedReadTiming(async(..._args:any[])=>{await new Promise(r=>setTimeout(r,5));},recordOwnedFeedReadTiming);await w.get(null,'/trade-api/v2/portfolio/balance');w.finish();}),b.run(async()=>{const w=createOwnedFeedReadTiming(async(..._args:any[])=>{},recordOwnedFeedReadTiming);await w.get(null,'/trade-api/v2/portfolio/fills');w.finish();})]);
 assert.deepEqual(a.snapshot()!.groups.map(g=>g.group),['balance']);assert.deepEqual(b.snapshot()!.groups.map(g=>g.group),['fills']);assert.equal(new OwnedFeedTimingCapture().snapshot(),undefined);
});
test('bounded groups/counts, unknown paths never exposed, finish emits once',async()=>{const events:OwnedFeedReadTiming[]=[];const w=createOwnedFeedReadTiming(async(..._args:any[])=>{},e=>events.push(e));for(let i=0;i<25;i++)await w.get(null,'/trade-api/v2/portfolio/orders','?secret');await w.get(null,'private-unknown');w.finish();w.finish();assert.equal(events.length,1);assert.equal(events[0]!.groups.length,1);assert.equal(events[0]!.groups[0]!.calls,20);assert.equal(events[0]!.groups[0]!.countCapped,true);assert.ok(Object.isFrozen(events[0]));});
test('existing signed stage emits one event with branded sidechannel, forged and unrelated stages omit it',async()=>{
 let summary:OwnedFeedReadTiming|undefined;const w=createOwnedFeedReadTiming(async(..._args:any[])=>{},e=>{summary=e;});await w.get(null,'/trade-api/v2/portfolio/balance');w.finish();assert.ok(isOwnedFeedReadTiming(summary));
 const events:StageTiming[]=[];const observer=(e:StageTiming)=>{events.push(e);};
 beginExecutionStage(observer,'signed_snapshot',{accountId:'fixture',mode:'LIVE'})('completed',{signedFeedReads:summary});
 beginExecutionStage(observer,'final_signed_snapshot',{accountId:'fixture',mode:'LIVE'})('rejected',{signedFeedReads:summary,error:Error('safe_error')});
 beginExecutionStage(observer,'signed_snapshot',{accountId:'fixture',mode:'LIVE'})('completed',{signedFeedReads:{...summary!}});
 beginExecutionStage(observer,'prepare_entry',{accountId:'fixture',mode:'LIVE'})('completed',{signedFeedReads:summary});
 await Promise.resolve();
 assert.equal(events.length,4);assert.equal(events[0]!.signedFeedReads,summary);assert.equal(events[1]!.signedFeedReads,summary);assert.equal(events[2]!.signedFeedReads,undefined);assert.equal(events[3]!.signedFeedReads,undefined);
});

test('inherited object keys remain unknown paths without diagnostic groups',async()=>{const seen:unknown[]=[];let summary:OwnedFeedReadTiming|undefined;const w=createOwnedFeedReadTiming(async(...args:any[])=>{seen.push(args[1]);return 42;},e=>{summary=e;});for(const path of ['constructor','toString','__proto__'])assert.equal(await w.get(null,path),42);w.finish();assert.deepEqual(seen,['constructor','toString','__proto__']);assert.deepEqual(summary!.groups,[]);});
