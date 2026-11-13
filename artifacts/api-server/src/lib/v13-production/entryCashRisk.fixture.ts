/** Offline fixtures only: use the real metadata/book fee constructor, never a
 * guard bypass or a fabricated cheaper cash-alignment model. */
import {ownedMarketEvidence} from '../strata/personalExchangeRead';
export function entryCashRiskFeeFixture(input:{now:number;market:string;side:'YES'|'NO';price:number;contracts:number;
 policyHash:string;policyVersion?:string;sourceUrl?:string;formulaVersion?:string}){
 const {now,market,side,price,contracts}=input,event=market+'-EVENT';
 const ownBid=Math.max(.0001,Math.round((price-.01)*10000)/10000),opposite=1-price;
 const yes=side==='YES'?ownBid:opposite,no=side==='NO'?ownBid:opposite;
 return ownedMarketEvidence({market,side,bookPayload:{orderbook_fp:{yes_dollars:[[yes.toFixed(4),contracts.toFixed(2)]],no_dollars:[[no.toFixed(4),contracts.toFixed(2)]]}},
  seriesPayload:{series:{ticker:'KXBTC15M',exchange_index:2,fee_type:'quadratic',fee_multiplier:'1'}},
  marketPayload:{market:{ticker:market,event_ticker:event,exchange_index:2,status:'active',price_level_structure:'deci_cent',
   close_time:new Date(now+900000).toISOString(),expiration_time:new Date(now+960000).toISOString(),latest_expiration_time:new Date(now+960000).toISOString(),expected_expiration_time:new Date(now+960000).toISOString()}},
  eventPayload:{event:{event_ticker:event,series_ticker:'KXBTC15M',exchange_index:2,fee_type_override:null,fee_multiplier_override:null}},
  seriesChangesPayload:{series_fee_change_arr:[],cursor:''},eventChangesPayload:{event_fee_changes:[],cursor:''},
  observedAtMs:now,nowMs:now,configuredStakeCents:Math.ceil(contracts*price*100-1e-8),
  policyVersion:input.policyVersion??'test-fees',sourceUrl:input.sourceUrl??'https://invalid.test/fees',formulaVersion:input.formulaVersion??'test-v1',
  artifactDigest:'b'.repeat(64),policyHash:input.policyHash,verifiedAtMs:now}).fee;
}
