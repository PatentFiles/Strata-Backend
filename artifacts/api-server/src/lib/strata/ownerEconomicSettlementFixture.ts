/** Synthetic private-ledger fixture; never an exchange credential or live account. */
import {createHash} from 'node:crypto';
import {digest,type Request,type Fill,type Settlement,type Snapshot} from '../v13-production/types';
import type {EconomicSettlementInput} from './ownerEconomicSettlementProof';
export function economicSettlementFixture(now=1_700_000_100_000):EconomicSettlementInput {
 const owner='11111111-1111-4111-8111-111111111111',account='fixture-economic';
 const parentId='22222222-2222-4222-8222-222222222222',exitId='33333333-3333-4333-8333-333333333333',reservationId='44444444-4444-4444-8444-444444444444';
 const request:Request={clientOrderId:`v13p-${parentId}`,market:'KXBTC15M-SYNTHETIC',side:'NO',action:'BUY',reduceOnly:false,timeInForce:'IOC',contracts:3,limitMicros:510000};
 const exitRequest:Request={...request,clientOrderId:`v13p-${exitId}`,action:'SELL',reduceOnly:true,limitMicros:100000};
 const common={account_id:account,market:request.market,side:'NO',decision:{source:'synthetic'},policy_hash:'policy',fee_fingerprint:'fee',created_at:new Date(now-30000)};
 const parent={...common,id:parentId,kind:'ENTRY',state:'TERMINAL',terminal:true,parent_id:null,filled_hundredths:'300',reserved_micros:'3000000',exit_fee_micros:'3000000',exchange_order_id:'synthetic-order',client_order_id:request.clientOrderId,request,dispatch_at:new Date(now-25000),capability_digest:''};
 const exit={...common,id:exitId,kind:'EXIT',state:'DISPATCHED',terminal:false,parent_id:parentId,filled_hundredths:'0',reserved_micros:'0',exit_fee_micros:'0',exchange_order_id:null,client_order_id:exitRequest.clientOrderId,request:exitRequest,dispatch_at:new Date(now-15000),capability_digest:''};
 for(const row of [parent,exit])row.capability_digest=digest({id:row.id,request:row.request,decision:row.decision,policyHash:row.policy_hash,fee:row.fee_fingerprint});
 const fill:Fill={id:'synthetic-fill',orderId:'synthetic-order',clientOrderId:request.clientOrderId,market:request.market,side:'NO',action:'BUY',quantityHundredths:'300',priceMicros:490000,grossMicros:'1470000',feeMicros:'52500',occurredAtMs:now-20000};
 const time=new Date(now-10000).toISOString();const settlement:Settlement={id:`${request.market}:${time}`,market:request.market,side:'NO',result:'NO',quantityHundredths:'300',payoutMicros:'3000000',feeMicros:'0',occurredAtMs:now-10000};
 const order_request_json=JSON.stringify({client_order_id:exitRequest.clientOrderId,ticker:request.market,subaccount:1,exchange_index:2,
  reduce_only:true,post_only:false,time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',side:'bid',count:'3.00',price:'0.9000'});
 const order_digest=createHash('sha256').update(order_request_json).digest('hex');
 const snapshot:Snapshot={identity:{subaccount:1,exchangeIndex:2,keyFingerprint:'a'.repeat(64)},authenticated:true,complete:true,cashExact:true,unexplainedCashActivity:false,cashMicros:'31477500',observedAtMs:now,historyFromMs:0,orders:[{orderId:'synthetic-order',request,terminal:true,filledHundredths:'300'}],fills:[fill],settlements:[settlement],positions:[]};
 return {account:{id:account,owner_user_id:owner,subaccount:1,exchange_index:2,key_fingerprint:'a'.repeat(64),revision:'17',initial_cash_micros:'30000000',cash_micros:'28477500',reserved_micros:'3000000'},
  history:{rows:[parent,exit],requests:[request,exitRequest],expectedRequests:[request,exitRequest],neverPosted:[],historyDigest:'synthetic',reconciliationDigest:'synthetic',accountingOnlyExitClients:[],receipts:[],
   events:[{account_id:account,event_id:`fill:${fill.id}`,intent_id:parentId,kind:'FILL',payload:fill,digest:digest(fill),cash_delta_micros:'-1522500',pnl_micros:'0',occurred_at:new Date(fill.occurredAtMs)}],
   positions:[{id:parentId,account_id:account,market:request.market,side:'NO',quantity_hundredths:'300',basis_micros:'1522500',realized_pnl_micros:'0'}],
   markers:[{order_request_json,order_digest,reservation_id:reservationId,owner_user_id:owner,execution_account_id:account,state:'UNKNOWN',trading_authorized:false,client_order_id:exitRequest.clientOrderId,market_ticker:request.market,reducing_side:'NO',quantity_hundredths:'300'}]},
  snapshot,exitId,reservationId,nowMs:now,
  rawSettlement:{ticker:request.market,exchange_index:2,market_result:'no',no_count_fp:'3.00',yes_count_fp:'0.00',no_total_cost_dollars:'1.470000',yes_total_cost_dollars:'0.000000',revenue:300,fee_cost:'0.052500',settled_time:time},
  rawPosition:{ticker:request.market,exchange_index:2,position_fp:'0.00',total_traded_dollars:'1.470000',realized_pnl_dollars:'1.530000'}};
}