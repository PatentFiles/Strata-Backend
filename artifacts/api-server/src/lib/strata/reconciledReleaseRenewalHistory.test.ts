import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../v13-production/types';
import {verifyReconciledReleaseRenewalSnapshot as verify} from './reconciledReleaseRenewalHistory';
function fixture(){
 const at=1200000000000,request={clientOrderId:'v13p-parent',market:'KXBTC15M-SYNTHETIC',side:'YES',action:'BUY',reduceOnly:false,timeInForce:'IOC',contracts:2,limitMicros:500000};
 const parent:any={id:'parent',account_id:'synthetic',kind:'ENTRY',state:'TERMINAL',market:request.market,side:'YES',filled_hundredths:'200',exchange_order_id:'order',client_order_id:request.clientOrderId,request};
 const fill:any={id:'fill',orderId:'order',clientOrderId:request.clientOrderId,market:request.market,side:'YES',action:'BUY',quantityHundredths:'200',priceMicros:500000,grossMicros:'1000000',feeMicros:'50000',occurredAtMs:at-20000};
 const settlement:any={id:'settlement',market:request.market,side:'YES',result:'YES',quantityHundredths:'200',payoutMicros:'2000000',feeMicros:'0',occurredAtMs:at-10000};
 const snapshot:any={identity:{subaccount:1,exchangeIndex:2,keyFingerprint:'synthetic'},authenticated:true,complete:true,cashExact:true,unexplainedCashActivity:false,cashMicros:'25000000',observedAtMs:at,historyFromMs:0,
  orders:[{orderId:'order',request,terminal:true,filledHundredths:'200'}],fills:[fill],settlements:[settlement],positions:[]};
 const history:any={rows:[parent],requests:[request],expectedRequests:[request],neverPosted:[],events:[],positions:[],markers:[],historyDigest:'synthetic',reconciliationDigest:'synthetic'};
 const refresh=()=>{
  const cost=BigInt(fill.grossMicros)+BigInt(fill.feeMicros),cash=BigInt(settlement.payoutMicros)-BigInt(settlement.feeMicros),pnl=cash-cost;
  history.events=[{account_id:'synthetic',event_id:'fill:fill',intent_id:'parent',kind:'FILL',payload:{...fill},digest:digest(fill),cash_delta_micros:String(-cost),pnl_micros:'0',occurred_at:new Date(fill.occurredAtMs)},
   {account_id:'synthetic',event_id:'settlement:settlement',intent_id:'parent',kind:'SETTLEMENT',payload:{...settlement},digest:digest(settlement),cash_delta_micros:String(cash),pnl_micros:String(pnl),occurred_at:new Date(settlement.occurredAtMs)}];
  history.positions=[{id:'parent',realized_pnl_micros:String(pnl)}];
 };
 refresh();return {history,snapshot,parent,fill,settlement,refresh};
}
test('exact settled history accepts winning and losing settlement without authority writes',()=>{
 for(const won of [true,false]){const f=fixture();if(!won){f.settlement.result='NO';f.settlement.payoutMicros='0';f.refresh();}assert.doesNotThrow(()=>verify(f.history,f.snapshot));}
});
for(const [name,change] of [
 ['price above sealed BUY limit',(f:ReturnType<typeof fixture>)=>{f.fill.priceMicros=600000;f.fill.grossMicros='1200000';}],
 ['incorrect gross',(f:ReturnType<typeof fixture>)=>{f.fill.grossMicros='999999';}],
 ['negative fee',(f:ReturnType<typeof fixture>)=>{f.fill.feeMicros='-1';}],
 ['future fill',(f:ReturnType<typeof fixture>)=>{f.fill.occurredAtMs=f.snapshot.observedAtMs+1;}],
 ['settlement before fill',(f:ReturnType<typeof fixture>)=>{f.settlement.occurredAtMs=f.fill.occurredAtMs-1;}],
 ['winning payout inflated',(f:ReturnType<typeof fixture>)=>{f.settlement.payoutMicros='2000001';}],
 ['losing payout nonzero',(f:ReturnType<typeof fixture>)=>{f.settlement.result='NO';f.settlement.payoutMicros='1';}],
 ['settlement fee invented',(f:ReturnType<typeof fixture>)=>{f.settlement.feeMicros='1';}],
 ['wrong filled order',(f:ReturnType<typeof fixture>)=>{f.fill.orderId='other';}],
 ['wrong fill side',(f:ReturnType<typeof fixture>)=>{f.fill.side='NO';}],
 ['wrong fill market',(f:ReturnType<typeof fixture>)=>{f.fill.market='KXBTC15M-OTHER';}],
 ['settlement quantity mismatch',(f:ReturnType<typeof fixture>)=>{f.settlement.quantityHundredths='100';f.settlement.payoutMicros='1000000';}],
] as const)test('reject self-consistent ledger with '+name,()=>{const f=fixture();change(f);f.refresh();assert.throws(()=>verify(f.history,f.snapshot));});
for(const [name,change] of [
 ['extra balanced local event',(f:ReturnType<typeof fixture>)=>{f.history.events.push({...f.history.events[0],event_id:'extra',cash_delta_micros:'0',pnl_micros:'0'});}],
 ['event payload changed',(f:ReturnType<typeof fixture>)=>{f.history.events[0].payload={};}],
 ['event digest changed',(f:ReturnType<typeof fixture>)=>{f.history.events[0].digest='wrong';}],
 ['event target changed',(f:ReturnType<typeof fixture>)=>{f.history.events[0].intent_id='other';}],
 ['event kind changed',(f:ReturnType<typeof fixture>)=>{f.history.events[0].kind='SETTLEMENT';}],
 ['event timestamp changed',(f:ReturnType<typeof fixture>)=>{f.history.events[0].occurred_at=new Date(1);}],
 ['local event missing',(f:ReturnType<typeof fixture>)=>{f.history.events.pop();}],
 ['settlement missing',(f:ReturnType<typeof fixture>)=>{f.snapshot.settlements=[];f.history.events.pop();}],
 ['position missing',(f:ReturnType<typeof fixture>)=>{f.history.positions=[];}],
 ['position P&L changed',(f:ReturnType<typeof fixture>)=>{f.history.positions[0].realized_pnl_micros='0';}],
 ['nonterminal provider order',(f:ReturnType<typeof fixture>)=>{f.snapshot.orders[0].terminal=false;}],
 ['unexplained cash',(f:ReturnType<typeof fixture>)=>{f.snapshot.unexplainedCashActivity=true;}],
 ['incomplete mapped history',(f:ReturnType<typeof fixture>)=>{f.snapshot.complete=false;}],
 ['open position',(f:ReturnType<typeof fixture>)=>{f.snapshot.positions=[{market:f.parent.market,side:'YES',quantityHundredths:'1'}];}],
] as const)test('reject '+name,()=>{const f=fixture();change(f);assert.throws(()=>verify(f.history,f.snapshot));});
