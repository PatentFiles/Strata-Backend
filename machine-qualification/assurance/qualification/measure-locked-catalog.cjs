'use strict';
const {createHash}=require('node:crypto');
const sha=b=>createHash('sha256').update(b).digest('hex');
const CATALOG_SQL=`SELECT n.nspname AS schema,c.relname AS name,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
 pg_get_userbyid(c.relowner) AS owner,coalesce(c.relacl::text,'') AS acl,
 (SELECT jsonb_agg(x ORDER BY x.attnum) FROM
  (SELECT a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attgenerated,
   pg_get_expr(d.adbin,d.adrelid) AS default_expression
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 129) x) AS columns,
 (SELECT coalesce(jsonb_agg(x ORDER BY x.name),'[]'::jsonb) FROM
  (SELECT k.conname AS name,k.convalidated,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid,true) AS definition
   FROM pg_constraint k WHERE k.conrelid=c.oid ORDER BY k.conname LIMIT 129) x) AS constraints,
 (SELECT coalesce(jsonb_agg(x ORDER BY x.name),'[]'::jsonb) FROM
  (SELECT t.tgname AS name,t.tgenabled,pg_get_triggerdef(t.oid,true) AS definition,
   pg_get_functiondef(p.oid) AS function_definition,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS function_owner,coalesce(p.proacl::text,'') AS function_acl
   FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
   WHERE t.tgrelid=c.oid AND NOT t.tgisinternal ORDER BY t.tgname LIMIT 129) x) AS triggers,
 (SELECT coalesce(jsonb_agg(x ORDER BY x.name),'[]'::jsonb) FROM
  (SELECT p.polname AS name,p.polcmd,p.polpermissive,p.polroles::text AS roles,pg_get_expr(p.polqual,p.polrelid) AS using_expression,pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
   FROM pg_policy p WHERE p.polrelid=c.oid ORDER BY p.polname LIMIT 129) x) AS policies
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.oid=to_regclass($1) AND c.relkind IN ('r','p')`;
/** Measures actual catalog using caller's runtime transaction. Pins must come
 * from qualified migration output, never inferred/adopted from live results.
 * Matching pins is not proof that the chosen object set covers every writer. */
function createLockedCatalogMeasurement(config,probeSql,clock=Date.now){
 const c=structuredClone(config);
 if(!c||!Array.isArray(c.objects)||!c.objects.length||c.objects.length>32||new Set(c.objects.map(x=>x.name)).size!==c.objects.length||c.objects.some(x=>!/^\w+\.\w+$/.test(x.name)||!/^[a-f0-9]{64}$/.test(x.sha256))||sha(probeSql)!==c.permissionProbeSha256||!c.runtimeRole||!c.sessionRole||!c.databaseName)throw Error('catalog_trust_configuration_required');
 return async function measure(tx,signal){
  const start=clock(),fail=x=>{throw Error(x)};
  if(signal?.aborted)fail('catalog_cancelled');
  const identity=async()=>{const r=await tx.query({text:'SELECT current_user::text runtime_role,session_user::text session_role,current_database()::text database_name,txid_current()::text transaction_id',query_timeout:1000});if(r.rows?.length!==1)fail('catalog_identity_unavailable');return {...r.rows[0]}};
  const who=await identity();if(who.runtime_role!==c.runtimeRole||who.session_role!==c.sessionRole||who.database_name!==c.databaseName)fail('catalog_runtime_identity_mismatch');
  for(const role of [...new Set([who.runtime_role,who.session_role])]){
   const r=await tx.query({text:probeSql,values:[role],query_timeout:1000});if(!Array.isArray(r.rows)||r.rows.length)fail('catalog_permission_hazards_or_missing_evidence');
  }
  const observed=[];
  for(const pin of c.objects){
   if(signal?.aborted||clock()-start>=5000)fail('catalog_measurement_stale');
   const r=await tx.query({text:CATALOG_SQL,values:[pin.name],query_timeout:1000});
   if(r.rows?.length!==1)fail('catalog_object_missing');const row=r.rows[0];
   for(const k of ['columns','constraints','triggers','policies'])if(!Array.isArray(row[k])||row[k].length>=129)fail('catalog_object_incomplete');
   if(row.triggers.some(t=>t.tgenabled!=='O'&&t.tgenabled!=='A'))fail('catalog_trigger_disabled');
   const digest=sha(JSON.stringify(row));if(digest!==pin.sha256)fail('catalog_object_drift');observed.push({name:pin.name,sha256:digest});
  }
  if(JSON.stringify(who)!==JSON.stringify(await identity()))fail('catalog_transaction_or_identity_changed');
  const end=clock();if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start||end-start>=5000)fail('catalog_measurement_stale');
  return {kind:'PINNED_RUNTIME_CATALOG_MEASUREMENT',identity:who,observedAt:start,completedAt:end,permissionFindings:[],objects:observed,catalogManifestSha256:sha(JSON.stringify(observed)),permissionProbeSha256:c.permissionProbeSha256,completeWriterCoverage:false,completeRoleSchemaCoverage:false,evidenceIssued:false,recoveryAuthorized:false,tradingAuthorized:false};
 };
}
module.exports={createLockedCatalogMeasurement,CATALOG_SQL};
