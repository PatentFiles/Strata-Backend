import test from 'node:test';import assert from 'node:assert/strict';
import {planFractionalIocExit} from './fractionalExitPlanner';
import {requestQuantityHundredths,formatContractHundredths,requestQuantityContractsForDisplay} from './requestQuantity';
import {encodeProductionOrder} from './transport';
const req={market:'KXBTC15M-TEST-000',side:'YES' as const,action:'SELL' as const,reduceOnly:true as const,timeInForce:'IOC' as const,clientOrderId:'v13p-11111111-1111-4111-8111-111111111111',limitMicros:456700,quantityVersion:'EXIT_HUNDREDTHS_V1' as const};
test('exact hundredths planner supports .01/.50/1.50 and micro proceeds without rounding',()=>{
 for(const q of ['1','50','150']){const p=planFractionalIocExit({ownedHundredths:q,bestBidDollars:'0.4567',bidLevels:[{priceDollars:'0.4567',availableContracts:'1.50'}],minimumExitMicros:400000});assert.equal(p.ok,true);if(!p.ok)throw Error();assert.equal(p.plan.plannedHundredths,q);assert.equal(p.plan.grossProceedsMicros,(BigInt(q)*4567n).toString());const r={...req,quantityHundredths:q};assert.equal(encodeProductionOrder(r).count,formatContractHundredths(BigInt(q)));}
});
test('depth/floor/maximum preserve exact residue, never round up',()=>{
 const p=planFractionalIocExit({ownedHundredths:'150',bestBidDollars:'0.5000',bidLevels:[{priceDollars:'0.5000',availableContracts:'0.33'},{priceDollars:'0.4000',availableContracts:'0.66'},{priceDollars:'0.3900',availableContracts:'100.00'}],minimumExitMicros:400000});assert.equal(p.ok,true);if(!p.ok)throw Error();assert.equal(p.plan.plannedHundredths,'99');assert.equal(p.plan.residualHundredths,'51');assert.equal(p.plan.grossProceedsMicros,'429000');assert.equal(p.plan.limitMicros,400000);
});
test('new quantity has one authority, SELL-only, and strict bounds; legacy whole stays intact',()=>{
 assert.equal(requestQuantityHundredths({...req,quantityHundredths:'50'}),50n);
 const {quantityVersion:_,...legacy}=req;assert.equal(requestQuantityHundredths({...legacy,contracts:2}),200n);
 for(const bad of [{...req,quantityHundredths:'50',contracts:1},{...req,quantityHundredths:'50',action:'BUY'},{...req,quantityHundredths:'50',reduceOnly:false},...['0','01','1.5','-1','100001'].map(quantityHundredths=>({...req,quantityHundredths})),{...legacy,contracts:.5},{...legacy,contracts:1,quantityVersion:undefined}])assert.throws(()=>requestQuantityHundredths(bad));
});
test('fractional quantities do not authorize malformed depth or below-floor price',()=>{
 for(const bidLevels of [[{priceDollars:'0.5000',availableContracts:'0.001'}],[{priceDollars:'0.50001',availableContracts:'1.00'}],[{priceDollars:'0.5000',availableContracts:'1.00'},{priceDollars:'0.5000',availableContracts:'1.00'}]])assert.equal(planFractionalIocExit({ownedHundredths:'1',bestBidDollars:'0.5000',bidLevels,minimumExitMicros:400000}).ok,false);
});

test('UI quantity uses exact validated source for legacy and fractional requests, invalid stays unknown',()=>{
 assert.equal(requestQuantityContractsForDisplay({...req,quantityHundredths:'1'}),.01);
 assert.equal(requestQuantityContractsForDisplay({...req,quantityHundredths:'150'}),1.5);
 assert.equal(requestQuantityContractsForDisplay({contracts:2}),2);
 assert.equal(requestQuantityContractsForDisplay({...req,contracts:2,quantityHundredths:'150'}),null);
});
