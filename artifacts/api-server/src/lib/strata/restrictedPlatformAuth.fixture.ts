import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {pool,type Pool} from '@workspace/db';
import {backendRole,installFullRecoverySchema} from './ownerUnknownRecoverySchema.fixture';
import {CONTINUOUS_OWNER_CONFIRM} from './continuousExecutionAuthorization';
import {STANDING_OWNER_CONFIRM} from './apiFeeStandingDelegation';
import {STANDING_REVIEW_CONFIRM} from './standingExecutionReview';
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from './apiFeeSourceStage';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION} from './apiFeeRateReference';
export {rollbackStanding as rollbackPlatform,standingDenied as platformDenied,
 standingHumanSnapshot as platformHumanSnapshot} from './restrictedStandingRenewal.fixture';

// DISPOSABLE EXPERIMENT ONLY. The managed owner and policy SHAPES below come
// from metadata, not platform rows or real Auth/JWT/MFA implementation bodies.
export const platformRuntimeRole='restricted_platform_auth';
export const platformOtherRole='unrelated_platform_auth';
export const platformManagedOwner='synthetic_auth_owner';
const NativePool=pool.constructor as new(config:{connectionString:string;max:number;connectionTimeoutMillis:number})=>Pool;
export const platformDependencies=['auth.users','private.role_assignments','public.profiles'] as const;
// Exactly the union of relation locks in REVIEW_SQL and SUCCESSOR_SQL. No
// technical lease writes or continuous grant/owner approval grants are needed.
export const platformLockColumns:Record<string,string>={
 'public.v13_production_account':'id',
 'public.v13_live_money_policy':'id',
 'private.strata_api_fee_source_grants':'grant_id',
 'private.strata_api_fee_rate_reviews':'review_id',
 'private.strata_api_fee_owner_consents':'consent_id',
 'private.strata_api_fee_standing_delegations':'delegation_id',
 'private.strata_api_fee_standing_models':'model_id',
 'private.strata_standing_execution_reviews':'release_id',
 'auth.users':'id','private.role_assignments':'email','public.profiles':'id',
};
export function canonicalPlatformUrl(){
 const url=process.env.V13_DISPOSABLE_DATABASE_URL;
 assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),
  'only the unchanged canonical disposable runner may install this fixture');
 return new URL(url);
}
async function assertBootstrapTarget(setup:Pool){
 const url=canonicalPlatformUrl();
 const actual=(await setup.query(`SELECT current_database() AS name,session_user AS user,
  host(inet_server_addr()) AS host,inet_server_port() AS port`)).rows[0];
 assert.deepEqual(actual,{name:url.pathname.slice(1),user:'v13_test',host:'127.0.0.1',port:Number(url.port)});
}
export async function openRestrictedPlatformAuth(){
 const url=canonicalPlatformUrl();
 const setup=new NativePool({connectionString:url.toString(),max:4,connectionTimeoutMillis:10000});
 let runtime:Pool|undefined,other:Pool|undefined,singletonClosed=false;
 try{
  const bootstrap=await setup.connect();
  try{await installFullRecoverySchema(bootstrap);}finally{bootstrap.release();}
  await assertBootstrapTarget(setup);
  assert.equal((await setup.query("SELECT to_regclass('public.profiles') IS NULL AS absent")).rows[0].absent,true);
  await setup.query(`CREATE ROLE ${platformManagedOwner} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   CREATE ROLE ${platformRuntimeRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   CREATE ROLE ${platformOtherRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   ALTER SCHEMA auth OWNER TO ${platformManagedOwner};
   ALTER TABLE auth.users OWNER TO ${platformManagedOwner};
   ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
   ALTER FUNCTION auth.uid() OWNER TO ${platformManagedOwner};
   ALTER FUNCTION auth.role() OWNER TO ${platformManagedOwner};
   CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER AS
    $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
   ALTER FUNCTION auth.jwt() OWNER TO ${platformManagedOwner};
   GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
   GRANT USAGE ON SCHEMA public,private,auth TO ${platformRuntimeRole},${platformOtherRole};
   CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),role text NOT NULL);
   CREATE TABLE public.mfa_login_policy(id boolean PRIMARY KEY,required_for_all boolean NOT NULL);
   CREATE TABLE public.mfa_user_preferences(user_id uuid PRIMARY KEY REFERENCES auth.users(id),required_for_sign_in boolean NOT NULL);
   ALTER TABLE public.profiles OWNER TO ${backendRole};
   ALTER TABLE public.mfa_login_policy OWNER TO ${backendRole};
   ALTER TABLE public.mfa_user_preferences OWNER TO ${backendRole};
   ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
   REVOKE ALL ON public.profiles,public.mfa_login_policy,public.mfa_user_preferences FROM PUBLIC,anon,authenticated,service_role;
   GRANT SELECT ON public.profiles TO authenticated;
   -- Synthetic dependency access only; upstream MFA ACL/RLS was not inspected.
   GRANT SELECT ON public.mfa_login_policy,public.mfa_user_preferences TO authenticated;
   CREATE POLICY profiles_select_own_login_mfa ON public.profiles FOR SELECT TO authenticated
    USING((SELECT auth.uid())=id AND ((SELECT auth.jwt()->>'aal')='aal2' OR
     (EXISTS(SELECT 1 FROM public.mfa_login_policy g WHERE g.id=true AND g.required_for_all=false)
      AND EXISTS(SELECT 1 FROM public.mfa_user_preferences p WHERE p.user_id=(SELECT auth.uid()) AND p.required_for_sign_in=false))));
   CREATE POLICY profiles_update_own_aal2 ON public.profiles FOR UPDATE TO authenticated
    USING((SELECT auth.uid())=id AND (SELECT auth.jwt()->>'aal')='aal2')
    WITH CHECK((SELECT auth.uid())=id AND (SELECT auth.jwt()->>'aal')='aal2');
   INSERT INTO public.mfa_login_policy(id,required_for_all) VALUES(true,true)`);
  // No runtime SELECT grants/policies yet: establish catalog-shaped default
  // denial first. Closing this singleton prevents implicit privileged fallback.
  await pool.end();singletonClosed=true;
  url.username=platformRuntimeRole;
  runtime=new NativePool({connectionString:url.toString(),max:4,connectionTimeoutMillis:10000});
  url.username=platformOtherRole;
  other=new NativePool({connectionString:url.toString(),max:2,connectionTimeoutMillis:10000});
  await assertPlatformIdentity(runtime);await assertPlatformIdentity(other,platformOtherRole);
  return {setup,runtime,other};
 }catch(error){
  const results=await Promise.allSettled([setup.end(),runtime?.end(),other?.end(),singletonClosed?undefined:pool.end()]);
  const failures=results.flatMap(r=>r.status==='rejected'?[r.reason]:[]);
  if(failures.length)throw new AggregateError([error,...failures],'platform_fixture_setup_cleanup_failed');
  throw error;
 }
}
export async function assertPlatformIdentity(db:Pick<Pool,'query'>,role=platformRuntimeRole){
 assert.deepEqual((await db.query(`SELECT current_user AS name,session_user AS session,
  rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
  FROM pg_roles WHERE rolname=current_user`)).rows[0],{
  name:role,session:role,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,rolinherit:false,
 });
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
}
export async function installPlatformCapabilities(setup:Pool){
 await assertBootstrapTarget(setup);
 for(const [table,column] of Object.entries(platformLockColumns)){
  assert.equal((await setup.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity,true,table);
  await setup.query(`GRANT SELECT ON ${table} TO ${platformRuntimeRole};
   CREATE POLICY platform_runtime_read ON ${table} FOR SELECT TO ${platformRuntimeRole} USING(true);
   GRANT UPDATE(${column}) ON ${table} TO ${platformRuntimeRole};
   CREATE POLICY platform_runtime_lock ON ${table} FOR UPDATE TO ${platformRuntimeRole} USING(true) WITH CHECK(true);
   CREATE POLICY platform_runtime_no_mutation ON ${table} AS RESTRICTIVE FOR UPDATE TO ${platformRuntimeRole} USING(true) WITH CHECK(false)`);
 }
}
// Transparent observation only. Native driver SQL/args/results are unchanged.
export function observePlatformQueries(db:Pick<Pool,'query'>){
 const statements:string[]=[],errors:string[]=[];
 return {statements,errors,db:{query:async(sql:string,args?:unknown[])=>{
  statements.push(sql);
  try{return await db.query(sql,args);}catch(error){errors.push(String((error as {code?:string}).code));throw error;}
 }}};
}

// Seed adapted from the reviewed renewal fixture. Unique exact SHA per scope
// prevents unrelated cases from tripping the real competing-model latch.
// All approval rows below are SYNTHETIC, setup-only data in the fresh fenced
// cluster. No human grant function, provider HTTP, credentials or Vault content.
export async function seedPlatformAuth(setup:Pool){
 const s={owner:randomUUID(),reviewer:randomUUID(),issuer:randomUUID(),financial:randomUUID(),provider:randomUUID(),
  qualification:randomUUID(),review:randomUUID(),grant:randomUUID(),feeGrant:randomUUID(),model:randomUUID(),delegation:randomUUID(),
  account:'restricted-renewal-'+randomUUID(),policy:'restricted-renewal-policy-'+randomUUID(),sha:randomBytes(20).toString('hex'),hash:'b'.repeat(64)};
 // Pin each reused parameter to UUID before converting it to an email string;
 // a bare $n::text otherwise conflicts with the UUID id column (SQLSTATE 42P08).
 await setup.query(`INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
  ($1::uuid,($1::uuid)::text||'@example.invalid',now()),($2::uuid,($2::uuid)::text||'@example.invalid',now()),($3::uuid,($3::uuid)::text||'@example.invalid',now());`,[s.owner,s.reviewer,s.issuer]);
 await setup.query(`INSERT INTO private.role_assignments(email,role) VALUES($1::text||'@example.invalid','ADMIN'),($2::text||'@example.invalid','ADMIN')`,[s.reviewer,s.issuer]);
 await setup.query("INSERT INTO public.financial_accounts(id,user_id,provider) VALUES($1,$2,'kalshi')",[s.financial,s.owner]);
 await setup.query('INSERT INTO private.provider_connections(id,financial_account_id) VALUES($1,$2)',[s.provider,s.financial]);
 await setup.query(`INSERT INTO public.v13_production_account(id,owner_user_id,kalshi_connection_id,subaccount,
  exchange_index,key_fingerprint,cash_micros,reserved_micros,initial_cash_micros,revision,blocked_reason)
  VALUES($1,$2,$3,1,2,$4,25000000,0,25000000,0,NULL)`,[s.account,s.owner,s.financial,s.hash]);
 await setup.query(`INSERT INTO public.v13_live_money_policy(id,version,state,execution_account_id,created_by,
  champion_selection_review_id,champion_selection_evidence_hash,champion_selected_by,champion_selected_at,
  capital_limit_cents,max_entry_stake_cents,max_entry_all_in_cents,max_daily_loss_cents,max_total_loss_cents,
  max_quote_age_ms,max_fee_evidence_age_ms,fee_policy_version,fee_source_url,fee_formula_version,approved_by,approved_at,policy_hash)
  VALUES($1,1,'APPROVED',$2,$3,'synthetic-offline-review',$4,$3,now(),2500,500,600,500,500,5000,5000,$5,$6,$7,$3,now(),$4)`,
 [s.policy,s.account,s.owner,s.hash,API_SOURCE_POLICY_VERSION,'strata-api-reviewed://kxbtc15m/'+s.feeGrant,API_SOURCE_FORMULA_VERSION]);
 await setup.query(`UPDATE public.v13_production_account SET policy_id=$2,commissioning_digest=$3,
  minimum_exit_micros=400000,commissioned=true,kill_switch=false,execution_enabled=true WHERE id=$1`,[s.account,s.policy,s.hash]);
 await setup.query(`INSERT INTO private.kalshi_account_worker_lease(execution_account_id,owner_user_id,financial_account_id,
  provider_connection_id,holder_id,fencing_token,state,heartbeat_at,arm_requested,credential_fingerprint,vault_secret_id)
  VALUES($1,$2,$3,$4,'synthetic-no-worker',7,'owned',clock_timestamp(),true,$5,$6)`,
 [s.account,s.owner,s.financial,s.provider,s.hash,randomUUID()]);
 await setup.query(`INSERT INTO private.strata_protective_release_qualification(qualification_id,release_commit_sha,owner_user_id,execution_account_id,evidence_digest)
  VALUES($1,$2,$3,$4,$5)`,[s.qualification,s.sha,s.owner,s.account,s.hash]);
 await setup.query(`INSERT INTO private.strata_owner_sha_approvals(owner_user_id,execution_account_id,release_commit_sha,qualification_id,qualification_digest)
  VALUES($1,$2,$3,$4,$5)`,[s.owner,s.account,s.sha,s.qualification,s.hash]);
 const note='SYNTHETIC DISPOSABLE FIXTURE ONLY. This is not an actual independent human review, owner authorization, provider proof, or production qualification. '.repeat(2);
 await setup.query(`INSERT INTO private.strata_standing_execution_reviews(release_id,owner_user_id,execution_account_id,release_commit_sha,
  policy_hash,independent_reviewer_id,qualification_id,evidence_digest,review_url,review_note,confirmation)
  VALUES($1,$2,$3,$4,$5,$6,$7,$5,'https://github.com/PatentFiles/Strata-Backend/pull/1',$8,$9)`,
 [s.review,s.owner,s.account,s.sha,s.hash,s.reviewer,s.qualification,note,STANDING_REVIEW_CONFIRM]);
 await setup.query(`INSERT INTO private.strata_continuous_execution_grants(grant_id,owner_user_id,execution_account_id,release_commit_sha,
  policy_hash,reviewed_release_id,independent_reviewer_id,owner_confirmation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
 [s.grant,s.owner,s.account,s.sha,s.hash,s.review,s.reviewer,CONTINUOUS_OWNER_CONFIRM]);
 await setup.query(`INSERT INTO private.strata_api_fee_rate_reviews(owner_user_id,reviewer_user_id,rate_decision_digest,fee_model_version,
  confirmation,review_note,verified_rate_source,signed_at,expires_at)
  VALUES($1,$2,$3,$4,'I_INDEPENDENTLY_APPROVE_STRATA_API_FEE_RATE_MODEL_V1',$5,'kalshi_official_fee_publication',now()-interval '3 minutes',now()+interval '1 hour')`,
 [s.owner,s.issuer,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION,note]);
 // Deliberately expired original bootstrap grant. A separately bounded standing
 // model/delegation may continue without changing that human grant's expiry.
 await setup.query(`INSERT INTO private.strata_api_fee_source_grants(grant_id,owner_user_id,issuer_admin_id,rate_decision_digest,
  fee_model_version,authorized_stages,confirmation,issued_at,expires_at)
  VALUES($1,$2,$3,$4,$5,ARRAY['STEP_9','STEP_11','ORDER_ENTRY'],'ISSUE_REVIEWED_API_FEE_POLICY_GRANT_V1',now()-interval '2 minutes',now()-interval '1 minute')`,
 [s.feeGrant,s.owner,s.issuer,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION]);
 await setup.query(`INSERT INTO private.strata_api_fee_owner_consents(grant_id,owner_user_id,confirmation,confirmed_at)
  VALUES($1,$2,'CONFIRM_REVIEWED_API_FEE_SOURCE_V1',now()-interval '90 seconds')`,[s.feeGrant,s.owner]);
 await setup.query(`INSERT INTO private.strata_api_fee_standing_models(model_id,reviewer_admin_id,rate_decision_digest,fee_model_version,
  scope,release_commit_sha,evidence_url,evidence_sha256,evidence_note,valid_until)
  VALUES($1,$2,$3,$4,'KXBTC15M:INDEX2',$5,'https://kalshi.com/docs/kalshi-fee-schedule.pdf',$6,$7,now()+interval '1 day')`,
 [s.model,s.reviewer,PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION,s.sha,s.hash,note]);
 await setup.query(`INSERT INTO private.strata_api_fee_standing_delegations(delegation_id,owner_user_id,model_id,grant_id,policy_hash,release_commit_sha,
  confirmation,valid_until,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '23 hours',now()-interval '1 second')`,
 [s.delegation,s.owner,s.model,s.feeGrant,s.hash,s.sha,STANDING_OWNER_CONFIRM]);
 await setup.query("INSERT INTO public.profiles(id,role) VALUES($1,'STANDARD'),($2,'ADMIN'),($3,'ADMIN')",[s.owner,s.reviewer,s.issuer]);
 await setup.query('INSERT INTO public.mfa_user_preferences(user_id,required_for_sign_in) VALUES($1,false),($2,false),($3,false)',[s.owner,s.reviewer,s.issuer]);
 return s;
}
export type PlatformScope=Awaited<ReturnType<typeof seedPlatformAuth>>;
