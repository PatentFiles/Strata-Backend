import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from '@workspace/db';
import {backendRole} from './ownerUnknownRecoverySchema.fixture';
import {inspectRuntimeDbSession} from './apiFeeRuntimeDbSession';
import {REVIEW_SQL,SUCCESSOR_SQL,verifyReviewedProtectiveExitFeeAuthority,verifyReviewedProtectiveExitFee} from './reviewedProtectiveExitFee';
import {openRestrictedPlatformAuth,assertPlatformIdentity,installPlatformCapabilities,seedPlatformAuth,
 platformRuntimeRole,platformOtherRole,platformManagedOwner,platformDependencies,platformLockColumns,
 observePlatformQueries,rollbackPlatform,platformDenied,platformHumanSnapshot,type PlatformScope} from './restrictedPlatformAuth.fixture';

// ONLY scripts/run-v13-disposable-postgres.mjs, unchanged, without flags or
// environment overrides. No connected DB, real tokens, provider I/O or orders.
test('platform-shaped Auth/profile dependencies and actual successor locks',{timeout:120000},async t=>{
 const {setup,runtime,other}=await openRestrictedPlatformAuth();
 const failures:unknown[]=[];
 const authority=(s:PlatformScope,db:Parameters<typeof verifyReviewedProtectiveExitFeeAuthority>[3]=runtime)=>
  verifyReviewedProtectiveExitFeeAuthority(s.owner,s.account,s.sha,db);
 const profileSnapshot=async(s:PlatformScope)=>(await setup.query('SELECT to_jsonb(p) AS row FROM public.profiles p WHERE id=ANY($1::uuid[]) ORDER BY id',[ [s.owner,s.reviewer,s.issuer] ])).rows;
 const claims=async(subject:string,aal:string,work:(client:PoolClient)=>Promise<void>)=>rollbackPlatform(setup,async client=>{
  // Bootstrap-only policy-shape probe, NEVER the worker identity. These GUCs
  // are caller-controlled scaffolding, not cryptographic JWT authentication.
  await client.query('SET LOCAL ROLE authenticated');
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[subject,JSON.stringify({sub:subject,aal,role:'authenticated'})]);
  await work(client);
 });
 try{
  const baseline=await seedPlatformAuth(setup);
  await t.test('genuine LOGIN stays nonowner and cannot RESET ROLE into bootstrap privileges',async()=>{
   await assertPlatformIdentity(runtime);await assertPlatformIdentity(other,platformOtherRole);
   for(const role of ['v13_test',backendRole,platformManagedOwner,'service_role','authenticated','anon'])await platformDenied(runtime,`SET ROLE ${role}`);
   await platformDenied(runtime,'SET SESSION AUTHORIZATION v13_test');
   const client=await runtime.connect();
   try{await client.query('RESET ROLE');await assertPlatformIdentity(client);}finally{client.release();}
   await platformDenied(runtime,'CREATE TABLE public.forbidden_runtime_table(id int)');
   await platformDenied(runtime,'SELECT * FROM vault.secrets');
  });
  await t.test('managed Auth ownership, zero Auth policies, browser profile policy and SELECT-only ACL are explicit',async()=>{
   const auth=(await setup.query(`SELECT pg_get_userbyid(relowner) AS owner,relrowsecurity AS rls,relforcerowsecurity AS force,
    (SELECT count(*)::int FROM pg_policy WHERE polrelid=c.oid) AS policies FROM pg_class c WHERE oid='auth.users'::regclass`)).rows[0];
   assert.deepEqual(auth,{owner:platformManagedOwner,rls:true,force:false,policies:0});
   const profiles=(await setup.query(`SELECT pg_get_userbyid(relowner) AS owner,relrowsecurity AS rls,relforcerowsecurity AS force,
    (SELECT count(*)::int FROM pg_policy WHERE polrelid=c.oid) AS policies FROM pg_class c WHERE oid='public.profiles'::regclass`)).rows[0];
   assert.deepEqual(profiles,{owner:backendRole,rls:true,force:false,policies:2});
   assert.deepEqual((await setup.query(`SELECT has_table_privilege('authenticated','public.profiles','SELECT') AS read,
    has_any_column_privilege('authenticated','public.profiles','UPDATE') AS write`)).rows[0],{read:true,write:false});
   const functions=(await setup.query(`SELECT proname,prosecdef,provolatile,pg_get_userbyid(proowner) AS owner,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(proacl,acldefault('f',proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc
    WHERE oid IN ('auth.uid()'::regprocedure,'auth.jwt()'::regprocedure,'auth.role()'::regprocedure) ORDER BY proname`)).rows;
   assert.equal(functions.length,3);
   for(const f of functions){assert.equal(f.prosecdef,false);assert.equal(f.provolatile,'s');assert.equal(f.owner,platformManagedOwner);assert.equal(f.public_execute,true);}
   for(const table of platformDependencies){await platformDenied(runtime,`SELECT * FROM ${table}`);await platformDenied(other,`SELECT * FROM ${table}`);}
   assert.equal((await inspectRuntimeDbSession(baseline.reviewer,runtime)).reason,'runtime_db_session_unavailable');
  });
  await t.test('own-profile MFA policy shapes do not confer UPDATE or independent-reviewer visibility',async()=>{
   await claims(baseline.owner,'aal2',async client=>{
    assert.deepEqual((await client.query('SELECT id,role FROM public.profiles ORDER BY id')).rows,[{id:baseline.owner,role:'STANDARD'}]);
    await platformDenied(client,"UPDATE public.profiles SET role='ADMIN' WHERE id=$1",[baseline.owner]);
   });
   await claims(baseline.owner,'aal2',client=>platformDenied(client,'UPDATE public.profiles SET id=id WHERE id=$1',[baseline.owner]));
   await claims(baseline.owner,'aal1',async client=>assert.equal((await client.query('SELECT id FROM public.profiles')).rows.length,0));
   await setup.query('UPDATE public.mfa_login_policy SET required_for_all=false WHERE id=true');
   try{
    await claims(baseline.owner,'aal1',async client=>assert.deepEqual((await client.query('SELECT id FROM public.profiles')).rows,[{id:baseline.owner}]));
    await setup.query('UPDATE public.mfa_user_preferences SET required_for_sign_in=true WHERE user_id=$1',[baseline.owner]);
    await claims(baseline.owner,'aal1',async client=>assert.equal((await client.query('SELECT id FROM public.profiles')).rows.length,0));
   }finally{
    await setup.query('UPDATE public.mfa_login_policy SET required_for_all=true WHERE id=true');
    await setup.query('UPDATE public.mfa_user_preferences SET required_for_sign_in=false WHERE user_id=$1',[baseline.owner]);
   }
  });
  await t.test('SELECT ACL alone and forged claim GUCs leave worker Auth/profile rows invisible',async()=>{
   for(const table of platformDependencies)await setup.query(`GRANT SELECT ON ${table} TO ${platformRuntimeRole}`);
   await rollbackPlatform(runtime,async client=>{
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[baseline.reviewer,JSON.stringify({sub:baseline.reviewer,aal:'aal2',role:'authenticated'})]);
    for(const table of platformDependencies)assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0,table);
   });
   assert.equal((await inspectRuntimeDbSession(baseline.reviewer,runtime)).reason,'confirmed_administrator_required');
   for(const table of platformDependencies)await platformDenied(runtime,`SELECT * FROM ${table} FOR SHARE`);
   // Counterexample: an unforced table owner bypasses RLS. Test setup may use
   // SET LOCAL ROLE; worker calls always use their independent LOGIN pool.
   await rollbackPlatform(setup,async client=>{
    await client.query(`SET LOCAL ROLE ${platformManagedOwner}`);
    assert.equal((await client.query('SELECT id FROM auth.users WHERE id=$1',[baseline.owner])).rows.length,1);
    assert.equal((await client.query('UPDATE auth.users SET id=id WHERE id=$1',[baseline.owner])).rowCount,1);
   });
  });

  // Explicit synthetic experiment delta. These are not observed production
  // grants or a recommendation to add worker policies to managed Auth tables.
  await installPlatformCapabilities(setup);
  await t.test('real successor SQL and confirmed-ADMIN gate run through restricted native sessions',async()=>{
   const s=await seedPlatformAuth(setup),human=await platformHumanSnapshot(setup,s),profiles=await profileSnapshot(s);
   assert.equal((await setup.query('SELECT expires_at<clock_timestamp() AS expired FROM private.strata_api_fee_source_grants WHERE grant_id=$1',[s.feeGrant])).rows[0].expired,true);
   const observed=observePlatformQueries(runtime),proof=await authority(s,observed.db);
   assert.equal(proof.ok,true);assert.equal(proof.proofKind,'standing_successor');
   assert.match(proof.authorityFingerprint??'',/^[0-9a-f]{64}$/);assert.ok((proof.validForMs??0)>0);
   assert.ok(observed.statements.includes(REVIEW_SQL));assert.ok(observed.statements.includes(SUCCESSOR_SQL));assert.deepEqual(observed.errors,[]);
   assert.equal((await inspectRuntimeDbSession(s.reviewer,runtime)).ok,true);
   assert.equal((await inspectRuntimeDbSession(s.owner,runtime)).reason,'confirmed_administrator_required');
   let reads=0;
   const full=await verifyReviewedProtectiveExitFee(s.owner,s.account,'KXBTC15M-SYNTHETIC',{db:runtime,sha:()=>s.sha,
    readFee:async ticker=>{reads++;return {ok:true,marketOpen:true,marketTicker:ticker,fingerprint:'f'.repeat(64),observedAtMs:Date.now()};}});
   assert.equal(reads,1);assert.equal(full.ok,true);assert.equal(full.reason,'protective_fee_approved_standing_model_and_current_api');
   assert.equal(full.policyApproved,false);assert.equal(full.tradingAuthorized,false);
   assert.deepEqual(await platformHumanSnapshot(setup,s),human,'human authority rows unchanged');
   assert.deepEqual(await profileSnapshot(s),profiles);
   for(const table of platformDependencies)await platformDenied(other,`SELECT * FROM ${table}`);
  });
  await t.test('every native authority lock needs its narrow UPDATE column, not table-wide UPDATE',async()=>{
   const s=await seedPlatformAuth(setup);
   for(const [table,column] of Object.entries(platformLockColumns)){
    assert.deepEqual((await runtime.query('SELECT has_table_privilege(current_user,$1,\'UPDATE\') AS broad,has_column_privilege(current_user,$1,$2,\'UPDATE\') AS narrow',[table,column])).rows[0],{broad:false,narrow:true});
    await setup.query(`REVOKE UPDATE(${column}) ON ${table} FROM ${platformRuntimeRole}`);
    try{
     const observed=observePlatformQueries(runtime);
     assert.equal((await authority(s,observed.db)).reason,'protective_fee_historic_review_unavailable',table);
     assert.deepEqual(observed.errors,['42501'],table);
    }finally{await setup.query(`GRANT UPDATE(${column}) ON ${table} TO ${platformRuntimeRole}`);}
   }
   assert.equal((await authority(s)).ok,true);
  });
  await t.test('platform SELECT privilege, SELECT policy and UPDATE visibility are independent gates',async()=>{
   const s=await seedPlatformAuth(setup);
   for(const table of platformDependencies){
    await setup.query(`REVOKE SELECT ON ${table} FROM ${platformRuntimeRole}`);
    try{
     const observed=observePlatformQueries(runtime);
     assert.equal((await authority(s,observed.db)).reason,'protective_fee_historic_review_unavailable');assert.deepEqual(observed.errors,['42501']);
    }finally{await setup.query(`GRANT SELECT ON ${table} TO ${platformRuntimeRole}`);}
    await setup.query(`DROP POLICY platform_runtime_read ON ${table}`);
    try{
     const observed=observePlatformQueries(runtime);
     assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
     assert.equal((await authority(s,observed.db)).reason,'protective_fee_standing_successor_missing');assert.deepEqual(observed.errors,[]);
    }finally{await setup.query(`CREATE POLICY platform_runtime_read ON ${table} FOR SELECT TO ${platformRuntimeRole} USING(true)`);}
    await setup.query(`DROP POLICY platform_runtime_lock ON ${table}`);
    try{
     const observed=observePlatformQueries(runtime);
     assert.equal((await authority(s,observed.db)).reason,'protective_fee_standing_successor_missing');assert.deepEqual(observed.errors,[]);
    }finally{await setup.query(`CREATE POLICY platform_runtime_lock ON ${table} FOR UPDATE TO ${platformRuntimeRole} USING(true) WITH CHECK(true)`);}
   }
   assert.equal((await authority(s)).ok,true);
  });
  await t.test('lock-only ACL rejects no-op/change/insert/delete without mutating human approvals',async()=>{
   const s=await seedPlatformAuth(setup),before=await platformHumanSnapshot(setup,s),profiles=await profileSnapshot(s);
   for(const [table,column] of Object.entries(platformLockColumns)){
    await platformDenied(runtime,`UPDATE ${table} SET ${column}=${column}`,[],['42501','P0001']);
    await platformDenied(runtime,`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`);
    await platformDenied(runtime,`DELETE FROM ${table} WHERE false`);
    await platformDenied(runtime,`TRUNCATE ${table}`);
   }
   const mutations:[string,unknown[]][]=[
    ["UPDATE auth.users SET email='forged@example.invalid' WHERE id=$1",[s.reviewer]],
    ['UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',[s.issuer]],
    ["UPDATE public.profiles SET role='ADMIN' WHERE id=$1",[s.owner]],
    ["UPDATE private.role_assignments SET role='ADMIN' WHERE email=$1",[s.owner+'@example.invalid']],
    ['UPDATE private.strata_api_fee_standing_delegations SET lease_expires_at=clock_timestamp() WHERE delegation_id=$1',[s.delegation]],
    ['UPDATE private.strata_api_fee_standing_models SET valid_until=valid_until+interval \'1 minute\' WHERE model_id=$1',[s.model]],
    ['UPDATE private.strata_api_fee_source_grants SET expires_at=expires_at+interval \'1 minute\' WHERE grant_id=$1',[s.feeGrant]],
    ['UPDATE private.strata_standing_execution_reviews SET revoked_at=clock_timestamp(),revocation_reason=\'synthetic forged revocation\' WHERE release_id=$1',[s.review]],
    ['UPDATE private.strata_continuous_execution_grants SET grant_id=grant_id WHERE grant_id=$1',[s.grant]],
    ['UPDATE private.strata_owner_sha_approvals SET qualification_digest=qualification_digest WHERE owner_user_id=$1',[s.owner]],
   ];
   for(const [sql,args] of mutations)await platformDenied(runtime,sql,args);
   await platformDenied(runtime,'UPDATE public.profiles SET id=$1 WHERE id=$2',[randomUUID(),s.owner]);
   assert.deepEqual(await platformHumanSnapshot(setup,s),before);assert.deepEqual(await profileSnapshot(s),profiles);
  });
  await t.test('restrictive mutation guard survives an extra permissive policy; removing it is a counterexample',async()=>{
   const s=await seedPlatformAuth(setup);
   for(const [table,column,id] of [['auth.users','id',s.owner],['public.profiles','id',s.owner],['private.role_assignments','email',s.reviewer+'@example.invalid']]){
    await setup.query(`CREATE POLICY synthetic_overbroad_update ON ${table} FOR UPDATE TO ${platformRuntimeRole} USING(true) WITH CHECK(true)`);
    try{
     await platformDenied(runtime,`UPDATE ${table} SET ${column}=${column} WHERE ${column}=$1`,[id]);
     await setup.query(`DROP POLICY platform_runtime_no_mutation ON ${table}`);
     try{
      await rollbackPlatform(runtime,async client=>assert.equal((await client.query(`UPDATE ${table} SET ${column}=${column} WHERE ${column}=$1`,[id])).rowCount,1));
     }finally{await setup.query(`CREATE POLICY platform_runtime_no_mutation ON ${table} AS RESTRICTIVE FOR UPDATE TO ${platformRuntimeRole} USING(true) WITH CHECK(false)`);}
    }finally{await setup.query(`DROP POLICY synthetic_overbroad_update ON ${table}`);}
   }
  });
  await t.test('unconfirmed, ordinary, missing and revoked authorities never fall back to the valid legacy rate review',async()=>{
   const cases:[string,(s:PlatformScope)=>unknown[],string][]=[
    ['UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',s=>[s.issuer],'protective_fee_standing_successor_missing'],
    ['UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',s=>[s.reviewer],'protective_fee_standing_successor_missing'],
    ["UPDATE private.role_assignments SET role='USER' WHERE email=$1",s=>[s.issuer+'@example.invalid'],'protective_fee_standing_successor_missing'],
    ["UPDATE private.role_assignments SET role='USER' WHERE email=$1",s=>[s.reviewer+'@example.invalid'],'protective_fee_standing_successor_missing'],
    ['DELETE FROM private.role_assignments WHERE email=$1',s=>[s.issuer+'@example.invalid'],'protective_fee_standing_successor_missing'],
    ["UPDATE public.profiles SET role='STANDARD' WHERE id=$1",s=>[s.reviewer],'protective_fee_standing_successor_missing'],
    ['DELETE FROM public.profiles WHERE id=$1',s=>[s.reviewer],'protective_fee_standing_successor_missing'],
    ['UPDATE private.strata_api_fee_standing_models SET revoked_at=clock_timestamp() WHERE model_id=$1',s=>[s.model],'protective_fee_standing_successor_missing'],
    ['UPDATE private.strata_api_fee_standing_delegations SET revoked_at=clock_timestamp() WHERE delegation_id=$1',s=>[s.delegation],'protective_fee_standing_successor_missing'],
    ["UPDATE private.strata_standing_execution_reviews SET revoked_at=clock_timestamp(),revocation_reason='synthetic fixture revocation' WHERE release_id=$1",s=>[s.review],'protective_fee_standing_successor_missing'],
    ['UPDATE private.strata_api_fee_source_grants SET revoked_at=clock_timestamp() WHERE grant_id=$1',s=>[s.feeGrant],'protective_fee_independent_owner_review_missing'],
    ['UPDATE private.strata_api_fee_owner_consents SET revoked_at=clock_timestamp() WHERE owner_user_id=$1',s=>[s.owner],'protective_fee_independent_owner_review_missing'],
    ['UPDATE private.strata_api_fee_rate_reviews SET revoked_at=clock_timestamp() WHERE owner_user_id=$1',s=>[s.owner],'protective_fee_independent_owner_review_missing'],
   ];
   for(const [sql,args,reason] of cases){
    const s=await seedPlatformAuth(setup);assert.equal((await authority(s)).ok,true);
    await setup.query(sql,args(s));
    const before=await platformHumanSnapshot(setup,s),observed=observePlatformQueries(runtime);
    assert.equal((await authority(s,observed.db)).reason,reason,sql);assert.deepEqual(observed.errors,[]);
    assert.deepEqual(await platformHumanSnapshot(setup,s),before);
   }
   const s=await seedPlatformAuth(setup);
   await setup.query("UPDATE public.profiles SET role='DEVELOPER' WHERE id=$1",[s.reviewer]);
   assert.equal((await authority(s)).ok,true,'actual successor accepts the separately recorded DEVELOPER reviewer profile');
   const model=(await setup.query('SELECT * FROM private.strata_api_fee_standing_models WHERE model_id=$1',[s.model])).rows[0];
   await setup.query(`INSERT INTO private.strata_api_fee_standing_models(model_id,reviewer_admin_id,rate_decision_digest,fee_model_version,scope,release_commit_sha,evidence_url,evidence_sha256,evidence_note,valid_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),model.reviewer_admin_id,model.rate_decision_digest,model.fee_model_version,model.scope,model.release_commit_sha,model.evidence_url,model.evidence_sha256,model.evidence_note,model.valid_until]);
   assert.equal((await authority(s)).reason,'protective_fee_standing_successor_missing','competing same-SHA model fails closed');
  });
  await t.test('actual verifier SHARE locks fence revocation and role/confirmation/profile loss until transaction end',async()=>{
   const changes:[string,(s:PlatformScope)=>unknown[]][]=[
    ['UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',s=>[s.issuer]],
    ['UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',s=>[s.reviewer]],
    ["UPDATE private.role_assignments SET role='USER' WHERE email=$1",s=>[s.issuer+'@example.invalid']],
    ["UPDATE private.role_assignments SET role='USER' WHERE email=$1",s=>[s.reviewer+'@example.invalid']],
    ["UPDATE public.profiles SET role='STANDARD' WHERE id=$1",s=>[s.reviewer]],
    ['UPDATE private.strata_api_fee_standing_models SET revoked_at=clock_timestamp() WHERE model_id=$1',s=>[s.model]],
    ['UPDATE private.strata_api_fee_standing_delegations SET revoked_at=clock_timestamp() WHERE delegation_id=$1',s=>[s.delegation]],
    ["UPDATE private.strata_standing_execution_reviews SET revoked_at=clock_timestamp(),revocation_reason='synthetic locked revocation' WHERE release_id=$1",s=>[s.review]],
   ];
   for(const [sql,args] of changes){
    const s=await seedPlatformAuth(setup);
    await rollbackPlatform(runtime,async client=>{
     const observed=observePlatformQueries(client);
     assert.equal((await authority(s,observed.db)).ok,true);assert.ok(observed.statements.includes(SUCCESSOR_SQL));
     await rollbackPlatform(setup,async writer=>{
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(writer.query(sql,args(s)),{code:'55P03'});
     });
    });
    await setup.query(sql,args(s));
    assert.equal((await authority(s)).ok,false,'committed change blocks next observation');
   }
  });
 }catch(error){failures.push(error);}
 finally{
  const closed=await Promise.allSettled([runtime.end(),other.end(),setup.end()]);
  failures.push(...closed.flatMap(r=>r.status==='rejected'?[r.reason]:[]));
 }
 if(failures.length===1)throw failures[0];
 if(failures.length>1)throw new AggregateError(failures,'platform_test_and_cleanup_failed');
});
