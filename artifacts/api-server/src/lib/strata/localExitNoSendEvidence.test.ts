import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {digest} from '../v13-production/types';
import {validateLocalExitNoSend} from './localExitNoSendEvidence';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const owner='11111111-1111-4111-8111-111111111111',account='isolated-no-send';
type Row=Record<string,any>;
function fixture(fractional=false,reason='final_evidence_expired'){
 const qty=fractional?'150':'300',fingerprint='a'.repeat(64),at=new Date('2026-11-18T20:00:00Z');
 const parent:Row={id:'parent',account_id:account,kind:'ENTRY',terminal:true,market:'KXBTC15M-FIXTURE',side:'YES',exchange_order_id:'order',filled_hundredths:'300'};
 const request={clientOrderId:'v13p-exit',market:parent.market,side:'YES',action:'SELL',reduceOnly:true,timeInForce:'IOC',limitMicros:450000,
  ...(fractional?{quantityVersion:'EXIT_HUNDREDTHS_V1',quantityHundredths:qty}:{contracts:3})};
 const decision={identity:{keyFingerprint:fingerprint,subaccount:1,exchangeIndex:2}};
 const i:Row={id:'exit',account_id:account,kind:'EXIT',state:'BLOCKED',terminal:true,dispatch_at:at,exchange_order_id:null,cancel_attempted:false,
  filled_hundredths:'0',reserved_micros:'0',exit_fee_micros:'0',request,decision,parent_id:'parent',market:parent.market,side:'YES',client_order_id:request.clientOrderId,
  policy_hash:'policy',fee_fingerprint:'fee',capability_digest:digest({id:'exit',request,decision,policyHash:'policy',fee:'fee'})};
 const raw=JSON.stringify({ticker:parent.market,side:'ask',count:fractional?'1.50':'3.00',price:'0.4500',client_order_id:request.clientOrderId,
  time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',post_only:false,reduce_only:true,subaccount:1,exchange_index:2});
 const marker:Row={reservation_id:'reservation',owner_user_id:owner,execution_account_id:account,client_order_id:request.clientOrderId,state:'VOID',trading_authorized:false,
  market_ticker:parent.market,reducing_side:'YES',quantity_hundredths:qty,order_request_json:raw,order_digest:hash(raw),worker_holder_id:'holder',worker_fencing_token:'22'};
 const receipt:Row={...marker,limit_micros:'450000',signer_fingerprint:fingerprint,reason,recorded_at:at,
  evidence_sha256:hash(JSON.stringify({version:1,ownerId:owner,accountId:account,reservationId:'reservation',clientOrderId:request.clientOrderId,
   orderDigest:hash(raw),market:parent.market,side:'YES',quantity:qty,limitMicros:450000,signerFingerprint:fingerprint,holderId:'holder',fencingToken:22,reason}))};
 const f={i,parent,marker,receipt,markers:[marker],receipts:[receipt],observations:[] as Row[]};
 return {...f,check:()=>validateLocalExitNoSend(i,[parent,i],f.observations,f.markers,f.receipts,account,owner)};
}
for(const fractional of [false,true])test(`real producer hash format validates ${fractional?'fractional':'whole'} local no-send evidence`,()=>{const f=fixture(fractional);assert.equal(f.check(),f.receipt);});
const invalid:Array<[string,(f:ReturnType<typeof fixture>)=>void]>=[
 ['missing receipt',f=>{f.receipts.length=0;}],['duplicate receipt',f=>{f.receipts.push({...f.receipt});}],
 ['missing marker',f=>{f.markers.length=0;}],['duplicate marker',f=>{f.markers.push({...f.marker});}],
 ['foreign owner',f=>{f.receipt.owner_user_id='foreign';}],['foreign account',f=>{f.marker.execution_account_id='foreign';}],
 ['changed raw order',f=>{f.marker.order_request_json=f.marker.order_request_json.replace('0.4500','0.4600');}],
 ['digest mismatch',f=>{f.receipt.evidence_sha256='0'.repeat(64);}],['fencing mismatch',f=>{f.marker.worker_fencing_token='23';}],
 ['signer mismatch',f=>{f.receipt.signer_fingerprint='b'.repeat(64);}],['capability mismatch',f=>{f.i.request.limitMicros=460000;}],
 ['actual provider order',f=>{f.i.exchange_order_id='provider';}],['fill',f=>{f.i.filled_hundredths='1';}],
 ['unknown marker',f=>{f.marker.state='UNKNOWN';}],['active intent',f=>{f.i.terminal=false;}],
 ['receipt before dispatch',f=>{f.receipt.recorded_at=new Date('2026-11-17');}],['missing parent',f=>{f.i.parent_id='absent';}],
 ['parent insufficient quantity',f=>{f.parent.filled_hundredths='100';}],['unsafe token precision',f=>{f.marker.worker_fencing_token=f.receipt.worker_fencing_token='9007199254740993';}],
 ...['POST_ATTEMPT','POST_UNCERTAIN','CANCEL_ATTEMPT','PROVEN_NOT_POSTED'].map(kind=>[kind+' contradiction',(f:ReturnType<typeof fixture>)=>{f.observations.push({kind});}] as [string,(f:ReturnType<typeof fixture>)=>void]),
];
for(const [label,change] of invalid)test(`local no-send refuses ${label}`,()=>{const f=fixture();change(f);assert.throws(f.check);});

test("exact pre-COMMIT locked-no-row audit validates; generic label does not",()=>{
 const f=fixture(true,"final_fence_no_exact_row_before_commit");
 assert.equal(f.check(),f.receipt);
 const bad=fixture(true,"protective_exit_final_fence_closed");
 assert.throws(bad.check);
});
