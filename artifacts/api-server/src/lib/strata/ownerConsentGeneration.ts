import {randomUUID} from 'node:crypto';
import {digest} from '../v13-production/types';
type Query={query(sql:string,params?:unknown[]):Promise<{rows:Record<string,unknown>[]}>};
export type KilledConsentPin={approvalOnlyMode:'DISABLED_KILLED_APPROVAL_ONLY';expectedSha:string;expectedAccountId:string;expectedPolicyId:string;expectedPolicyHash:string;expectedCredentialFingerprint:string;consentGeneration:string};
const demand=(v:unknown,r:string)=>{if(!v)throw Error(r);};
export async function readConsentGeneration(db:Query,owner:string,account:string){
 const r=await db.query('SELECT generation::text FROM private.strata_owner_consent_heads WHERE owner_user_id=$1::uuid AND execution_account_id=$2',[owner,account]);
 demand(r.rows.length<=1,'owner_renewal_consent_head_ambiguous');return r.rows.length?String(r.rows[0]!.generation):'0';
}
// Caller holds account FOR UPDATE before any head operation.
export async function lockConsentGeneration(db:Query,owner:string,account:string){
 await db.query('INSERT INTO private.strata_owner_consent_heads VALUES($1::uuid,$2,0) ON CONFLICT DO NOTHING',[owner,account]);
 const r=await db.query('SELECT generation::text FROM private.strata_owner_consent_heads WHERE owner_user_id=$1::uuid AND execution_account_id=$2 FOR UPDATE',[owner,account]);
 demand(r.rows.length===1,'owner_renewal_consent_head_missing');return String(r.rows[0]!.generation);
}
export async function advanceOwnerConsent(db:Query,owner:string,account:string,reason:string){
 await lockConsentGeneration(db,owner,account);
 const r=await db.query('UPDATE private.strata_owner_consent_heads SET generation=generation+1 WHERE owner_user_id=$1::uuid AND execution_account_id=$2 RETURNING generation::text',[owner,account]);
 demand(r.rows.length===1,'owner_renewal_consent_advance_failed');
 const evidence={ownerId:owner,accountId:account,reason,generation:String(r.rows[0]!.generation)};
 await db.query(`INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES($1,$2,'OWNER_CODE_CONSENT_REVOKED',$3::jsonb,$4)`,[randomUUID(),account,JSON.stringify(evidence),digest(evidence)]);
 return evidence.generation;
}
export async function validateKilledConsentScope(db:Query,owner:string,sha:string,pin:KilledConsentPin,lock=false){
 demand(pin.approvalOnlyMode==='DISABLED_KILLED_APPROVAL_ONLY'&&pin.expectedSha===sha&&/^(0|[1-9][0-9]*)$/.test(pin.consentGeneration),'owner_renewal_consent_pin_invalid');
 const r=await db.query(`SELECT a.id,a.xmin::text AS account_xmin,a.policy_id::text,p.policy_hash,a.key_fingerprint,
 w.state,w.account_kill,w.arm_requested,w.released_at,w.holder_id,w.fencing_token::text
 FROM public.v13_production_account a JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 JOIN private.kalshi_account_worker_lease w ON w.execution_account_id=a.id AND w.owner_user_id=a.owner_user_id
 WHERE a.owner_user_id=$1::uuid AND a.id=$2 AND a.commissioned=true AND a.execution_enabled=false
 AND a.kill_switch=true AND a.blocked_reason IS NULL AND a.reserved_micros=0
 ${lock?'FOR UPDATE OF a,w FOR SHARE OF p':''}`,[owner,pin.expectedAccountId]);
 const a=r.rows[0];
 demand(r.rows.length===1&&a&&a.policy_id===pin.expectedPolicyId&&a.policy_hash===pin.expectedPolicyHash&&a.key_fingerprint===pin.expectedCredentialFingerprint,'owner_renewal_consent_scope_changed');
 demand(a!.state==='killed'&&a!.account_kill===true&&a!.arm_requested===false&&/^[1-9][0-9]*$/.test(String(a!.fencing_token))&&typeof a!.holder_id==='string'&&a!.holder_id.length>0&&a!.holder_id.length<=200&&Number.isFinite(Date.parse(String(a!.released_at)))&&Date.parse(String(a!.released_at))<=Date.now(),'owner_renewal_terminal_killed_disarmed_required');
 demand((lock?await lockConsentGeneration(db,owner,String(a!.id)):await readConsentGeneration(db,owner,String(a!.id)))===pin.consentGeneration,'owner_renewal_consent_generation_changed');return a!;
}
export async function requireKilledConsentBinding(db:Query,owner:string,sha:string,qid:string,pin:KilledConsentPin){
 const a=await validateKilledConsentScope(db,owner,sha,pin,true);
 const b=await db.query(`SELECT 1 FROM private.strata_owner_consent_bindings WHERE mode='DISABLED_KILLED_APPROVAL_ONLY' AND qualification_id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3 AND release_commit_sha=$4 AND generation=$5::bigint AND policy_id=$6 AND policy_hash=$7 AND credential_fingerprint=$8 AND account_xmin=$9 FOR SHARE`,[qid,owner,a.id,sha,pin.consentGeneration,pin.expectedPolicyId,pin.expectedPolicyHash,pin.expectedCredentialFingerprint,a.account_xmin]);
 demand(b.rows.length===1,'owner_renewal_fresh_consent_binding_required');
}
// Generic qualification does not authorize execution or relax existing scope
// proof. Capture before provider I/O, then compare under account/head locks.
export async function genericConsentScope(db:Query,owner:string,account:string,lock=false):Promise<Record<string,unknown>&{consentGeneration:string}>{
 const r=await db.query(`SELECT a.id,a.xmin::text AS account_xmin,a.policy_id::text,p.policy_hash,a.key_fingerprint
 FROM public.v13_production_account a JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
 WHERE a.owner_user_id=$1::uuid AND a.id=$2 ${lock?'FOR UPDATE OF a FOR SHARE OF p':''}`,[owner,account]);
 demand(r.rows.length===1,'owner_renewal_consent_scope_missing');
 return {...r.rows[0]!,consentGeneration:lock?await lockConsentGeneration(db,owner,account):await readConsentGeneration(db,owner,account)};
}
