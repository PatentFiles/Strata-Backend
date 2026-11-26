import assert from 'node:assert/strict';
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {randomUUID} from 'node:crypto';
import {backendRole} from './ownerUnknownRecoverySchema.fixture';
import {installRestrictedProtectiveRuntime,runtimeRole,lockOnly,updates} from './restrictedProtectiveRuntime.fixture';
import {technicalLease,technicalAudit,feeDelegation,technicalLeaseInsertColumns,
 technicalLeaseUpdateColumns,technicalAuditInsertColumns,standingDenied} from './restrictedStandingRenewal.fixture';
import {STANDING_OWNER_CONFIRM} from './apiFeeStandingDelegation';
import {CONTINUOUS_OWNER_CONFIRM} from './continuousExecutionAuthorization';
import {STANDING_REVIEW_CONFIRM} from './standingExecutionReview';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION} from './apiFeeRateReference';

// DISPOSABLE trusted-worker compatibility, NOT a production permission plan.
// Reuse the exercised protective manifest, not the incompatible renewal/Auth
// policy installers. One relation has exactly one mutation classification.
export const combinedReadOnlyLocks:Record<string,string>={
 'auth.users':'id','private.role_assignments':'email','public.profiles':'id',
 'private.strata_api_fee_standing_models':'model_id',
};
export const combinedTechnicalUpdates:Record<string,string[]>={
 [feeDelegation]:['lease_expires_at'],[technicalLease]:technicalLeaseUpdateColumns,
};
export function assertCombinedClassification(){
 const immutable={...lockOnly,...combinedReadOnlyLocks};
 const mutable={...updates,...combinedTechnicalUpdates};
 assert.deepEqual(Object.keys(immutable).filter(table=>table in mutable),[],
  'read-only restrictive policies must never cover operational/technical writes');
 assert.equal('public.v13_production_account' in immutable,false);
 assert.equal('private.kalshi_account_worker_lease' in immutable,false);
 assert.equal(feeDelegation in immutable,false);
 assert.deepEqual(combinedTechnicalUpdates[feeDelegation],['lease_expires_at']);
}
async function assertCombinedTarget(setup:Pool){
 const url=process.env.V13_DISPOSABLE_DATABASE_URL;
 assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),
  'only the unchanged canonical disposable runner may install combined capabilities');
 const parsed=new URL(url);
 assert.deepEqual((await setup.query(`SELECT current_database() AS name,session_user AS user,
  host(inet_server_addr()) AS host,inet_server_port() AS port`)).rows[0],
  {name:parsed.pathname.slice(1),user:'v13_test',host:'127.0.0.1',port:Number(parsed.port)});
}

