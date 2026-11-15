import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pool,type Pool,type PoolClient} from '@workspace/db';
import {installFullRecoverySchema} from './ownerUnknownRecoverySchema.fixture';
import {CONTINUOUS_OWNER_CONFIRM} from './continuousExecutionAuthorization';
import {STANDING_OWNER_CONFIRM} from './apiFeeStandingDelegation';
import {STANDING_REVIEW_CONFIRM} from './standingExecutionReview';
import {API_SOURCE_POLICY_VERSION,API_SOURCE_FORMULA_VERSION} from './apiFeeSourceStage';
import {PDF_FREE_API_RATE_REVIEW_DECISION_SHA256,PDF_FREE_RATE_REVIEW_VECTOR_VERSION} from './apiFeeRateReference';

// DISPOSABLE EXPERIMENT ONLY. Not a deployment migration or tenant boundary.
// These narrowly scoped tests inject a genuine LOGIN pool into the real renewal
// functions. They never use SET ROLE to impersonate a restricted runtime.
export const standingRuntimeRole='restricted_standing_renewal';
const NativePool=pool.constructor as new(config:{connectionString:string;max:number;connectionTimeoutMillis:number})=>Pool;
export const technicalLease='private.strata_continuous_execution_technical_lease';
export const technicalAudit='private.strata_continuous_execution_audit';
export const feeDelegation='private.strata_api_fee_standing_delegations';
export const renewalLockOnly:Record<string,string>={
 'public.v13_production_account':'id',
 'public.v13_live_money_policy':'id',
 'private.kalshi_account_worker_lease':'execution_account_id',
 'private.strata_continuous_execution_grants':'grant_id',
 'private.strata_standing_execution_reviews':'release_id',
 'private.strata_owner_sha_approvals':'approval_id',
};
// Separate fee authority locks: no new write authority, fixture-only RLS denial.
export const feeLockOnly:Record<string,string>={
 'private.strata_api_fee_standing_models':'model_id',
 'private.strata_api_fee_source_grants':'grant_id',
 'private.strata_api_fee_owner_consents':'grant_id',
 'private.strata_api_fee_rate_reviews':'owner_user_id',
 'auth.users':'id','private.role_assignments':'email',
};
export const renewalReads=[
 ...Object.keys(renewalLockOnly),...Object.keys(feeLockOnly),technicalLease,
 'private.strata_emergency_exit_reservations',feeDelegation,
];
export const technicalLeaseInsertColumns=['grant_id','execution_account_id','observed_at','expires_at','evidence_digest','fencing_token','generation'];
export const technicalLeaseUpdateColumns=['observed_at','expires_at','evidence_digest','fencing_token','generation'];
export const technicalAuditInsertColumns=['grant_id','execution_account_id','kind','evidence_digest','reason'];
export const humanAuthority=[
 'private.strata_owner_sha_approvals','private.strata_standing_execution_reviews',
 'private.strata_continuous_execution_grants','private.strata_api_fee_standing_models',
 'private.strata_api_fee_source_grants','private.strata_api_fee_owner_consents',
 'private.strata_api_fee_rate_reviews',feeDelegation,
];

export function canonicalStandingUrl(){
 const url=process.env.V13_DISPOSABLE_DATABASE_URL;
 assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url),
  'only the unchanged canonical disposable runner may install this fixture');
 return new URL(url);
}

