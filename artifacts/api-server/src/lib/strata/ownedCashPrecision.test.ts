import test from "node:test";
import assert from "node:assert/strict";
import { ownedBalanceMicros, ownedCashProjection } from "./ownedCashPrecision";
import { readOwnedKalshiFeeds } from "./personalExchangeRead";
import { persistOwnedCashReconciliation, RECORD_OWNED_CASH_CONFIRMATION } from "./personalCashReconciliation";
import { normalizeKalshiMoney } from "./kalshiUserRead";

for (const [dollars, micros] of [["25.0000","25000000"],["24.4825","24482500"],["20.1627","20162700"],["0.000001","1"],["0.0000","0"]]) {
  test(`execution balance preserves exact ${dollars} dollars`, () => {
    assert.equal(ownedBalanceMicros({balance_dollars:dollars,balance:999}),micros);
  });
}
test("legacy integer cents only when fixedpoint property is absent",()=>{
  assert.equal(ownedBalanceMicros({balance:2448}),"24480000");
  assert.equal(ownedBalanceMicros({balance:"2448"}),"24480000");
  for(const invalid of [null,undefined,24.4825,"", "-1", "1e2", " 24.4825", "NaN", "0.0000001", "9007199254.740992"])
    assert.equal(ownedBalanceMicros({balance_dollars:invalid,balance:2448}),null);
  for(const invalid of [null,undefined,-1,1.1,"1.1",true,Number.MAX_SAFE_INTEGER])
    assert.equal(ownedBalanceMicros({balance:invalid}),null);
  assert.equal(ownedBalanceMicros(Object.create({balance_dollars:"25.0000"})),null);
  assert.equal(ownedBalanceMicros(Object.create({balance:2500})),null);
  assert.equal(ownedBalanceMicros(Object.assign(Object.create({balance_dollars:"bad"}),{balance:2500})),null);
  assert.equal(ownedBalanceMicros(Object.create(null,{balance_dollars:{value:"24.4825"}})),"24482500");
  assert.equal(ownedBalanceMicros({get balance_dollars(){throw Error("getter must not execute");},balance:2500}),null);
  assert.equal(ownedBalanceMicros({get balance(){throw Error("getter must not execute");}}),null);
});
test("cent projections do not hide tiny holds or overstate exact available cash",()=>{
  assert.deepEqual(ownedCashProjection("24482500","0"),{cashCents:2448,reservedCents:0,capitalRemainingCents:2448});
  assert.deepEqual(ownedCashProjection("20000","1"),{cashCents:2,reservedCents:1,capitalRemainingCents:1});
  assert.deepEqual(ownedCashProjection("29999","9999"),{cashCents:2,reservedCents:1,capitalRemainingCents:2});
  assert.deepEqual(ownedCashProjection("1","2"),{cashCents:0,reservedCents:1,capitalRemainingCents:null});
  for(const invalid of [null,undefined,"-1","1.1","9007199254740992"])
    assert.deepEqual(ownedCashProjection(invalid,invalid),{cashCents:null,reservedCents:null,capitalRemainingCents:null});
});
test("shared strict-cent financial parser is unchanged",()=>{
  assert.equal(normalizeKalshiMoney({balance_dollars:"24.4825"}).cashCents,null);
});
test("full signed-feed seam accepts exact after-fee cash and continues all scoped reads",async()=>{
  for(const dollars of ["24.4825","20.1627"]){
    const paths:string[]=[];
    const result=await readOwnedKalshiFeeds({keyId:"test",privateKey:"test"},1000,(async(_creds:unknown,path:string,query:string)=>{
      paths.push(path); assert.match(query,/subaccount=1/);assert.match(query,/exchange_index=2/);
      return path.endsWith("/balance")?{subaccount:1,exchange_index:2,balance_dollars:dollars,balance:999}:
        {orders:[],fills:[],market_positions:[],settlements:[]};
    }) as never);
    assert.equal(result.ok,true); if(result.ok)assert.equal(result.cashMicros,ownedBalanceMicros({balance_dollars:dollars}));
    assert.equal(paths.length,7);
  }
});
test("malformed authoritative cash stops scan before history reads",async()=>{
  let calls=0;
  const result=await readOwnedKalshiFeeds({keyId:"test",privateKey:"test"},1000,(async()=>{
    calls++;return {balance_dollars:"0.0000001",balance:25};
  }) as never);
  assert.deepEqual(result,{ok:false,reason:"cash_unproven"});assert.equal(calls,1);
});
test("cash reconciliation persists exact micros and marks precision without cent reconstruction",async()=>{
  let saved:unknown[]=[];
  const result=await persistOwnedCashReconciliation({query:async(sql,params)=>{
    assert.match(sql,/cash_precision_verified = true/);saved=params!;return {rows:[{id:"account"}],rowCount:1};
  }},{ownerUserId:"owner",executionAccountId:"account",confirmation:RECORD_OWNED_CASH_CONFIRMATION,
    subaccount:1,exchangeIndex:2,observedAtMs:1000,nowMs:1000,maxAgeMs:15000,
    subaccountBalance:{balance_dollars:"24.4825"},primaryBalance:{balance:999999}});
  assert.equal(result.ok,true);assert.equal(result.cashCents,2448);assert.equal(saved[2],"24482500");
});
