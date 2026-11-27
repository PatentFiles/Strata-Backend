import test from 'node:test';import assert from 'node:assert/strict';
import {assertAuthorizedEntrySourceReference} from '../v13-production/sourceReference';
import {WARREN_BOT,WARREN_BOT_HASH} from './warrenBotIdentity';
const now=Date.parse('2026-11-27T01:00:12Z');
const warren=()=>({
 bot_strategy_id:WARREN_BOT,bot_spec_hash:WARREN_BOT_HASH,
 warren_crossing:{market:'KXBTC15M-VALID-01',target:100000,direction:'UP',
  crossedAtMs:now-5000,expiresAtMs:now+10000,previousBuffer:-2,crossingBuffer:3},
 market_ticker:'KXBTC15M-VALID-01',market_close_ms:now+890000,evaluated_at:new Date(now).toISOString(),
 btc_price:100010,target:100000,signed_buffer:10,velocity:100,previous_side:'UP',
 up_offer:0.51,down_offer:0.49,entry_offer:0.51,signal:'SCOUT',direction:'UP',
 fresh_cross:false,qualifying_trigger:true,crossing_consumed:true,position_was_open:false,feed_freshness:'current',
});
test('authentic pending UP crossing can qualify without fabricating a fresh cross',()=>{
 const decision=assertAuthorizedEntrySourceReference(warren());
 assert.equal(decision.signal,'SCOUT');assert.equal(decision.freshCross,false);
});
test('Warren evidence is refused for wrong identity, expired crossing or adverse velocity',()=>{
 for(const change of [{bot_spec_hash:'x'},{velocity:-5},{up_offer:0.55,entry_offer:0.55},
  {warren_crossing:{...warren().warren_crossing,crossedAtMs:now-20000,expiresAtMs:now-5000}},
  {fresh_cross:true}])assert.throws(()=>assertAuthorizedEntrySourceReference({...warren(),...change}));
});
