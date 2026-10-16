import assert from "node:assert/strict";
import test from "node:test";
import {readExactEmergencyFeeEvidence} from "./ownerFeeEmergencyExitMarket";
const TICKER="KXBTC15M-26OCT161945-45";
const EVENT="KXBTC15M-26OCT161945";
const NOW=Date.parse("2026-10-16T19:45:00Z");
function fixture(overrides:{status?:string;ticker?:string;index?:number;overrideFee?:unknown;
  scheduled?:string;redirect?:boolean;seriesFee?:string;fail?:boolean}={}){
  const expires=new Date(NOW+900000).toISOString();
  const eventTicker=EVENT;
  const payloads:Record<string,unknown>={
    ["/markets/"+TICKER]:{market:{
      ticker:overrides.ticker??TICKER,event_ticker:eventTicker,
      status:overrides.status??"open",exchange_index:overrides.index??2,
      close_time:expires,expiration_time:expires,
      latest_expiration_time:expires,expected_expiration_time:expires,
    }},
    ["/events/"+EVENT]:{event:{event_ticker:EVENT,series_ticker:"KXBTC15M",
      fee_type_override:overrides.overrideFee??null,fee_multiplier_override:null}},
    "/series/KXBTC15M":{series:{ticker:"KXBTC15M",fee_type:overrides.seriesFee??"quadratic",
      fee_multiplier:1}},
    "/series/fee_changes?series_ticker=KXBTC15M&show_historical=false&limit=100":{
      series_fee_change_arr:overrides.scheduled?[{id:"scheduled",scheduled_ts:overrides.scheduled}]:[],cursor:""},
    ["/events/fee_changes?event_ticker="+EVENT+"&show_historical=false&limit=100"]:{
      event_fee_changes:[],cursor:""},
  };
  const calls:string[]=[];
  const transport=(async(request:RequestInfo|URL,init?:RequestInit)=>{
    const u=String(request);
    calls.push(u);
    if(init?.method!=="GET")throw Error("unexpected mutation");
    const path=u.replace("https://api.elections.kalshi.com/trade-api/v2","");
    if(overrides.fail||!(path in payloads))return new Response("denied",{status:503});
    const response=new Response(JSON.stringify(payloads[path]),{status:200,
      headers:{"content-type":"application/json"}});
    if(overrides.redirect){Object.defineProperty(response,"url",{value:"https://example.com/mismatch"});}
    return response;
  }) as typeof fetch;
  return {transport,calls};
}
test("exact named market open and unmodified fees give only read-only metadata",async()=>{
  const f=fixture();
  const answer=await readExactEmergencyFeeEvidence(TICKER,()=>NOW,f.transport);
  assert.equal(answer.ok,true);
  if(answer.ok){
    assert.equal(answer.marketTicker,TICKER);
    assert.equal(answer.marketOpen,true);
    assert.match(answer.fingerprint,/^[0-9a-f]{64}$/);
  }
  assert.equal(f.calls.length,5);
  assert.ok(f.calls.every(url=>url.startsWith("https://api.elections.kalshi.com/trade-api/v2")));
});
test("closed, wrong ticker or exchange and fee overrides reject",async()=>{
  for(const v of [{status:"closed"},{ticker:"KXBTC15M-OTHER"},{index:0},
    {overrideFee:"flat"},{seriesFee:"flat"},
    {scheduled:new Date(NOW+30000).toISOString()},{fail:true},{redirect:true}]){
    const f=fixture(v);
    const answer=await readExactEmergencyFeeEvidence(TICKER,()=>NOW,f.transport);
    assert.equal(answer.ok,false,JSON.stringify(v));
  }
});
test("rejects malformed ticker and stale/missing exact fee data",async()=>{
  const f=fixture();
  assert.equal((await readExactEmergencyFeeEvidence("KXBTC15M-../NOTMARKET",()=>NOW,f.transport)).ok,false);
  let called=0;
  const time=()=>NOW+(called++?3001:0);
  assert.equal((await readExactEmergencyFeeEvidence(TICKER,time,f.transport)).ok,false);
});
