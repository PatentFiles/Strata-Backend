import type {CredentialClient} from './accountCredentialStore';

/** Call inside a transaction. Match dispatch/reservation lock order: account
 * first, then lease. A separate post-lock SELECT obtains a fresh READ COMMITTED
 * snapshot after any older account writer commits. Never infer flat on failure.
 */
export async function lockStopAccount(db:CredentialClient,ownerId:string,accountId:string):Promise<void>{
 const r=await db.query('SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE',[accountId,ownerId]);
 if(r.rows.length!==1)throw Error('stop_account_scope_unverified');
}
export async function lockStopOwnerAccounts(db:CredentialClient,ownerId:string):Promise<Set<string>>{
 const r=await db.query('SELECT id FROM public.v13_production_account WHERE owner_user_id=$1::uuid ORDER BY id FOR UPDATE',[ownerId]);
 return new Set(r.rows.map(row=>String(row.id)));
}
export function classifyStopExposureRow(row:Record<string,unknown>|undefined):{ok:true;managingExposure:boolean}|{ok:false;reason:'stop_exposure_unverified'}{
 if(!row)return {ok:false,reason:'stop_exposure_unverified'};
 const parse=(v:unknown)=>{const n=typeof v==='number'?v:typeof v==='string'&&/^[0-9]+$/.test(v)?Number(v):NaN;return Number.isSafeInteger(n)&&n>=0?n:null;};
 const positions=parse(row.positions),orders=parse(row.orders),unresolved=parse(row.unresolved);
 if(positions===null||orders===null||unresolved===null)return {ok:false,reason:'stop_exposure_unverified'};
 return {ok:true,managingExposure:positions>0||orders>0||unresolved>0};
}
/** Account lock must already be held by this transaction. */
export async function readStopExposure(db:CredentialClient,accountId:string):Promise<boolean>{
 const r=await db.query(`SELECT
 (SELECT count(*) FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths>0) AS positions,
 (SELECT count(*) FROM public.v13_production_intent WHERE account_id=$1 AND exchange_order_id IS NOT NULL AND terminal=false) AS orders,
 ((SELECT count(*) FROM public.v13_production_intent WHERE account_id=$1 AND (state IN ('DISPATCHED','UNKNOWN') OR terminal=false OR reserved_micros<>0))+
  (SELECT count(*) FROM private.strata_emergency_exit_reservations WHERE execution_account_id=$1 AND state IN ('PREPARED','DISPATCHED','UNKNOWN'))) AS unresolved`,[accountId]);
 const c=r.rows.length===1?classifyStopExposureRow(r.rows[0]):{ok:false as const};
 if(!c.ok)throw Error('stop_exposure_unverified');
 return c.managingExposure;
}