export async function installCombinedPlatformShape(setup:Pool){
 await assertCombinedTarget(setup);
 assert.equal((await setup.query("SELECT to_regclass('public.profiles') IS NULL AS absent")).rows[0].absent,true);
 // Same minimal catalog-shaped Auth/profile additions as PR325. Function
 // bodies and MFA tables are synthetic, not a platform authentication proof.
 await setup.query(`CREATE ROLE combined_auth_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ALTER SCHEMA auth OWNER TO combined_auth_owner;
  ALTER TABLE auth.users OWNER TO combined_auth_owner;
  ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
  ALTER FUNCTION auth.uid() OWNER TO combined_auth_owner;
  ALTER FUNCTION auth.role() OWNER TO combined_auth_owner;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS
   $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
  ALTER FUNCTION auth.jwt() OWNER TO combined_auth_owner;
  GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
  CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),role text NOT NULL);
  CREATE TABLE public.mfa_login_policy(id boolean PRIMARY KEY,required_for_all boolean NOT NULL);
  CREATE TABLE public.mfa_user_preferences(user_id uuid PRIMARY KEY REFERENCES auth.users(id),required_for_sign_in boolean NOT NULL);
  ALTER TABLE public.profiles OWNER TO ${backendRole};
  ALTER TABLE public.mfa_login_policy OWNER TO ${backendRole};
  ALTER TABLE public.mfa_user_preferences OWNER TO ${backendRole};
  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.profiles,public.mfa_login_policy,public.mfa_user_preferences FROM PUBLIC,anon,authenticated,service_role;
  GRANT SELECT ON public.profiles,public.mfa_login_policy,public.mfa_user_preferences TO authenticated;
  CREATE POLICY profiles_select_own_login_mfa ON public.profiles FOR SELECT TO authenticated
   USING((SELECT auth.uid())=id AND ((SELECT auth.jwt()->>'aal')='aal2' OR
    (EXISTS(SELECT 1 FROM public.mfa_login_policy g WHERE g.id=true AND g.required_for_all=false)
     AND EXISTS(SELECT 1 FROM public.mfa_user_preferences p WHERE p.user_id=(SELECT auth.uid()) AND p.required_for_sign_in=false))));
  CREATE POLICY profiles_update_own_aal2 ON public.profiles FOR UPDATE TO authenticated
   USING((SELECT auth.uid())=id AND (SELECT auth.jwt()->>'aal')='aal2')
   WITH CHECK((SELECT auth.uid())=id AND (SELECT auth.jwt()->>'aal')='aal2');
  INSERT INTO public.mfa_login_policy(id,required_for_all) VALUES(true,true)`);
 if((await setup.query("SELECT to_regclass('vault.decrypted_secrets') IS NULL AS absent")).rows[0].absent){
  // Restart lane never reads signer material. Supervisor lane installs this
  // same synthetic contract and fills it only with its ephemeral offline key.
  await setup.query(`CREATE TABLE vault.decrypted_secrets(id uuid PRIMARY KEY REFERENCES vault.secrets(id),decrypted_secret text NOT NULL);
   ALTER TABLE vault.decrypted_secrets OWNER TO ${backendRole};REVOKE ALL ON vault.decrypted_secrets FROM PUBLIC`);
 }
}

export async function installCombinedRestrictedRuntime(setup:Pool,observe?:(client:PoolClient)=>void){
 await assertCombinedTarget(setup);assertCombinedClassification();
 for(const table of [feeDelegation,technicalLease,technicalAudit]){
  assert.equal((await setup.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity,true,table);
 }
 await installRestrictedProtectiveRuntime(setup,observe);
 for(const [table,column] of Object.entries(combinedReadOnlyLocks)){
  assert.equal((await setup.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity,true,table);
  if(table==='public.profiles'||table==='private.strata_api_fee_standing_models'){
   await setup.query(`GRANT SELECT ON ${table} TO ${runtimeRole};
    CREATE POLICY combined_worker_read ON ${table} FOR SELECT TO ${runtimeRole} USING(true)`);
  }
  await setup.query(`GRANT UPDATE(${column}) ON ${table} TO ${runtimeRole};
   CREATE POLICY combined_worker_lock ON ${table} FOR UPDATE TO ${runtimeRole} USING(true) WITH CHECK(true);
   CREATE POLICY combined_worker_no_mutation ON ${table} AS RESTRICTIVE FOR UPDATE TO ${runtimeRole} USING(true) WITH CHECK(false)`);
 }
 // Existing operational UPDATE columns on account/worker lease already
 // support their FOR SHARE/FOR UPDATE locks. Do not add identity grants.
 await setup.query(`GRANT UPDATE(lease_expires_at) ON ${feeDelegation} TO ${runtimeRole};
  CREATE POLICY combined_worker_renew ON ${feeDelegation} FOR UPDATE TO ${runtimeRole} USING(true) WITH CHECK(true);
  GRANT SELECT ON ${technicalLease} TO ${runtimeRole};
  CREATE POLICY combined_worker_read ON ${technicalLease} FOR SELECT TO ${runtimeRole} USING(true);
  GRANT INSERT(${technicalLeaseInsertColumns.join(',')}) ON ${technicalLease} TO ${runtimeRole};
  GRANT UPDATE(${technicalLeaseUpdateColumns.join(',')}) ON ${technicalLease} TO ${runtimeRole};
  CREATE POLICY combined_worker_insert ON ${technicalLease} FOR INSERT TO ${runtimeRole} WITH CHECK(true);
  CREATE POLICY combined_worker_update ON ${technicalLease} FOR UPDATE TO ${runtimeRole} USING(true) WITH CHECK(true);
  GRANT INSERT(${technicalAuditInsertColumns.join(',')}) ON ${technicalAudit} TO ${runtimeRole};
  CREATE POLICY combined_worker_insert ON ${technicalAudit} FOR INSERT TO ${runtimeRole} WITH CHECK(true);
  CREATE POLICY combined_worker_technical_kind ON ${technicalAudit} AS RESTRICTIVE FOR INSERT TO ${runtimeRole}
   WITH CHECK(kind='LEASE_RENEWED' AND reason='signed_owned_reconciliation')`);
 assert.deepEqual((await pool.query('SELECT current_user AS name,session_user AS session')).rows[0],{name:runtimeRole,session:runtimeRole});
}

export async function assertCombinedAuthority(setup:Pool){
 await assertCombinedTarget(setup);
 for(const [table,column] of Object.entries(combinedReadOnlyLocks)){
  const before=(await setup.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${column}`)).rows;
  assert(before.length>0,'probe matching platform/authority rows: '+table);
  assert((await pool.query(`SELECT ${column} FROM ${table} FOR SHARE`)).rows.length>0);
  await setup.query(`CREATE POLICY combined_accidental_widening ON ${table} FOR UPDATE TO ${runtimeRole} USING(true) WITH CHECK(true)`);
  try{
   await standingDenied(pool,`UPDATE ${table} SET ${column}=${column}`);
   await standingDenied(pool,`INSERT INTO ${table} SELECT * FROM ${table}`);
   await standingDenied(pool,`DELETE FROM ${table}`);
  }finally{await setup.query(`DROP POLICY combined_accidental_widening ON ${table}`);}
  assert.deepEqual((await setup.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${column}`)).rows,before);
 }
 await standingDenied(pool,"UPDATE public.profiles SET role='ADMIN'");
 for(const column of ['delegation_id','owner_user_id','model_id','grant_id','policy_hash','release_commit_sha','valid_until','revoked_at']){
  await standingDenied(pool,`UPDATE ${feeDelegation} SET ${column}=${column}`);
 }
 assert((await pool.query(`SELECT delegation_id FROM ${feeDelegation} FOR SHARE`)).rows.length>0);
 for(const table of ['public.v13_production_account','private.kalshi_account_worker_lease',feeDelegation]){
  const forbidden=(await setup.query(`SELECT count(*)::int AS n FROM pg_policy
   WHERE polrelid=$1::regclass AND NOT polpermissive AND polcmd='w'
   AND (SELECT oid FROM pg_roles WHERE rolname=$2)=ANY(polroles)`,[table,runtimeRole])).rows[0].n;
  assert.equal(forbidden,0,'no incompatible blanket restrictive UPDATE policy: '+table);
 }
}