export async function openRestrictedStandingRenewal(){
 const url=canonicalStandingUrl();
 const setup=new NativePool({connectionString:url.toString(),max:4,connectionTimeoutMillis:10000});
 let runtime:Pool|undefined,singletonClosed=false;
 try{
  // installFullRecoverySchema uses SET ROLE only for migration ownership, so it
  // must run on one bootstrap connection. All production runtime calls use the
  // independent restricted LOGIN below, never the bootstrap session.
  const bootstrap=await setup.connect();
  try{await installFullRecoverySchema(bootstrap);}finally{bootstrap.release();}
  const actual=(await setup.query(`SELECT current_database() AS name,session_user AS user,
   host(inet_server_addr()) AS host,inet_server_port() AS port`)).rows[0];
  assert.deepEqual(actual,{name:url.pathname.slice(1),user:'v13_test',host:'127.0.0.1',port:Number(url.port)});
  assert.equal((await setup.query("SELECT to_regclass('public.profiles') IS NULL AS absent")).rows[0].absent,true,
   'profiles is absent from this source-qualified platform fixture, not reproduced from production');
  assert.equal((await setup.query("SELECT relrowsecurity FROM pg_class WHERE oid='auth.users'::regclass")).rows[0].relrowsecurity,false);
  // EXPLICIT SYNTHETIC PLATFORM ADDITION: auth.users is a three-column stub;
  // enabling RLS exercises a policy requirement, not Supabase Auth parity.
  await setup.query('ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY');
  await setup.query(`CREATE ROLE ${standingRuntimeRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
   NOCREATEROLE NOREPLICATION NOBYPASSRLS;
   GRANT USAGE ON SCHEMA public,private,auth TO ${standingRuntimeRole}`);
  for(const table of renewalReads){
   assert.equal((await setup.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].relrowsecurity,true,table);
   await setup.query(`GRANT SELECT ON ${table} TO ${standingRuntimeRole};
    CREATE POLICY standing_renewal_read ON ${table} FOR SELECT TO ${standingRuntimeRole} USING(true)`);
  }
  for(const [table,column] of Object.entries({...renewalLockOnly,...feeLockOnly})){
   await setup.query(`GRANT UPDATE(${column}) ON ${table} TO ${standingRuntimeRole};
    CREATE POLICY standing_renewal_lock ON ${table} FOR UPDATE TO ${standingRuntimeRole} USING(true) WITH CHECK(true);
    CREATE POLICY standing_renewal_no_mutation ON ${table} AS RESTRICTIVE FOR UPDATE TO ${standingRuntimeRole} USING(true) WITH CHECK(false)`);
  }
  await setup.query(`GRANT INSERT(${technicalLeaseInsertColumns.join(',')}) ON ${technicalLease} TO ${standingRuntimeRole};
   GRANT UPDATE(${technicalLeaseUpdateColumns.join(',')}) ON ${technicalLease} TO ${standingRuntimeRole};
   CREATE POLICY standing_renewal_insert ON ${technicalLease} FOR INSERT TO ${standingRuntimeRole} WITH CHECK(true);
   CREATE POLICY standing_renewal_update ON ${technicalLease} FOR UPDATE TO ${standingRuntimeRole} USING(true) WITH CHECK(true);
   GRANT INSERT(${technicalAuditInsertColumns.join(',')}) ON ${technicalAudit} TO ${standingRuntimeRole};
   CREATE POLICY standing_renewal_insert ON ${technicalAudit} FOR INSERT TO ${standingRuntimeRole} WITH CHECK(true);
   CREATE POLICY standing_renewal_technical_kind ON ${technicalAudit} AS RESTRICTIVE FOR INSERT TO ${standingRuntimeRole}
    WITH CHECK(kind='LEASE_RENEWED' AND reason='signed_owned_reconciliation');
   GRANT UPDATE(lease_expires_at) ON ${feeDelegation} TO ${standingRuntimeRole};
   CREATE POLICY standing_renewal_update ON ${feeDelegation} FOR UPDATE TO ${standingRuntimeRole} USING(true) WITH CHECK(true)`);
  // Close the unused privileged singleton. An accidental omitted dependency
  // cannot silently run renewal through a superuser pool.
  await pool.end();singletonClosed=true;
  url.username=standingRuntimeRole;
  runtime=new NativePool({connectionString:url.toString(),max:4,connectionTimeoutMillis:10000});
  await assertStandingIdentity(runtime);
  return {setup,runtime};
 }catch(error){
  const cleanup=await Promise.allSettled([setup.end(),runtime?.end(),singletonClosed?undefined:pool.end()]);
  const failures=cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
  if(failures.length)throw new AggregateError([error,...failures],'standing_fixture_setup_cleanup_failed');
  throw error;
 }
}

export async function assertStandingIdentity(db:Pick<Pool,'query'>){
 assert.deepEqual((await db.query(`SELECT current_user AS name,session_user AS session,
  rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolinherit
  FROM pg_roles WHERE rolname=current_user`)).rows[0],{
  name:standingRuntimeRole,session:standingRuntimeRole,rolsuper:false,rolcreatedb:false,
  rolcreaterole:false,rolreplication:false,rolbypassrls:false,rolinherit:false,
 });
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n,0);
}

