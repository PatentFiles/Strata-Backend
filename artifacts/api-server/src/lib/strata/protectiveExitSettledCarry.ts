import {runtimeSettledExitReceipt,type RuntimeDispositionDb} from './runtimeSettledExitGuard';
import type {Snapshot} from '../v13-production/types';

const client=/^v13p-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Scope={ownerId:string;accountId:string;clientId:string};
type Carry=Scope&{snapshot:Snapshot;receiptDigest:string};
const carry=new WeakMap<object,Carry>();
export function keepHeldExitReceipt(target:object,scope:Scope,snapshot:Snapshot,receiptDigest:string){
 carry.set(target,{...scope,snapshot:structuredClone(snapshot),receiptDigest});
}
export function moveHeldExitReceipt(from:object,to:object){
 const c=carry.get(from);if(c)carry.set(to,c);
}
export function hasHeldExitReceipt(o:object){return carry.has(o);}
export function heldExitReceiptTimeLeft(o:object,nowMs:number){
 const c=carry.get(o);if(!c)return null;
 const age=nowMs-c.snapshot.observedAtMs;
 return Number.isSafeInteger(age)&&age>=0&&age<=5000?5000-age:0;
}
/** Scope and staged marker are derived only from the trusted server-side
 * caller and the independently signed read. No identical-looking external
 * receipt, different client ID or different order can consume the proof.
 */
export async function recheckHeldExitReceipt(db:RuntimeDispositionDb,token:object,scope:Scope,
 nowMs:number,stage:'reserve'|'mark'|'wire',reservationId?:string){
 const c=carry.get(token);
 if(!c||c.ownerId!==scope.ownerId||c.accountId!==scope.accountId||c.clientId!==scope.clientId||
  !client.test(scope.clientId))return null;
 const proof=await runtimeSettledExitReceipt(db,{accountId:scope.accountId,ownerId:scope.ownerId,snapshot:c.snapshot,nowMs,lock:true,
  ...(stage==='wire'?{currentIntentId:scope.clientId.slice(5)}:{}),
  ...(reservationId?{protectiveMarker:{reservationId,clientId:scope.clientId,state:stage==='wire'?'UNKNOWN':'PREPARED'}}:{})});
 return proof?.receiptDigest===c.receiptDigest?proof:null;
}