export async function combinedHumanSnapshot(setup:Pool){
 const tables=['private.strata_owner_sha_approvals','private.strata_standing_execution_reviews',
  'private.strata_continuous_execution_grants','private.strata_api_fee_standing_models',
  'private.strata_api_fee_source_grants','private.strata_api_fee_rate_reviews','private.strata_api_fee_owner_consents',
  'auth.users','private.role_assignments','public.profiles'];
 const rows:Record<string,unknown>={};
 for(const table of tables)rows[table]=(await setup.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 rows[feeDelegation]=(await setup.query(`SELECT to_jsonb(t)-'lease_expires_at' AS row FROM ${feeDelegation} t ORDER BY delegation_id`)).rows;
 return rows;
}

export async function seedCombinedStanding(setup:Pool,s:{owner:string;reviewer:string;grant:string;account:string;policyHash:string;sha:string}){
 await assertCombinedTarget(setup);
 const model=randomUUID(),delegation=randomUUID(),review=randomUUID(),continuous=randomUUID();
 const note='SYNTHETIC DISPOSABLE TEST ONLY. This is not a real independent human review, owner authorization, provider proof, or production qualification. '.repeat(2);
 await setup.query("INSERT INTO public.profiles(id,role) VALUES($1,'STANDARD'),($2,'ADMIN')",[s.owner,s.reviewer]);
 await setup.query('INSERT INTO public.mfa_user_preferences(user_id,required_for_sign_in) VALUES($1,false),($2,false)',[s.owner,s.reviewer]);
 // Force STEP_11 to perform standing renewal and force protective history to
 // use the current-SHA successor. Only setup shortens these synthetic rows,
// before the immutable-human snapshot; runtime may never edit their horizon.
 await setup.query("UPDATE private.strata_api_fee_source_grants SET expires_at=issued_at+interval '1 second' WHERE grant_id=$1",[s.grant]);
 await setup.query("UPDATE private.strata_api_fee_rate_reviews SET expires_at=signed_at+interval '1 second' WHERE owner_user_id=$1",[s.owner]);
 await setup.query(`INSERT INTO private.strata_api_fee_standing_models(model_id,reviewer_admin_id,rate_decision_digest,
  fee_model_version,scope,release_commit_sha,evidence_url,evidence_sha256,evidence_note,valid_until)
  VALUES($1,$2,$3,$4,'KXBTC15M:INDEX2',$5,'https://kalshi.com/docs/kalshi-fee-schedule.pdf',$6,$7,clock_timestamp()+interval '1 day')`,
 [model,s.reviewer,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION,s.sha,'b'.repeat(64),note]);
 await setup.query(`INSERT INTO ${feeDelegation}(delegation_id,owner_user_id,model_id,grant_id,policy_hash,
  release_commit_sha,confirmation,valid_until,lease_expires_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '23 hours',clock_timestamp()-interval '1 second')`,
 [delegation,s.owner,model,s.grant,s.policyHash,s.sha,STANDING_OWNER_CONFIRM]);
 await setup.query(`INSERT INTO private.strata_standing_execution_reviews(release_id,owner_user_id,execution_account_id,
  release_commit_sha,policy_hash,independent_reviewer_id,qualification_id,evidence_digest,review_url,review_note,confirmation)
  SELECT $1,$2,$3,$4,$5,$6,q.qualification_id,q.evidence_digest,
   'https://github.com/PatentFiles/Strata-Backend/pull/1',$7,$8
  FROM private.strata_protective_release_qualification q WHERE q.execution_account_id=$3 AND q.owner_user_id=$2`,
 [review,s.owner,s.account,s.sha,s.policyHash,s.reviewer,note,STANDING_REVIEW_CONFIRM]);
 await setup.query(`INSERT INTO private.strata_continuous_execution_grants(grant_id,owner_user_id,execution_account_id,
  release_commit_sha,policy_hash,reviewed_release_id,independent_reviewer_id,owner_confirmation)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[continuous,s.owner,s.account,s.sha,s.policyHash,review,s.reviewer,CONTINUOUS_OWNER_CONFIRM]);
 await setup.query(`INSERT INTO ${technicalLease}(grant_id,execution_account_id,observed_at,expires_at,evidence_digest,fencing_token,generation)
  VALUES($1,$2,statement_timestamp()-interval '6 minutes',statement_timestamp()-interval '1 minute',$3,1,1)`,[continuous,s.account,'c'.repeat(64)]);
 return {model,delegation,review,continuous};
}

// TEST-ONLY transparent native success observation. No query/parameter values
// leave this fixture; results and original errors are returned unchanged. Both
// callback and promise pg APIs retain their completion/error semantics.
export function observeCombinedStatements(client:PoolClient,seen:Set<string>){
 const original=client.query;
 client.query=function(this:PoolClient,...args:unknown[]){
  const sql=typeof args[0]==='string'?args[0]:'';
  const label=sql.includes('LEAST(d.valid_until,now()')?'fee_renewal':
   sql.includes('ON CONFLICT(grant_id) DO UPDATE')?'technical_renewal':
   sql.includes('SELECT d.delegation_id::text,m.model_id::text,e.release_id::text')?'successor':null;
  const note=(result:unknown)=>{try{if(label&&result&&typeof result==='object'&&'rows' in result&&Array.isArray(result.rows)){
   if(result.rows.length>0)seen.add(label);else if(label==='successor')seen.add('successor_refused');
  }}catch{/* Test observation never replaces a native result/error. */}};
  const callback=args.at(-1);
  if(typeof callback==='function')args[args.length-1]=function(this:unknown,...values:unknown[]){
   if(!values[0])note(values[1]);return Reflect.apply(callback,this,values);
  };
  const result=Reflect.apply(original,this,args);
  if(typeof callback!=='function'&&result&&typeof result.then==='function')return result.then((value:unknown)=>{note(value);return value;});
  return result;
 } as PoolClient['query'];
}
