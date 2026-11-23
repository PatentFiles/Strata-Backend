/** Internal owner-scope local STOP check. No route, provider transport, or authority. */
import {createHash} from 'node:crypto';
import {STOPPED_CASH_DIAGNOSTIC_SCOPE_SQL} from './stoppedCashDiagnosticLoader';
import {readStoppedCashDatabaseLeg} from './stoppedCashDiagnosticAdapters';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha=/^[a-f0-9]{40}$/;
const fingerprint=/^[a-f0-9]{64}$/;
const uint=/^(0|[1-9]\d{0,18})$/;
const revisionKeys=['account','policy','lease','fence','credential','financial','provider','key','vault'] as const;
const text=(v:unknown):string=>typeof v==='string'?v:'';
type Options={connect:Parameters<typeof readStoppedCashDatabaseLeg>[0];
 releaseSha:()=>string;isScheduled:(owner:string,account:string)=>boolean};
export function createRoutineStopFence(options:Options){
 return async(owner:string)=>{
  if(!uuid.test(owner))return null;
  try{
   const build=options.releaseSha();if(!sha.test(build))return null;
   const local=await readStoppedCashDatabaseLeg(options.connect,async q=>{
    const {rows}=await q.query(STOPPED_CASH_DIAGNOSTIC_SCOPE_SQL,[owner]);
    if(rows.length!==1)return null;
    const row=rows[0]!,id=text(row.id),key=text(row.key_fingerprint);
    // diagnostic_held implements absence of live/nonterminal intents and outstanding
    // exit reservations; position_exists independently checks nonzero signed quantities.
    if(!id||row.owner_id!==owner||!(row.blocked_reason===null||row.blocked_reason==='production_external_cash_mismatch')||
      row.diagnostic_held!==true||row.lease_state!=='released'||row.arm_requested!==false||
      row.lease_account_kill!==false||row.position_exists!==false||row.reserved_micros_text!=='0'||
      !fingerprint.test(key)||row.lease_credential_fingerprint!==key||
      typeof row.execution_enabled!=='boolean'||typeof row.kill_switch!=='boolean'||
      options.isScheduled(owner,id)!==false)return null;
    const raw=row.hold_revision;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const revision=raw as Record<string,unknown>;
    if(revisionKeys.some(k=>!text(revision[k]))||!uint.test(text(revision.fence))||revision.key!==key)return null;
    const fence=createHash('sha256').update(JSON.stringify([
     build,owner,id,1,2,row.blocked_reason,row.execution_enabled,row.kill_switch,
     ...revisionKeys.map(k=>revision[k]),revision.holder??null,
    ])).digest('hex');
    return {id,fence,cashMismatchHold:row.blocked_reason!==null};
   });
   // A process may start while the read-only DB leg is closing.
   if(!local||options.releaseSha()!==build||options.isScheduled(owner,local.id)!==false)return null;
   return Object.freeze({status:'LOCAL_STOP_SCOPE_ONLY' as const,fence:local.fence,
    cashMismatchHold:local.cashMismatchHold,authenticatedExchangeFlat:false as const,
    pendingCashCompletenessVerified:false as const,holdCleared:false as const,tradingAuthorized:false as const});
  }catch{return null;}
 };
}
