import type {Snapshot} from '../v13-production/types';
import type {Account} from '../v13-production/ledger';
import {requireProof} from '../v13-production/types';
import {readEconomicExitDischarges,economicExitFinalityEnabled} from './economicExitDischargeScope';
import {verifyEconomicRuntimeEvidence} from './economicExitRuntimeEvidence';
type Scope={ownerId:string;accountId:string;clientId:string};
const evidence=new WeakMap<object,Scope&{snapshot:Snapshot}>();
/** Process-local carry only. It is NOT financial authority and cannot be
 * reconstructed from JSON. The final sender independently checks the exact
 * canonical receipt, account, current order, and original signed timestamp. */
export function captureEconomicProtectiveEvidence(scope:Scope,snapshot:Snapshot):object{
 const token=Object.freeze({});evidence.set(token,{...scope,snapshot:structuredClone(snapshot)});return token;
}
export async function recheckEconomicProtectiveEvidence(db:Parameters<typeof readEconomicExitDischarges>[0],
 token:object|undefined,scope:Scope&{intentId:string},nowMs:number):Promise<number|null>{
 if(!economicExitFinalityEnabled())return null;
 const rows=await readEconomicExitDischarges(db,scope.accountId,true);
 if(rows.length===0)return null;
 const carry=token&&evidence.get(token);
 requireProof(carry&&carry.ownerId===scope.ownerId&&carry.accountId===scope.accountId&&carry.clientId===scope.clientId,
  'economic_discharge_protective_carry_missing');
 const accounts=(await db.query('SELECT * FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR SHARE',
  [scope.accountId,scope.ownerId])).rows;
 requireProof(accounts.length===1,'economic_discharge_protective_account_missing');
 verifyEconomicRuntimeEvidence(rows,{account:accounts[0] as unknown as Account,ownerId:scope.ownerId,
  snapshot:carry.snapshot,nowMs,currentIntentId:scope.intentId});
 return carry.snapshot.observedAtMs;
}
