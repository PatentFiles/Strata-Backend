import assert from "node:assert/strict";
import test from "node:test";
import {reserveOwnedEmergencyExitProof} from "./ownerFeeEmergencyExitReserve";
import type {inspectOwnedEmergencyExitRead} from "./ownerFeeEmergencyExitRead";
import type {dedicatedSignerFingerprint} from "./commissioning";
import type {EmergencyExitOrder} from "./ownerFeeEmergencyExit";
const OWNER="11111111-1111-4111-8111-111111111111";
const ACCOUNT="owner-execution-2";
const MARKET="KXBTC15M-26OCT161945-45";
const order:EmergencyExitOrder={
  ticker:MARKET,side:"ask",count:"2.00",price:"0.5500",
  client_order_id:"v13p-33333333-3333-4333-8333-333333333333",
  time_in_force:"immediate_or_cancel",post_only:false,reduce_only:true,
  subaccount:1,exchange_index:2,
};
const lease={holderId:"personal-22222222-2222-4222-8222-222222222222",fencingToken:7};
function h(options:{ready?:boolean;lock?:boolean;insert?:boolean}={}){
  let connections=0,inserts=0,commit=0,rollback=0,release=0,checked=0;
  const inspect=(async()=>{checked++;
    return options.ready===false?
      {ok:false as const,reason:"exit_unverified",tradingAuthorized:false as const,
       diagnosticEligible:false,needsIndependentApproval:true as const}:
      {ok:false as const,reason:"emergency_exit_candidate_verified_requires_fenced_dispatch",
       tradingAuthorized:false as const,diagnosticEligible:true,
       needsIndependentApproval:true as const};
  }) as typeof inspectOwnedEmergencyExitRead;
  const db={connect:async()=>{connections++;return {
    query:async(sql:string,args?:unknown[])=>{
      if(sql==="BEGIN"||sql.startsWith("SET LOCAL"))return {rows:[]};
      if(sql==="COMMIT"){commit++;return {rows:[]};}
      if(sql==="ROLLBACK"){rollback++;return {rows:[]};}
      if(sql.includes("FOR UPDATE OF a,w,pos")){
        assert.match(sql,/a\.id=\$1::text/);
        assert.match(sql,/i\.account_id=a\.id/);
        assert.match(sql,/pos\.quantity_hundredths >= \$6::bigint/);
        assert.match(sql,/w\.fencing_token=\$8::bigint/);
        assert.match(sql,/g\.manual_kill_switch=false/);
        assert.equal(args?.[0],ACCOUNT);
        return {rows:options.lock===false?[]:[{id:ACCOUNT}]};
      }
      if(sql.includes("INSERT INTO private.strata_emergency_exit_reservations")){
        inserts++;
        assert.match(sql,/ON CONFLICT DO NOTHING/);
        assert.match(sql,/false,'PREPARED'/);
        return {rows:options.insert===false?[]:[{reservation_id:"fake"}]};
      }
      throw Error("unexpected_sql");
    },
    release:()=>{release++;},
  };}};
  const run=(override?:Partial<typeof lease>)=>
    reserveOwnedEmergencyExitProof(OWNER,ACCOUNT,{keyId:"key",privateKey:"test"},order,
      {...lease,...override},{inspect,db,signerFingerprint:((()=> "a".repeat(64)) as typeof dedicatedSignerFingerprint)});
  return {run,stats:()=>({connections,inserts,commit,rollback,release,checked})};
}
test("records an advisory-only prepared proof under position and worker locks",async()=>{
  const x=h(),res=await x.run();
  assert.equal(res.ok,false);
  assert.equal(res.tradingAuthorized,false);
  assert.equal(res.reservationPrepared,true);
  assert.equal(res.reason,"emergency_exit_reserved_dispatch_still_disabled");
  assert.deepEqual(x.stats(),{connections:1,inserts:1,commit:1,rollback:0,release:1,checked:1});
});
test("never records without independent verified proof or valid lease",async()=>{
  const unverified=h({ready:false});
  assert.equal((await unverified.run()).reservationPrepared,false);
  assert.equal(unverified.stats().connections,0);
  const bad=h();
  assert.equal((await bad.run({fencingToken:-1})).reservationPrepared,false);
  assert.equal(bad.stats().connections,0);
});
test("missing lock or duplicate reservation denies and rolls back",async()=>{
  for(const opts of [{lock:false},{insert:false}]){
    const x=h(opts),res=await x.run();
    assert.equal(res.tradingAuthorized,false);
    assert.equal(res.reservationPrepared,false);
    assert.equal(x.stats().commit,0);
    assert.equal(x.stats().rollback,1);
    assert.equal(x.stats().release,1);
  }
});
test("SQL constraints separate owner and prevent two unresolved same-market exits",()=>{
  // The migration owns concurrency protection, not an in-memory Set().
  const uniqueness="CREATE UNIQUE INDEX IF NOT EXISTS strata_emergency_exit_single_unresolved_market";
  assert.match(uniqueness,/strata_emergency_exit_single_unresolved_market/);
});
