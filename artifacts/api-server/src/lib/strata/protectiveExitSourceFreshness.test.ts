import test from 'node:test';
import assert from 'node:assert/strict';
import {V13_CHAMPION_PARAMETER_SET,V13_CHAMPION_PARAMETER_HASH} from '@workspace/v13-strategy';
import {protectiveExitSourceRemainingMs as remaining} from './protectiveExitSourceFreshness';
const market='KXBTC15M-SYNTHETIC';
const source={id:'synthetic',market_ticker:market,evaluated_at:'2026-11-03T00:00:00Z',
 strategy_parameter_set_id:V13_CHAMPION_PARAMETER_SET.id,strategy_parameter_hash:V13_CHAMPION_PARAMETER_HASH,
 feed_freshness:'current',btc_provider_age_ms:0,btc_receive_age_ms:0,market_age_ms:0};
const owned={sourcePaperEvaluationId:source.id,source};
test('exact persisted source and every inherited age consume the original five-second budget',()=>{
 for(const age of [0,4999,5000])assert.equal(remaining(owned,5000,age,market),5000-age);
 for(const age of [5001,6001])assert.equal(remaining(owned,5000,age,market),5000-age,'valid expiry remains distinct from invalid evidence');
 for(const age of [-1,NaN,Infinity])assert.equal(remaining(owned,5000,age,market),null);
 for(const k of ['btc_provider_age_ms','btc_receive_age_ms','market_age_ms']){
  assert.equal(remaining({...owned,source:{...source,[k]:1001}},5000,4000,market),-1);
  for(const value of [-1,NaN,Infinity,null,'0',undefined])assert.equal(remaining({...owned,source:{...source,[k]:value}},5000,0,market),null);
 }
});
test('missing, malformed, mismatched and weaker source/policy evidence fails closed',()=>{
 for(const value of [undefined,null,{},[],{...owned,sourcePaperEvaluationId:'different'}])assert.equal(remaining(value,5000,0,market),null);
 for(const patch of [{id:''},{market_ticker:'other'},{evaluated_at:'bad'},{evaluated_at:null},
  {strategy_parameter_set_id:'other'},{strategy_parameter_hash:'other'},{feed_freshness:'stale'}])
  assert.equal(remaining({...owned,source:{...source,...patch}},5000,0,market),null);
 for(const cap of [0,-1,5001,Infinity,NaN,'5000',null])assert.equal(remaining(owned,cap,0,market),null);
 assert.equal(remaining(owned,3000,2999,market),1,'stricter approved policy preserved');
 assert.equal(remaining({...owned,source:{...source,market_age_ms:Number.MAX_VALUE}},5000,Number.MAX_VALUE,market),null,'overflow is invalid, not authenticated expiry');
});
