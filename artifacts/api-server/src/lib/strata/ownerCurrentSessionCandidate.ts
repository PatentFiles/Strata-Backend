import {jwtVerify,type JWTVerifyGetKey} from 'jose';
import {supabaseIssuer} from './supabaseAuth';
type Client={query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>;release:(error?:Error)=>void};
/** Unmounted, exact-row auth-session liveness adapter. Does NOT assert complete
 * provider session policy: deployment must qualify actual auth schema and session
 * deletion/expiry semantics. Missing privileges/columns/session fails closed.
 */
export function createCurrentOwnerSessionVerifier(deps:{enabled:boolean;supabaseUrl:string;keys:JWTVerifyGetKey;db:{connect:()=>Promise<Client>}}){
 return async(token:string,expectedOwner:string):Promise<boolean>=>{
  if(deps.enabled!==true)return false;
  let jwtTimer:ReturnType<typeof setTimeout>|undefined;
  let payload;try{({payload}=await Promise.race([jwtVerify(token,deps.keys,{issuer:supabaseIssuer(deps.supabaseUrl),audience:'authenticated',requiredClaims:['exp','sub','session_id']}),new Promise<never>((_,reject)=>{jwtTimer=setTimeout(()=>reject(Error('session_jwt_timeout')),1000);})]));}catch{return false;}finally{if(jwtTimer)clearTimeout(jwtTimer);}
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(payload.sub!==expectedOwner||!uuid.test(expectedOwner)||payload.aal!=='aal2'||typeof payload.session_id!=='string'||!uuid.test(payload.session_id)||typeof payload.exp!=='number'||!Number.isSafeInteger(payload.exp))return false;
  const tokenExpiresAt=payload.exp*1000;
  let tx:Client|undefined,abandoned=false,timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const pending=deps.db.connect().then(c=>{if(abandoned){c.release();throw Error('late_session_connection');}return c;});
   tx=await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abandoned=true;reject(Error('session_connect_timeout'));},1000);})]);
  }catch{return false;}finally{if(timer)clearTimeout(timer);}
  let discard:Error|undefined,released=false,readCommitted=false;
  const release=(error?:Error)=>{if(!released){released=true;tx!.release(error);}};
  let readTimer:ReturnType<typeof setTimeout>|undefined;
  const work=(async()=>{try{
   await tx.query('BEGIN READ ONLY');await tx.query("SET LOCAL statement_timeout='1000ms'");await tx.query("SET LOCAL lock_timeout='500ms'");
   // Auth session id and owner are covered by JWT signature; never taken from body.
   const r=await tx.query(`SELECT s.id::text AS session_id,s.user_id::text AS owner_id,
    (s.not_after IS NULL OR s.not_after>clock_timestamp()) AS session_live,
    (u.deleted_at IS NULL AND (u.banned_until IS NULL OR u.banned_until<=clock_timestamp())) AS user_live
    FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id
    WHERE s.id=$1::uuid AND s.user_id=$2::uuid LIMIT 2`,[payload.session_id,expectedOwner]);
   const valid=r.rows.length===1&&r.rows[0].session_id===payload.session_id&&r.rows[0].owner_id===expectedOwner&&r.rows[0].session_live===true&&r.rows[0].user_live===true;
   await tx.query('COMMIT');readCommitted=true;
   return valid&&tokenExpiresAt>Date.now();
  }catch{discard=Error('owner_session_read_failed');return false;}
  finally{if(!readCommitted)try{await tx.query('ROLLBACK');}catch{discard=Error('owner_session_cleanup_failed');}release(discard);}})();
  try{return await Promise.race([work,new Promise<boolean>(resolve=>{readTimer=setTimeout(()=>{release(Error('owner_session_read_deadline'));resolve(false);},2500);})]);}finally{if(readTimer)clearTimeout(readTimer);}
 };
}
