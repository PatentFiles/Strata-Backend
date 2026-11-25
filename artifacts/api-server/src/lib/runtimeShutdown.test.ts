import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeShutdown} from './runtimeShutdown';
test('shutdown is single-flight and drains HTTP/workers before analytics and pool',async()=>{
 const steps:string[]=[];let exits=0;
 const shutdown=createRuntimeShutdown({closeHttp:async()=>{steps.push('http');},quiesce:async()=>{steps.push('workers');return {stopped:true,managingExposure:false};},flush:async()=>{steps.push('analytics');return true;},closePool:async()=>{steps.push('pool');},report:r=>steps.push(r),exit:c=>{assert.equal(c,0);exits++;}});
 const a=shutdown(),b=shutdown();assert.equal(a,b);assert.equal(await a,0);assert.equal(exits,1);
 assert.deepEqual(steps,['http','workers','analytics','pool','shutdown_drained']);
});
test('protective exposure retains database access and is never declared drained',async()=>{
 const steps:string[]=[];let code=-1;
 const shutdown=createRuntimeShutdown({closeHttp:async()=>{},quiesce:async()=>({stopped:false,managingExposure:true}),flush:async()=>{steps.push('flush');return true;},closePool:async()=>{steps.push('pool');},report:r=>steps.push(r),exit:c=>{code=c;}},15);
 assert.equal(await shutdown(),1);assert.equal(code,1);assert.deepEqual(steps,['shutdown_protective_exposure_retained','shutdown_deadline_reached']);
});
test('an incomplete analytics drain cannot be reported as success',async()=>{
 let closed=false;const shutdown=createRuntimeShutdown({closeHttp:async()=>{},quiesce:async()=>({stopped:true,managingExposure:false}),flush:async()=>false,closePool:async()=>{closed=true;},report:()=>{},exit:c=>assert.equal(c,1)});
 assert.equal(await shutdown(),1);assert.equal(closed,false);
});
