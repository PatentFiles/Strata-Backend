import test from 'node:test';import assert from 'node:assert/strict';
import {requiredTradingCapitalCents,protectedTransferCash,automaticTransferAmount,exactCashMicros,fundedCapitalBasis} from './cashTransferPolicy';
for(const stake of [500,1500,2500,5000,10000,15000,20000,25000,50000])test(`saved ${stake} cent stake preserves exactly five times capital`,()=>{
 assert.equal(requiredTradingCapitalCents(stake),stake*5);
 const cash=BigInt(stake*5)*10000n+1234567n;
 const r=protectedTransferCash({stakeCents:stake,ownerRetainCents:0,cashMicros:String(cash),reservedMicros:'0'});
 assert.equal(r.minimumRetainedCents,stake*5);assert.equal(r.maximumCents,123);
 assert.equal(automaticTransferAmount('excess',100,r.maximumCents),123);
});
test('reserved cash and a higher owner minimum are never swept; fractional cents remain',()=>{
 assert.deepEqual(protectedTransferCash({stakeCents:500,ownerRetainCents:3000,cashMicros:'35012345',reservedMicros:'2000000'}),{requiredCapitalCents:2500,minimumRetainedCents:3000,maximumCents:301});
 assert.equal(protectedTransferCash({stakeCents:25000,ownerRetainCents:0,cashMicros:'1250000000',reservedMicros:'0'}).maximumCents,0);
 assert.equal(automaticTransferAmount('fixed_amount',200,199),0);
});
test('invalid evidence never becomes a zero floor',()=>{
 for(const v of [undefined,null,0,499,500.5,NaN,Infinity,'5e2','0500',-500])assert.throws(()=>requiredTradingCapitalCents(v));
 assert.throws(()=>protectedTransferCash({stakeCents:500,ownerRetainCents:0,cashMicros:'1',reservedMicros:'2'}));
});
test('nested/outer account contradictions and sub-micro dollars fail closed',()=>{
 assert.equal(exactCashMicros({subaccount:0,balance:{subaccount:1,balance_dollars:'5.00'}},1,2),null);
 assert.equal(exactCashMicros({balance_dollars:'25.123456'},1,2),25123456n);
 assert.equal(exactCashMicros({balance_dollars:'25.1234567'},1,2),null);
 assert.equal(exactCashMicros({balance_dollars:25},1,2),null);
});
test('deposits and withdrawals change net capital, never original opening basis or trading P&L',()=>{
 assert.equal(fundedCapitalBasis({initial_cash_micros:'25000000',net_funding_micros:'100000000'}),125000000n);
 assert.equal(fundedCapitalBasis({initial_cash_micros:'100000000',net_funding_micros:'-75000000'}),25000000n);
});