// Only error classification is retained. Every SQL string, parameter, native
// result and transaction goes through unchanged; nothing simulates a DB reply.
export function observeStandingQueries(runtime:Pool,after?:(sql:string)=>Promise<void>){
 const errors:{code:string;operation:string}[]=[];
 const query=(db:Pick<Pool,'query'>)=>(async(sql:string,args?:unknown[])=>{
  try{const result=await db.query(sql,args);await after?.(sql);return result;}
  catch(error){errors.push({code:String((error as {code?:string}).code??'NON_SQL_ERROR'),operation:sql.trim().split(/\s/)[0]!});throw error;}
 });
 const db={query:query(runtime),connect:async()=>{
  const client=await runtime.connect();
  return {query:query(client),release:()=>client.release()};
 }};
 return {db,errors};
}

export async function rollbackStanding(db:Pool,work:(client:PoolClient)=>Promise<void>){
 const client=await db.connect(),errors:unknown[]=[];let discard=false;
 try{await client.query('BEGIN');await work(client);}catch(error){errors.push(error);}
 finally{
  try{await client.query('ROLLBACK');}catch(error){discard=true;errors.push(error);}
  try{client.release(discard);}catch(error){errors.push(error);}
 }
 if(errors.length===1)throw errors[0];
 if(errors.length>1)throw new AggregateError(errors,'standing_probe_and_cleanup_failed');
}

export async function standingDenied(db:Pick<Pool,'query'>,sql:string,args:unknown[]=[],codes=['42501']){
 await assert.rejects(db.query(sql,args),(error:unknown)=>{
  assert.ok(codes.includes(String((error as {code?:string}).code)),'expected a native permission/immutable-guard denial');return true;
 });
}

// All approval rows below are SYNTHETIC, setup-only data in the fresh fenced
// cluster. No human grant function, provider HTTP, credentials or Vault content.
export async function seedStandingRenewal(setup:Pool){
 const s={owner:randomUUID(),reviewer:randomUUID(),issuer:randomUUID(),financial:randomUUID(),provider:randomUUID(),
  qualification:randomUUID(),review:randomUUID(),grant:randomUUID(),feeGrant:randomUUID(),model:randomUUID(),delegation:randomUUID(),
  account:'restricted-renewal-'+randomUUID(),policy:'restricted-renewal-policy-'+randomUUID(),sha:'a'.repeat(40),hash:'b'.repeat(64)};
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
 await setup.query(`INSERT INTO ${feeDelegation}(delegation_id,owner_user_id,model_id,grant_id,policy_hash,release_commit_sha,
  confirmation,valid_until,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '1 day',now()-interval '1 second')`,
 [s.delegation,s.owner,s.model,s.feeGrant,s.hash,s.sha,STANDING_OWNER_CONFIRM]);
 return s;
}
export type StandingScope=Awaited<ReturnType<typeof seedStandingRenewal>>;
export const standingProof=(s:StandingScope)=>({ownerId:s.owner,accountId:s.account,releaseSha:s.sha,policyHash:s.hash,
 observedAtMs:Date.now()-5,cashMicros:'25000000',fencingToken:'7',authenticated:true,complete:true,
 unexplainedCashActivity:false,providerEvidence:{syntheticOffline:true}});
export async function standingTechnicalSnapshot(setup:Pool,s:StandingScope){
 return {
  lease:(await setup.query(`SELECT to_jsonb(t) AS row FROM ${technicalLease} t WHERE grant_id=$1`,[s.grant])).rows,
  audit:(await setup.query(`SELECT to_jsonb(t) AS row FROM ${technicalAudit} t WHERE grant_id=$1 ORDER BY audit_id`,[s.grant])).rows,
 };
}
export async function standingHumanSnapshot(setup:Pool,s:StandingScope){
 const snapshot:Record<string,unknown>={};
 for(const table of humanAuthority){
  const where=table==='private.strata_api_fee_standing_models'?'model_id=$1':'owner_user_id=$1';
  const arg=table==='private.strata_api_fee_standing_models'?s.model:s.owner;
  // lease_expires_at is the ONLY technical column on the human delegation row.
  const expression=table===feeDelegation?"to_jsonb(t)-'lease_expires_at'":'to_jsonb(t)';
  snapshot[table]=(await setup.query(`SELECT ${expression} AS row FROM ${table} t WHERE ${where} ORDER BY (${expression})::text`,[arg])).rows;
 }
 return snapshot;
}
