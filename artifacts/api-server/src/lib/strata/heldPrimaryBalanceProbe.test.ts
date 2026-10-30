import test from 'node:test';
import assert from 'node:assert/strict';
import {runHeldPrimaryBalanceProbe,primaryProbeFetch,sanitizePrimaryBalance,startHeldPrimaryBalanceProbe,HELD_PRIMARY_SQL,PRIMARY_CREDENTIAL_SQL} from './heldPrimaryBalanceProbe';
const scope={ownerId:'11111111-1111-4111-8111-111111111111',accountId:'strata-account-'+'a'.repeat(24),expectedSha:'b'.repeat(40)};
function fixture(){
 let loaded=0,reads=0,reserved=0,held=true,bound=true,sha=scope.expectedSha;const saved:unknown[]=[];
 const deps={sha:()=>sha,held:async()=>held,sameBinding:async()=>bound,
 credentials:async()=>{loaded++;return {keyId:'secret-key',privateKey:'secret-private'};},
 reserve:async()=>{reserved++;},get:async()=>{reads++;return {balance_dollars:'100.0001',portfolio_value:0,updated_ts:123,private:'secret-body'};},
 receipt:()=>({httpStatus:200,providerRttMs:2}),save:async(v:unknown)=>{saved.push(v);}};
 return {deps,saved,get loaded(){return loaded},get reads(){return reads},get reserved(){return reserved},hold:(v:boolean)=>held=v,bind:(v:boolean)=>bound=v,sha:(v:string)=>sha=v};
}
test('default off and nonproduction have no effects',()=>{startHeldPrimaryBalanceProbe({NODE_ENV:'production'});startHeldPrimaryBalanceProbe({NODE_ENV:'test',STRATA_HELD_PRIMARY_BALANCE_PROBE_ENABLED:'true'});});
test('wrong SHA/owner/account and active worker refuse before secret',async()=>{
 for(const changed of [{expectedSha:'c'.repeat(40)},{ownerId:'bad'},{accountId:'legacy'}]){const f=fixture();assert.equal((await runHeldPrimaryBalanceProbe({...scope,...changed},f.deps)).ok,false);assert.equal(f.loaded,0);}
 const f=fixture();f.hold(false);assert.equal((await runHeldPrimaryBalanceProbe(scope,f.deps)).ok,false);assert.equal(f.loaded,0);
});
test('one read one reservation; sanitized exact primary display is not ledger authority',async()=>{
 const f=fixture();assert.equal((await runHeldPrimaryBalanceProbe(scope,f.deps)).ok,true);assert.equal(f.reads,1);assert.equal(f.reserved,1);assert.equal(f.saved.length,1);
 const data=JSON.stringify(f.saved);assert.doesNotMatch(data,/secret-|secret-body|privateKey/);const s=f.saved[0] as any;
 assert.equal(s.display.cashCents,10000);assert.equal(s.display.cashMicrosExact,'100000100');assert.equal(s.display.cashDisplayRoundedDown,true);
 assert.equal(s.tradingAuthority,false);assert.equal(s.ledgerReconciliationPerformed,false);
});
test('hold, SHA, or binding drift after read prevents persistence',async()=>{
 for(const drift of ['hold','sha','binding']){const f=fixture(),get=f.deps.get;f.deps.get=async()=>{const r=await get();if(drift==='hold')f.hold(false);if(drift==='sha')f.sha('c'.repeat(40));if(drift==='binding')f.bind(false);return r;};
 assert.equal((await runHeldPrimaryBalanceProbe(scope,f.deps)).ok,false);assert.equal(f.saved.length,0);assert.equal(f.reads,1);}
});
test('scope drift during quota wait prevents signing',async()=>{const f=fixture();f.deps.reserve=async()=>{f.hold(false)};assert.equal((await runHeldPrimaryBalanceProbe(scope,f.deps)).ok,false);assert.equal(f.reads,0);});
test('credential/provider failures do not retry or expose exception',async()=>{
 for(const at of ['credentials','get'] as const){const f=fixture();let n=0;f.deps[at]=async()=>{n++;throw Error('secret-private');};const r=await runHeldPrimaryBalanceProbe(scope,f.deps);
 assert.equal(r.ok,false);assert.equal(n,1);assert.equal(f.saved.length,0);assert.doesNotMatch(JSON.stringify(r),/secret-private/);}
});
test('sanitization drops arbitrary values, unsafe integers and inherited fields',()=>{
 const value=sanitizePrimaryBalance({balance_dollars:'secret-body',balance:Number.MAX_SAFE_INTEGER+1,portfolio_value:-1,updated_ts:'private-date',headers:'private'});
 assert.deepEqual(value.values,{});assert.doesNotMatch(JSON.stringify(value),/secret-body|private-date|headers/);
 assert.deepEqual(sanitizePrimaryBalance(Object.create({balance:123})).values,{});
 for(const dollars of ['-1','1e2','1.0000001','9'.repeat(65)])assert.deepEqual(sanitizePrimaryBalance({balance_dollars:dollars}).values,{});
});
test('transport accepts exactly one exact live GET and records no headers/body',async()=>{
 let calls=0;const receipts:unknown[]=[];const f=primaryProbeFetch(async()=>{calls++;return new Response('{"balance":10000}',{status:200});},new AbortController().signal,r=>receipts.push(r));
 const url='https://external-api.kalshi.com/trade-api/v2/portfolio/balance?subaccount=0';
 for(const [u,i] of [[url,{method:'POST',redirect:'manual'}],[url.replace('subaccount=0','subaccount=1'),{method:'GET',redirect:'manual'}],[url.replace('external-api.kalshi.com','evil.test'),{method:'GET',redirect:'manual'}],[url,{method:'GET',redirect:'follow'}]] as const)await assert.rejects(()=>f(u,i));
 assert.deepEqual(await(await f(url,{method:'GET',redirect:'manual'})).json(),{balance:10000});
 await assert.rejects(()=>f(url,{method:'GET',redirect:'manual'}));assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(receipts),/balance|key|signature/);
});
test('transport refuses retry after failed provider, expired deadline, and oversize response',async()=>{
 const url='https://external-api.kalshi.com/trade-api/v2/portfolio/balance?subaccount=0',init={method:'GET',redirect:'manual'} as const;
 let calls=0;const f=primaryProbeFetch(async()=>{calls++;throw Error('secret')},new AbortController().signal,()=>{});
 await assert.rejects(()=>f(url,init));await assert.rejects(()=>f(url,init));assert.equal(calls,1);
 const expired=primaryProbeFetch(async()=>{calls++;return new Response('{}')},AbortSignal.abort(),()=>{});await assert.rejects(()=>expired(url,init));assert.equal(calls,1);
 const huge=primaryProbeFetch(async()=>new Response('x'.repeat(16385)),new AbortController().signal,()=>{});await assert.rejects(()=>huge(url,init));
});
test('SQL binds verified role to owner financial account/provider; held predicate rejects unresolved exposure',()=>{
 for(const text of ["c.role='account_setup_execution'",'c.owner_user_id=fa.user_id','c.financial_account_id=fa.id','c.provider_connection_id=pc.id','fa.user_id=a.owner_user_id','c.revoked_at IS NULL','c.verified_at IS NOT NULL',"c.verification_reason='credential_verified'"])assert.ok(PRIMARY_CREDENTIAL_SQL.includes(text));
 for(const text of ["w.state='released'",'w.arm_requested=false','a.reserved_micros=0','quantity_hundredths<>0','i.reserved_micros<>0','strata_emergency_exit_reservations'])assert.ok(HELD_PRIMARY_SQL.includes(text));
});

test('malformed money retains only reason/types, never raw injected text',async()=>{const f=fixture();f.deps.get=async()=>({balance_dollars:'secret-body',portfolio_value:0,updated_ts:123,private:'secret-body'});await runHeldPrimaryBalanceProbe(scope,f.deps);assert.doesNotMatch(JSON.stringify(f.saved),/secret-body/);assert.equal((f.saved[0] as any).display.cashReadReason,'invalid_cash');});
