import {economicDischargeFixture as fixture} from './economicExitDischargeFixture';
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {digest} from '../v13-production/types';
import {proveEconomicDischarge,economicDischargePlan,verifyEconomicTransferCut} from './economicExitDischargeEvidence';

test('booked, fully paid binary market can discharge only modeled reserve; transport truth unchanged',()=>{
 const f=fixture(),before=structuredClone(f),p=economicDischargePlan(proveEconomicDischarge(f));
 assert.equal(p.releaseReserveMicros,'3000000');assert.equal(p.cashMicros,'31477500');assert.equal(p.transportOutcome,'UNKNOWN');assert.equal(p.tradingAuthorized,false);
 assert.deepEqual(f,before);assert.throws(()=>economicDischargePlan({...proveEconomicDischarge(f)}));
});
for(const [name,mutate] of [
 ['not finalized',(f:ReturnType<typeof fixture>)=>{f.market.status='determined';}],
 ['disputed',(f:ReturnType<typeof fixture>)=>{f.market.status='disputed';}],
 ['scalar',(f:ReturnType<typeof fixture>)=>{f.market.market_type='scalar';}],
 ['different result',(f:ReturnType<typeof fixture>)=>{f.market.result='yes';}],
 ['wrong settlement clock',(f:ReturnType<typeof fixture>)=>{f.market.settlement_ts=new Date(1).toISOString();}],
 ['wrong market',(f:ReturnType<typeof fixture>)=>{f.market.ticker='KXBTC15M-OTHER';}],
 ['wrong exchange',(f:ReturnType<typeof fixture>)=>{f.market.exchange_index=1;}],
 ['wrong payout value',(f:ReturnType<typeof fixture>)=>{f.market.settlement_value_dollars='1.0000';}],
 ['close after settlement',(f:ReturnType<typeof fixture>)=>{f.market.close_time=new Date(f.nowMs+1).toISOString();}],
 ['stale signed evidence',(f:ReturnType<typeof fixture>)=>{f.nowMs+=5001;}],
 ['receipt digest',(f:ReturnType<typeof fixture>)=>{f.booking.payload_digest='0'.repeat(64);}],
 ['another owner',(f:ReturnType<typeof fixture>)=>{f.booking.owner_user_id=randomUUID();}],
 ['another account',(f:ReturnType<typeof fixture>)=>{f.booking.execution_account_id='foreign';}],
 ['receipt does not preserve unknown',(f:ReturnType<typeof fixture>)=>{f.booking.transport_outcome='RECONCILED';}],
 ['settlement not actually booked',(f:ReturnType<typeof fixture>)=>{f.history.events.pop();}],
 ['wrong event payload',(f:ReturnType<typeof fixture>)=>{f.history.events.at(-1)!.payload={};}],
 ['wrong current cash',(f:ReturnType<typeof fixture>)=>{f.account.cash_micros='99999999';}],
 ['unrelated capital adjustment',(f:ReturnType<typeof fixture>)=>{f.account.initial_cash_micros='29999999';}],
 ['reserve already gone',(f:ReturnType<typeof fixture>)=>{f.account.reserved_micros='0';}],
 ['other reserve',(f:ReturnType<typeof fixture>)=>{f.history.rows[1]!.reserved_micros='1';}],
 ['position reopened',(f:ReturnType<typeof fixture>)=>{f.history.positions[0]!.quantity_hundredths='1';}],
 ['new transfer since settlement',(f:ReturnType<typeof fixture>)=>{f.transfers.subaccount=[{transfer_id:'synthetic',from_subaccount:0,to_subaccount:1,exchange_index:2,amount_cents:1,created_ts:Math.floor(f.nowMs/1000)}];}],
 ['pending cross-exchange transfer',(f:ReturnType<typeof fixture>)=>{f.transfers.crossExchange=[{transfer_id:'synthetic',status:'pending',created_ts:1,source_exchange_shard:0,destination_exchange_shard:2}];}],
 ['incomplete transfer pagination',(f:ReturnType<typeof fixture>)=>{f.transfers.complete=false;}],
] as const)test('economic discharge refuses '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>proveEconomicDischarge(f));});
test('complete historical transfer evidence is deterministic and duplicate IDs are rejected',()=>{
 const x={complete:true,subaccount:[{transfer_id:'old-sub',from_subaccount:0,to_subaccount:1,exchange_index:2,amount_cents:2500,created_ts:1}],crossExchange:[{transfer_id:'old-cross',status:'complete',source_exchange_shard:0,destination_exchange_shard:2,created_ts:1}]};
 assert.equal(verifyEconomicTransferCut(x,5000),digest(x));x.crossExchange.push({...x.crossExchange[0]});assert.throws(()=>verifyEconomicTransferCut(x,5000));
});