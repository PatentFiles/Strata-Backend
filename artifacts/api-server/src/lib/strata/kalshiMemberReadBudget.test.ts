import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveMemberRead,assertMemberBudgetUnsupported,MEMBER_READ_ADMISSION_SQL,memberReadCost,reserveMemberReadMutation} from './kalshiMemberReadBudget';
const owner='11111111-1111-1111-1111-111111111111',connection='22222222-2222-2222-2222-222222222222',fp='a'.repeat(64),path='/trade-api/v2/portfolio/fills';
function enabled(){process.env.STRATA_MEMBER_READ_BUDGET='experimental_v1';process.env.STRATA_MEMBER_BUDGET_OWNER_ID=owner;process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID='test-account';process.env.STRATA_MEMBER_BUDGET_CONNECTION_ID=connection;}
test('member budget default-off, strict scope, exact admission, no retry or refund',async()=>{
 assert.equal(memberReadCost('/trade-api/v2/markets/KXBTC15M-TEST/orderbook'),10);assert.equal(memberReadCost('/trade-api/v2/portfolio/orders/uuid-test'),2);assert.throws(()=>memberReadCost('/unknown'),/unverified/);
 delete process.env.STRATA_MEMBER_READ_BUDGET;let calls=0;
 const yes=async(sql:string,args:unknown[])=>{calls++;assert.equal(sql,MEMBER_READ_ADMISSION_SQL);assert.deepEqual(args,['test-account',owner,connection,fp,false,10]);return {rows:[{admitted:true}]};};
 await reserveMemberRead('unknown','invalid',yes);assert.equal(calls,0);assertMemberBudgetUnsupported();
 enabled();assert.throws(assertMemberBudgetUnsupported,/transport_unsupported/);
 await assert.rejects(reserveMemberRead('unknown',fp,yes),/cost_unverified/);assert.equal(calls,0);
 await reserveMemberRead(path,fp,yes);assert.equal(calls,1);
 let mutations=0;await reserveMemberReadMutation('POST','/trade-api/v2/api_keys/generate',fp,async(sql,args)=>{mutations++;assert.equal(args[5],10);assert.equal(args[4],false);return {rows:[{admitted:true}]};});assert.equal(mutations,1);
 await assert.rejects(reserveMemberReadMutation('POST','/trade-api/v2/portfolio/events/orders',fp,yes),/operation_unverified/);
 for(const rows of [[],[{admitted:false}],[{admitted:'true'}],[{admitted:true},{admitted:true}]]){
  let attempts=0;await assert.rejects(reserveMemberRead(path,fp,async()=>{attempts++;return {rows};}),/unavailable/);assert.equal(attempts,1);
 }
 let attempts=0;await assert.rejects(reserveMemberRead(path,fp,async()=>{attempts++;throw Error('database_failed');}),/database_failed/);assert.equal(attempts,1);
 const pre=new AbortController();pre.abort();await assert.rejects(reserveMemberRead(path,fp,yes,pre.signal));assert.equal(calls,1);
 const late=new AbortController();await assert.rejects(reserveMemberRead(path,fp,async()=>{calls++;late.abort();return {rows:[{admitted:true}]};},late.signal));assert.equal(calls,2);
 let cold=0;await reserveMemberRead(path,fp,async()=>({rows:[++cold===1?{admitted:false,binding_verified:true}:{admitted:true}]}));assert.equal(cold,2);
 let empty=0;await assert.rejects(reserveMemberRead(path,fp,async()=>{empty++;return {rows:[{admitted:false,binding_verified:true}]};}),/unavailable/);assert.equal(empty,2);
 const during=new AbortController();let waited=0;await assert.rejects(reserveMemberRead(path,fp,async()=>{waited++;setTimeout(()=>during.abort(Error('original_deadline')),5);return {rows:[{admitted:false,binding_verified:true}]};},during.signal),/original_deadline/);assert.equal(waited,1);
 delete process.env.STRATA_MEMBER_BUDGET_CONNECTION_ID;await assert.rejects(reserveMemberRead(path,fp,yes),/scope_unverified/);assert.equal(calls,2);
 process.env.STRATA_MEMBER_READ_BUDGET='typo';await assert.rejects(reserveMemberRead(path,fp,yes),/configuration_invalid/);
 delete process.env.STRATA_MEMBER_READ_BUDGET;
});

