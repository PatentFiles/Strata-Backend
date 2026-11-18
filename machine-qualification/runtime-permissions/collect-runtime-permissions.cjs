'use strict';
const {createHash}=require('node:crypto');
/** Invoke only with the deployed service's server-selected pool, never request data.
 * Read-only diagnostic evidence, not issuer authority. The caller must separately
 * prove deployment identity, actual loaded bytes and trusted policy provenance. */
async function collectRuntimePermissions(pool,probeSql,expectedProbeSha256,clock=Date.now){
 const deny=reason=>({ok:false,reason,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false,deployedRuntimeVerified:false});
 let tx,begun=false;
 const start=clock();
 try{
  if(typeof probeSql!=='string'||Buffer.byteLength(probeSql)>16384||!/^[a-f0-9]{64}$/.test(expectedProbeSha256)||createHash('sha256').update(probeSql).digest('hex')!==expectedProbeSha256)return deny('permission_probe_untrusted');
  if(!Number.isSafeInteger(start))return deny('permission_clock_invalid');
  tx=await pool.connect();
  await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  await tx.query("SET LOCAL statement_timeout = '3000ms'");
  await tx.query("SET LOCAL lock_timeout = '1000ms'");
  const identity=async()=>{const r=await tx.query("SELECT current_user::text runtime_role,session_user::text session_role,current_database()::text database_name,current_setting('transaction_read_only') read_only");if(r.rows?.length!==1)throw Error('permission_identity_missing');const x=r.rows[0];if(['runtime_role','session_role','database_name'].some(k=>typeof x[k]!=='string'||!x[k])||x.read_only!=='on')throw Error('permission_identity_invalid');return {...x};};
  const who=await identity(),findings=[];
  for(const role of [...new Set([who.runtime_role,who.session_role])]){
   const r=await tx.query({text:probeSql,values:[role],query_timeout:3500});
   if(!Array.isArray(r.rows)||r.rows.length>=100)throw Error('permission_findings_incomplete');
   for(const row of r.rows){if(typeof row.kind!=='string'||!row.kind||typeof row.object!=='string'||!row.object)throw Error('permission_finding_invalid');findings.push({role,kind:row.kind,object:row.object});}
  }
  if(JSON.stringify(who)!==JSON.stringify(await identity()))throw Error('permission_identity_changed');
  const end=clock();if(!Number.isSafeInteger(end)||end<start||end-start>5000)throw Error('permission_observation_stale');
  // Read-only snapshot is always rolled back, never used to authorize mutation.
  await tx.query('ROLLBACK');begun=false;
  return {ok:findings.length===0,kind:'RUNTIME_PERMISSION_DIAGNOSTIC_CANDIDATE',identity:who,findings,observedAt:start,completedAt:end,probeSha256:expectedProbeSha256,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false,deployedRuntimeVerified:false};
 }catch(e){return deny(/^permission_[a-z_]+$/.test(e?.message)?e.message:'permission_read_unavailable');}
 finally{if(tx){if(begun){try{await tx.query('ROLLBACK')}catch{tx.release(true);tx=null}}if(tx)tx.release();}}
}
module.exports={collectRuntimePermissions};
