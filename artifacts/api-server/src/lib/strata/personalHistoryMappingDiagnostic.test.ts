import test from 'node:test';
import assert from 'node:assert/strict';
import {personalAccountSnapshot,type OwnedKalshiRead} from './personalExchangeRead';
import {historyMappingDiagnostic} from './personalHistoryMappingDiagnostic';
import type {Request} from '../v13-production/types';

const request:Request={market:'KXBTC15M-DIAGNOSTIC-FIXTURE',side:'YES',action:'BUY',contracts:3,
 limitMicros:510000,timeInForce:'IOC',reduceOnly:false,clientOrderId:'synthetic-client'};
const identity={subaccount:1,exchangeIndex:2,keyFingerprint:'synthetic-fingerprint'};
const at=Date.parse('2026-11-27T05:45:00Z');
function fixture():OwnedKalshiRead {return {ok:true,historicalCoverageComplete:true,observedAtMs:at,
 cashMicros:'26567800',orders:[{order_id:'synthetic-order',client_order_id:request.clientOrderId,
 ticker:request.market,status:'executed',book_side:'bid',side:'yes',action:'buy',
 yes_price_dollars:'0.5100',no_price_dollars:'0.4900',initial_count_fp:'3.00',fill_count_fp:'3.00'}],
 fills:[{order_id:'synthetic-order',trade_id:'synthetic-fill',ticker:request.market,count_fp:'3.00',
 yes_price_dollars:'0.4600',no_price_dollars:'0.5400',fee_cost:'0.052200',
 created_time:'2026-11-27T05:15:38.438691Z',ts:1795756538}],
 positions:[{ticker:request.market,position_fp:'0.00'}],settlements:[{ticker:request.market,
 yes_count_fp:'3.00',no_count_fp:'0.00',market_result:'yes',revenue:300,
 settled_time:'2026-11-27T05:30:05.920121Z'}]};}
const map=(read:OwnedKalshiRead)=>personalAccountSnapshot(identity,read,[request]);
const failed={ok:false,reason:'personal_exchange_history_unreconciled'};

test('incident-shaped improved-price fill and winning settlement remain exact and map without a parser relaxation',()=>{
 const result=map(fixture());assert.ok('identity' in result);if(!('identity' in result))return;
 assert.equal(result.orders[0]!.filledHundredths,'300');assert.equal(result.fills[0]!.grossMicros,'1380000');
 assert.equal(result.fills[0]!.feeMicros,'52200');assert.equal(result.settlements[0]!.payoutMicros,'3000000');
 assert.equal(3000000n-1380000n-52200n,1567800n);assert.equal(result.cashMicros,'26567800');
 assert.deepEqual(result.positions,[]);assert.equal(historyMappingDiagnostic(result),null);
});
test('temporarily unmatched fill is refused, later complete original order maps; no request can be manufactured',()=>{
 const first=fixture();first.orders=[];const refused=map(first);assert.deepEqual(refused,failed);
 assert.equal(historyMappingDiagnostic(refused)?.stage,'fill_order');
 const later=map(fixture());assert.ok('identity' in later);if('identity' in later)
  assert.equal(later.orders[0]!.request,request);
 assert.equal(first.orders.length,0,'refused source was not silently repaired');
});
test('fixed diagnostics identify the rejected field while retaining exact historical public errors',()=>{
 const variants:Array<[string,(r:OwnedKalshiRead)=>void]>=[
  ['history_coverage',r=>{r.historicalCoverageComplete=false;}],
  ['order_request',r=>{(r.orders[0] as Record<string,unknown>).client_order_id='foreign';}],
  ['order_status',r=>{(r.orders[0] as Record<string,unknown>).status='unexpected';}],
  ['order_market',r=>{(r.orders[0] as Record<string,unknown>).ticker='foreign';}],
  ['order_book_side',r=>{(r.orders[0] as Record<string,unknown>).book_side='ask';}],
  ['order_limit',r=>{(r.orders[0] as Record<string,unknown>).yes_price_dollars='0.1234';}],
  ['order_quantity',r=>{(r.orders[0] as Record<string,unknown>).initial_count_fp='4.00';}],
  ['order_identity',r=>{(r.orders[0] as Record<string,unknown>).order_id=null;}],
  ['fill_identity',r=>{r.fills.push({...r.fills[0] as Record<string,unknown>});}],
  ['fill_quantity',r=>{(r.fills[0] as Record<string,unknown>).count_fp='0.00';}],
  ['fill_price',r=>{(r.fills[0] as Record<string,unknown>).yes_price_dollars='invalid';}],
  ['fill_fee',r=>{(r.fills[0] as Record<string,unknown>).fee_cost='invalid';}],
  ['fill_time',r=>{(r.fills[0] as Record<string,unknown>).created_time='invalid';}],
  ['fill_market',r=>{(r.fills[0] as Record<string,unknown>).ticker='foreign';}],
  ['settlement_contract',r=>{(r.settlements[0] as Record<string,unknown>).market_result='invalid';}],
  ['settlement_payout',r=>{(r.settlements[0] as Record<string,unknown>).revenue=-1;}],
  ['position_record',r=>{(r.positions[0] as Record<string,unknown>).position_fp='invalid';}],
 ];
 for(const [expected,change] of variants){const read=fixture();change(read);const out=map(read);
  assert.deepEqual(out,failed,expected);const diagnostic=historyMappingDiagnostic(out);
  assert.equal(diagnostic?.stage,expected);assert.ok(Object.isFrozen(diagnostic));
  assert.equal(JSON.stringify(diagnostic).includes(request.clientOrderId),false);
  assert.deepEqual(Object.keys(out).sort(),['ok','reason']);
  assert.equal(historyMappingDiagnostic(JSON.parse(JSON.stringify(out))),null,'client JSON is not diagnostic custody');
 }
});
test('reduce-only false remains a hard mismatch for a protective request',()=>{
 const read=fixture(),exit={...request,action:'SELL' as const,reduceOnly:true};
 Object.assign(read.orders[0] as Record<string,unknown>,{book_side:'ask',action:'sell',reduce_only:false});
 const out=personalAccountSnapshot(identity,read,[exit]);assert.deepEqual(out,failed);
 assert.equal(historyMappingDiagnostic(out)?.stage,'order_reduce_only');
});