test('opaque tickets single use, deadline, cancellation, exact batch scope and closed invocation',async()=>{
 const {dispatchMemberRead,withMemberHistoryCredits}=await import('./kalshiMemberReadBudget');enabled();
 const yes=async()=>({rows:[{admitted:true,binding_verified:true,binding_token:"test:restricted_execution"}]});let sends=0;
 const ticket=await reserveMemberRead(path,fp,yes);dispatchMemberRead(ticket,()=>sends++);assert.equal(sends,1);
 assert.throws(()=>dispatchMemberRead(ticket,()=>sends++),/ticket_invalid/);
 assert.throws(()=>dispatchMemberRead({} as any,()=>sends++),/ticket_invalid/);
 assert.throws(()=>dispatchMemberRead(null,()=>sends++),/ticket_missing/);
 const expired=await reserveMemberRead(path,fp,yes);await new Promise(r=>setTimeout(r,510));assert.throws(()=>dispatchMemberRead(expired,()=>sends++),/ticket_expired/);
 const aborted=new AbortController();const canceled=await reserveMemberRead(path,fp,yes,aborted.signal);aborted.abort();assert.throws(()=>dispatchMemberRead(canceled,()=>sends++));
 const host='https://external-api.kalshi.com',q='?limit=200&subaccount=1&exchange_index=2';let escaped:any,queries=0;
 const batchQuery=async(_sql:string,args:unknown[])=>{queries++;assert.equal(args[5],60);return {rows:[{admitted:true,binding_token:'test:restricted_execution'}]};};
 await withMemberHistoryCredits(fp,new AbortController().signal,async()=>{
  await assert.rejects(reserveMemberRead(path,'b'.repeat(64),yes,undefined,{host,query:q}),/credit_scope/);
  await assert.rejects(reserveMemberRead(path,fp,yes,undefined,{host:'https://wrong',query:q}),/credit_scope/);
  await assert.rejects(reserveMemberRead(path,fp,yes,undefined,{host,query:q+'&subaccount=0'}),/credit_scope/);
  escaped=await reserveMemberRead(path,fp,yes,undefined,{host,query:q});
  await assert.rejects(reserveMemberRead(path,fp,yes,undefined,{host,query:q}),/credit_reused/);
 },batchQuery);
 await withMemberHistoryCredits(fp,new AbortController().signal,async()=>{const held=new AbortController();const t=await reserveMemberRead(path,fp,yes,held.signal,{host,query:q});held.abort(Error('held_stopped'));assert.throws(()=>dispatchMemberRead(t,()=>sends++),/held_stopped/);},batchQuery);
 assert.equal(queries,2);assert.throws(()=>dispatchMemberRead(escaped,()=>sends++),/ticket_expired/);assert.equal(sends,1);
 let lost=0;await assert.rejects(withMemberHistoryCredits(fp,new AbortController().signal,async()=>{lost++;},async()=>{throw Error('lost_ack');}),/lost_ack/);assert.equal(lost,0);
 delete process.env.STRATA_MEMBER_READ_BUDGET;
});

test('public scope ignores legacy tuple but rejects mode drift at admission and dispatch',async()=>{
 const {dispatchMemberRead}=await import('./kalshiMemberReadBudget');enabled();
 process.env.STRATA_PUBLIC_SELF_SERVICE_ENABLED='true';
 delete process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID;delete process.env.STRATA_MEMBER_BUDGET_OWNER_ID;delete process.env.STRATA_MEMBER_BUDGET_CONNECTION_ID;
 let sends=0;
 const yes=async(_sql:string,args:unknown[])=>{assert.deepEqual(args,[null,owner,null,fp,false,10]);return {rows:[{admitted:true,binding_verified:true}]};};
 const request={host:'https://external-api.kalshi.com',query:'',ownerId:owner};
 try{
  const ticket=await reserveMemberRead(path,fp,yes,undefined,request);
  process.env.STRATA_MEMBER_BUDGET_ACCOUNT_ID='irrelevant-legacy-account';
  dispatchMemberRead(ticket,()=>sends++);assert.equal(sends,1);
  await assert.rejects(reserveMemberRead(path,fp,async(sql,args)=>{const r=await yes(sql,args);process.env.STRATA_PUBLIC_SELF_SERVICE_ENABLED='false';return r;},undefined,request),/configuration_changed/);
  process.env.STRATA_PUBLIC_SELF_SERVICE_ENABLED='true';
  const stale=await reserveMemberRead(path,fp,yes,undefined,request);
  process.env.STRATA_PUBLIC_SELF_SERVICE_ENABLED='false';
  assert.throws(()=>dispatchMemberRead(stale,()=>sends++),/configuration_changed/);assert.equal(sends,1);
  process.env.STRATA_PUBLIC_SELF_SERVICE_ENABLED='invalid';
  await assert.rejects(reserveMemberRead(path,fp,yes,undefined,request),/configuration_invalid/);
 }finally{delete process.env.STRATA_PUBLIC_SELF_SERVICE_ENABLED;delete process.env.STRATA_MEMBER_READ_BUDGET;}
});
