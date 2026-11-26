import test from 'node:test';
import assert from 'node:assert/strict';
import {renewContinuousTechnicalLease,checkContinuousEligibility,revokeContinuousGrant,CONTINUOUS_OWNER_REVOKE} from './continuousExecutionAuthorization';
import {renewStandingFeeObservationLease,revokeStandingFeeDelegation} from './apiFeeStandingDelegation';
import {openRestrictedStandingRenewal,assertStandingIdentity,seedStandingRenewal,standingProof,
 standingHumanSnapshot,standingTechnicalSnapshot,observeStandingQueries,rollbackStanding,standingDenied,
 standingRuntimeRole,renewalLockOnly,feeLockOnly,humanAuthority,technicalLease,technicalAudit,feeDelegation,
 technicalLeaseInsertColumns,technicalLeaseUpdateColumns,technicalAuditInsertColumns,type StandingScope} from './restrictedStandingRenewal.fixture';

// Run ONLY through scripts/run-v13-disposable-postgres.mjs, with no flags or
// environment overrides. Native PostgreSQL is required; there is no fallback.
test('restricted LOGIN renews technical standing leases, never human authority',{timeout:120000},async t=>{
 const {setup,runtime}=await openRestrictedStandingRenewal();
 const renewFee=(s:StandingScope,stage='ORDER_ENTRY')=>renewStandingFeeObservationLease(s.owner,s.feeGrant,stage,{db:runtime,sha:()=>s.sha});
 const due=async(s:StandingScope)=>{
  await setup.query(`UPDATE ${technicalLease} SET observed_at=clock_timestamp()-interval '4 minutes',
   expires_at=clock_timestamp()-interval '1 second' WHERE grant_id=$1`,[s.grant]);
  await setup.query('UPDATE private.kalshi_account_worker_lease SET heartbeat_at=clock_timestamp() WHERE execution_account_id=$1',[s.account]);
 };
 try{
  await t.test('real nonowner session cannot regain bootstrap authority',async()=>{
   await assertStandingIdentity(runtime);
   await standingDenied(runtime,'SET ROLE v13_test');
   await standingDenied(runtime,'SET ROLE unknown_recovery_backend');
   await standingDenied(runtime,'SET ROLE service_role');
   const client=await runtime.connect();
   try{await client.query('RESET ROLE');await assertStandingIdentity(client);}finally{client.release();}
   assert.equal((await runtime.query("SELECT to_regclass('public.profiles') IS NULL AS absent")).rows[0].absent,true);
   await standingDenied(runtime,'SELECT * FROM vault.secrets');
  });

  await t.test('real renewal inserts and rotates a five-minute lease and immutable technical audit',async()=>{
   const s=await seedStandingRenewal(setup),human=await standingHumanSnapshot(setup,s);
   assert.equal(await checkContinuousEligibility(runtime,s.owner,s.sha),false);
   const first=await renewContinuousTechnicalLease(standingProof(s),{db:runtime});
   assert.deepEqual(first,{ok:true,reason:'standing_short_technical_lease_renewed',earlyRotationDeferred:false,ordersSubmitted:false,workerStarted:false});
   const one=await standingTechnicalSnapshot(setup,s);
   assert.equal(one.lease.length,1);assert.equal(one.lease[0].row.generation,1);
   assert.equal(one.audit.length,1);assert.equal(one.audit[0].row.kind,'LEASE_RENEWED');
   assert.equal(one.lease[0].row.evidence_digest,one.audit[0].row.evidence_digest);
   assert.equal(Date.parse(one.lease[0].row.expires_at)-Date.parse(one.lease[0].row.observed_at),300000);
   assert.equal(await checkContinuousEligibility(runtime,s.owner,s.sha),true);
   assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).reason,'standing_short_technical_lease_current');
   assert.deepEqual(await standingTechnicalSnapshot(setup,s),one,'preliminary reuse writes no lease or audit');
   await due(s);
   assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).reason,'standing_short_technical_lease_renewed');
   const two=await standingTechnicalSnapshot(setup,s);
   assert.equal(two.lease[0].row.generation,2);assert.equal(two.audit.length,2);
   assert.deepEqual(await standingHumanSnapshot(setup,s),human,'human approval bytes and expiries unchanged');
   // Identity generation is not a reason to give the service sequence access.
   await standingDenied(runtime,"SELECT nextval('private.strata_continuous_execution_audit_audit_id_seq')");
   await standingDenied(runtime,"SELECT setval('private.strata_continuous_execution_audit_audit_id_seq',1)");
   await standingDenied(runtime,`SELECT * FROM ${technicalAudit}`);
  });

  await t.test('every lock-only relation needs an UPDATE column despite having SELECT',async()=>{
   const s=await seedStandingRenewal(setup);
   for(const [table,column] of Object.entries(renewalLockOnly)){
    await due(s);
    const before=await standingTechnicalSnapshot(setup,s);
    await setup.query(`REVOKE UPDATE(${column}) ON ${table} FROM ${standingRuntimeRole}`);
    try{
     const observed=observeStandingQueries(runtime);
     assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:observed.db})).reason,'standing_lease_renewal_unavailable',table);
     assert.deepEqual(observed.errors,[{code:'42501',operation:'SELECT'}],table);
     assert.deepEqual(await standingTechnicalSnapshot(setup,s),before,table);
    }finally{await setup.query(`GRANT UPDATE(${column}) ON ${table} TO ${standingRuntimeRole}`);}
   }
   assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).ok,true);
  });

  await t.test('exact technical INSERT and UPDATE columns are required by the real upsert',async()=>{
   const s=await seedStandingRenewal(setup);
   for(const [operation,columns] of [['INSERT',technicalLeaseInsertColumns],['UPDATE',technicalLeaseUpdateColumns]] as const){
    for(const column of columns){
     await due(s);
     const before=await standingTechnicalSnapshot(setup,s);
     await setup.query(`REVOKE ${operation}(${column}) ON ${technicalLease} FROM ${standingRuntimeRole}`);
     try{
      const observed=observeStandingQueries(runtime);
      assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:observed.db})).reason,'standing_lease_renewal_unavailable',operation+' '+column);
      assert.deepEqual(observed.errors,[{code:'42501',operation:'INSERT'}],operation+' '+column);
      assert.deepEqual(await standingTechnicalSnapshot(setup,s),before);
     }finally{await setup.query(`GRANT ${operation}(${column}) ON ${technicalLease} TO ${standingRuntimeRole}`);}
    }
   }
   assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).ok,true);
  });

  await t.test('late audit permission failure rolls back both a new lease and an existing generation',async()=>{
   const s=await seedStandingRenewal(setup),human=await standingHumanSnapshot(setup,s);
   for(const existing of [false,true]){
    if(existing){assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).ok,true);await due(s);}
    for(const column of technicalAuditInsertColumns){
     await due(s);
     const before=await standingTechnicalSnapshot(setup,s),executed:string[]=[];
     const observed=observeStandingQueries(runtime,async sql=>{
      if(sql.includes('ON CONFLICT(grant_id) DO UPDATE'))executed.push('technical_upsert_completed');
     });
     await setup.query(`REVOKE INSERT(${column}) ON ${technicalAudit} FROM ${standingRuntimeRole}`);
     try{
      assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:observed.db})).reason,'standing_lease_renewal_unavailable');
      assert.deepEqual(executed,['technical_upsert_completed']);
      assert.deepEqual(observed.errors,[{code:'42501',operation:'INSERT'}]);
      assert.deepEqual(await standingTechnicalSnapshot(setup,s),before,'lease and audit atomically roll back after '+column+' refusal');
     }finally{await setup.query(`GRANT INSERT(${column}) ON ${technicalAudit} TO ${standingRuntimeRole}`);}
    }
   }
   assert.deepEqual(await standingHumanSnapshot(setup,s),human);
  });

  await t.test('human issuance, revocation, value changes and forged human audit kinds remain denied',async()=>{
   const s=await seedStandingRenewal(setup),before=await standingHumanSnapshot(setup,s);
   assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).ok,true);
   const technicalBefore=await standingTechnicalSnapshot(setup,s);
   assert.equal(technicalBefore.audit.length,1,'negative technical mutation probes must match real rows');
   for(const table of humanAuthority){
    assert.deepEqual((await runtime.query(`SELECT has_table_privilege(current_user,$1,'INSERT') AS insert,
     has_table_privilege(current_user,$1,'UPDATE') AS update,has_table_privilege(current_user,$1,'DELETE') AS delete`,[table])).rows[0],
    {insert:false,update:false,delete:false},table);
    const predicate=table==='private.strata_api_fee_standing_models'?'model_id=$1':'owner_user_id=$1';
    const id=table==='private.strata_api_fee_standing_models'?s.model:s.owner;
    await standingDenied(runtime,`INSERT INTO ${table} SELECT * FROM ${table} WHERE ${predicate}`,[id]);
    await standingDenied(runtime,`DELETE FROM ${table} WHERE ${predicate}`,[id]);
    await standingDenied(runtime,`UPDATE ${table} SET revoked_at=clock_timestamp() WHERE ${predicate}`,[id]);
    const immutableColumn=table==='private.strata_api_fee_standing_models'?'reviewer_admin_id':'owner_user_id';
    await standingDenied(runtime,`UPDATE ${table} SET ${immutableColumn}=${immutableColumn} WHERE ${predicate}`,[id]);
   }
   // Row locks need a column UPDATE grant. A permissive policy cannot override
   // the restrictive barrier. Existing BEFORE-row immutable guards may reject
   // first (P0001); never disable them just to force an RLS-specific SQLSTATE.
   for(const [table,column] of Object.entries({...renewalLockOnly,...feeLockOnly})){
    await setup.query(`CREATE POLICY standing_renewal_accidental_widening ON ${table} FOR UPDATE TO ${standingRuntimeRole} USING(true) WITH CHECK(true)`);
    try{await standingDenied(runtime,`UPDATE ${table} SET ${column}=${column}`,[],['42501','P0001']);}
    finally{await setup.query(`DROP POLICY standing_renewal_accidental_widening ON ${table}`);}
   }
   await standingDenied(runtime,'UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',[s.reviewer]);
   await standingDenied(runtime,"UPDATE private.role_assignments SET role='USER' WHERE email=$1::text||'@example.invalid'",[s.reviewer]);
   for(const column of ['owner_user_id','model_id','grant_id','policy_hash','release_commit_sha','confirmation','granted_at','valid_until']){
    await standingDenied(runtime,`UPDATE ${feeDelegation} SET ${column}=${column} WHERE delegation_id=$1`,[s.delegation]);
   }
   for(const kind of ['GRANT_AUTHORIZED','GRANT_REVOKED']){
    await standingDenied(runtime,`INSERT INTO ${technicalAudit}(grant_id,execution_account_id,kind,evidence_digest,reason)
     VALUES($1,$2,$3,$4,'signed_owned_reconciliation')`,[s.grant,s.account,kind,s.hash]);
   }
   await standingDenied(runtime,`UPDATE ${technicalAudit} SET reason='synthetic forbidden edit' WHERE grant_id=$1`,[s.grant]);
   await standingDenied(runtime,`DELETE FROM ${technicalAudit} WHERE grant_id=$1`,[s.grant]);
   for(const column of ['grant_id','execution_account_id']){
    await standingDenied(runtime,`UPDATE ${technicalLease} SET ${column}=${column} WHERE grant_id=$1`,[s.grant]);
   }
   assert.equal((await revokeContinuousGrant(s.owner,{confirmation:CONTINUOUS_OWNER_REVOKE,expectedSha:s.sha},{db:runtime,sha:()=>s.sha})).reason,'standing_revocation_unavailable');
   assert.equal((await revokeStandingFeeDelegation(s.owner,{delegationId:s.delegation,confirmation:'REVOKE_MY_STANDING_FEE_DELEGATION',reason:'synthetic denied revocation'},{db:runtime})).reason,'standing_fee_revocation_unavailable');
   assert.deepEqual(await standingHumanSnapshot(setup,s),before);
   assert.deepEqual(await standingTechnicalSnapshot(setup,s),technicalBefore);
  });

  await t.test('old worker fences, cash mismatch and invalid signed evidence cannot renew',async()=>{
   const s=await seedStandingRenewal(setup);
   assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).ok,true);
   const before=await standingTechnicalSnapshot(setup,s);
   for(const drift of [{cashMicros:'1'},{fencingToken:'8'},{policyHash:'c'.repeat(64)},{releaseSha:'c'.repeat(40)},
    {authenticated:false},{complete:false},{unexplainedCashActivity:true},{observedAtMs:Date.now()-16000}]){
    assert.equal((await renewContinuousTechnicalLease({...standingProof(s),...drift},{db:runtime})).ok,false);
    assert.deepEqual(await standingTechnicalSnapshot(setup,s),before);
   }
   await setup.query('UPDATE private.kalshi_account_worker_lease SET fencing_token=8 WHERE execution_account_id=$1',[s.account]);
   assert.equal(await checkContinuousEligibility(runtime,s.owner,s.sha),false);
   assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).ok,false);
   assert.deepEqual(await standingTechnicalSnapshot(setup,s),before);
   assert.equal((await renewContinuousTechnicalLease({...standingProof(s),fencingToken:'8'},{db:runtime})).reason,'standing_short_technical_lease_renewed');
   const after=await standingTechnicalSnapshot(setup,s);
   assert.equal(after.lease[0].row.fencing_token,8);assert.equal(after.lease[0].row.generation,2);
  });

  await t.test('revocation and account/worker gates invalidate an already current continuous lease',async()=>{
   const cases=[
    "UPDATE private.strata_continuous_execution_grants SET revoked_at=clock_timestamp(),revocation_reason='synthetic owner revocation' WHERE owner_user_id=$1",
    "UPDATE private.strata_standing_execution_reviews SET revoked_at=clock_timestamp(),revocation_reason='synthetic review revocation' WHERE owner_user_id=$1",
    'UPDATE private.strata_owner_sha_approvals SET revoked_at=clock_timestamp() WHERE owner_user_id=$1',
    'UPDATE public.v13_production_account SET kill_switch=true WHERE owner_user_id=$1',
    "UPDATE private.kalshi_account_worker_lease SET heartbeat_at=clock_timestamp()-interval '16 seconds' WHERE owner_user_id=$1",
   ];
   for(const change of cases){
    const s=await seedStandingRenewal(setup);
    assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).ok,true);
    await setup.query(change,[s.owner]);
    const before=await standingTechnicalSnapshot(setup,s),human=await standingHumanSnapshot(setup,s);
    assert.equal(await checkContinuousEligibility(runtime,s.owner,s.sha),false);
    assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).ok,false);
    assert.deepEqual(await standingTechnicalSnapshot(setup,s),before);
    assert.deepEqual(await standingHumanSnapshot(setup,s),human);
   }
  });

  await t.test('actual renewal locks fence concurrent revocation, and committed revocation blocks reuse',async()=>{
   const s=await seedStandingRenewal(setup);
   let announce!:()=>void,release!:()=>void;
   const locked=new Promise<void>(resolve=>{announce=resolve;}),continueRenewal=new Promise<void>(resolve=>{release=resolve;});
   const observed=observeStandingQueries(runtime,async sql=>{
    if(sql.includes('FOR UPDATE OF g,w FOR SHARE OF r,oa,p,a')){announce();await continueRenewal;}
   });
   const pending=renewContinuousTechnicalLease(standingProof(s),{db:observed.db});
   try{
    await Promise.race([locked,pending.then(()=>{throw Error('renewal_finished_before_native_lock_probe');})]);
    await rollbackStanding(setup,async writer=>{
     await writer.query("SET LOCAL lock_timeout='100ms'");
     await assert.rejects(writer.query(`UPDATE private.strata_continuous_execution_grants
      SET revoked_at=clock_timestamp(),revocation_reason='synthetic concurrent revocation' WHERE grant_id=$1`,[s.grant]),{code:'55P03'});
    });
   }finally{release();await pending;}
   assert.equal((await pending).ok,true);
   await setup.query(`UPDATE private.strata_continuous_execution_grants SET revoked_at=clock_timestamp(),
    revocation_reason='synthetic committed revocation' WHERE grant_id=$1`,[s.grant]);
   const before=await standingTechnicalSnapshot(setup,s);
   assert.equal((await renewContinuousTechnicalLease(standingProof(s),{db:runtime})).ok,false);
   assert.equal(await checkContinuousEligibility(runtime,s.owner,s.sha),false);
   assert.deepEqual(await standingTechnicalSnapshot(setup,s),before);
  });

  await t.test('fee continuation changes only technical expiry, including an expired bootstrap grant',async()=>{
   const s=await seedStandingRenewal(setup),before=await standingHumanSnapshot(setup,s);
   const initial=(await setup.query(`SELECT lease_expires_at FROM ${feeDelegation} WHERE delegation_id=$1`,[s.delegation])).rows[0].lease_expires_at;
   for(const stage of ['STEP_11','ORDER_ENTRY'])assert.equal((await renewFee(s,stage)).ok,true);
   const lease=(await setup.query(`SELECT lease_expires_at>clock_timestamp()+interval '14 minutes' AS renewed,
    lease_expires_at<=valid_until AS bounded,lease_expires_at FROM ${feeDelegation} WHERE delegation_id=$1`,[s.delegation])).rows[0];
   assert.equal(lease.renewed,true);assert.equal(lease.bounded,true);assert(lease.lease_expires_at>initial);
   assert.equal((await setup.query('SELECT expires_at<clock_timestamp() AS expired FROM private.strata_api_fee_source_grants WHERE grant_id=$1',[s.feeGrant])).rows[0].expired,true);
   assert.deepEqual(await standingHumanSnapshot(setup,s),before,'only delegation lease_expires_at may change');
   assert.equal((await renewFee(s,'STEP_9')).ok,false);
   await setup.query(`UPDATE ${feeDelegation} SET valid_until=clock_timestamp()+interval '2 minutes',lease_expires_at=clock_timestamp() WHERE delegation_id=$1`,[s.delegation]);
   assert.equal((await renewFee(s)).ok,true);
   assert.equal((await setup.query(`SELECT lease_expires_at=valid_until AS clipped FROM ${feeDelegation} WHERE delegation_id=$1`,[s.delegation])).rows[0].clipped,true);
  });

  await t.test('fee write privilege, Auth RLS visibility and role RLS visibility are separate gates',async()=>{
   const s=await seedStandingRenewal(setup);
   const snapshot=async()=>(await setup.query(`SELECT to_jsonb(t) AS row FROM ${feeDelegation} t WHERE delegation_id=$1`,[s.delegation])).rows;
   const before=await snapshot();
   await setup.query(`REVOKE UPDATE(lease_expires_at) ON ${feeDelegation} FROM ${standingRuntimeRole}`);
   try{
    const observed=observeStandingQueries(runtime);
    assert.equal((await renewStandingFeeObservationLease(s.owner,s.feeGrant,'ORDER_ENTRY',{db:observed.db,sha:()=>s.sha})).ok,false);
    assert.deepEqual(observed.errors,[{code:'42501',operation:'WITH'}]);assert.deepEqual(await snapshot(),before);
   }finally{await setup.query(`GRANT UPDATE(lease_expires_at) ON ${feeDelegation} TO ${standingRuntimeRole}`);}
   for(const table of ['auth.users','private.role_assignments']){
    await setup.query(`DROP POLICY standing_renewal_read ON ${table}`);
    try{
     assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0,'SELECT ACL alone gives no rows under RLS');
     assert.equal((await renewFee(s)).ok,false);assert.deepEqual(await snapshot(),before);
    }finally{await setup.query(`CREATE POLICY standing_renewal_read ON ${table} FOR SELECT TO ${standingRuntimeRole} USING(true)`);}
   }
   assert.equal((await renewFee(s)).ok,true);
  });

  await t.test('each fee authority row lock requires its narrow column privilege',async()=>{
   const s=await seedStandingRenewal(setup),before=await standingHumanSnapshot(setup,s);
   for(const [table,column] of Object.entries(feeLockOnly)){
    await setup.query(`REVOKE UPDATE(${column}) ON ${table} FROM ${standingRuntimeRole}`);
    try{
     const observed=observeStandingQueries(runtime);
     assert.equal((await renewStandingFeeObservationLease(s.owner,s.feeGrant,'ORDER_ENTRY',{db:observed.db,sha:()=>s.sha})).ok,false,table);
     assert.deepEqual(observed.errors,[{code:'42501',operation:'WITH'}],table);
     assert.deepEqual(await standingHumanSnapshot(setup,s),before);
    }finally{await setup.query(`GRANT UPDATE(${column}) ON ${table} TO ${standingRuntimeRole}`);}
   }
   assert.equal((await renewFee(s)).ok,true);
  });

  await t.test('fee renewal rolls back within the native caller transaction',async()=>{
   const s=await seedStandingRenewal(setup);
   const snapshot=async()=>(await setup.query(`SELECT to_jsonb(t) AS row FROM ${feeDelegation} t WHERE delegation_id=$1`,[s.delegation])).rows;
   const before=await snapshot();
   await rollbackStanding(runtime,async client=>{
    const db={query:(sql:string,args?:unknown[])=>client.query(sql,args),connect:async()=>{throw Error('fee continuation must not open another transaction');}};
    assert.equal((await renewStandingFeeObservationLease(s.owner,s.feeGrant,'ORDER_ENTRY',{db,sha:()=>s.sha})).ok,true);
    assert.equal((await client.query(`SELECT lease_expires_at>clock_timestamp() AS renewed FROM ${feeDelegation} WHERE delegation_id=$1`,[s.delegation])).rows[0].renewed,true);
   });
   assert.deepEqual(await snapshot(),before,'technical expiry is transactional');
  });

  await t.test('fee revocations and issuer/model reviewer roles block the next continuation',async()=>{
   const changes:[string,(s:StandingScope)=>string][]=[
    ['UPDATE private.strata_api_fee_standing_models SET revoked_at=clock_timestamp() WHERE model_id=$1',s=>s.model],
    [`UPDATE ${feeDelegation} SET revoked_at=clock_timestamp() WHERE delegation_id=$1`,s=>s.delegation],
    ['UPDATE private.strata_api_fee_source_grants SET revoked_at=clock_timestamp() WHERE grant_id=$1',s=>s.feeGrant],
    ['UPDATE private.strata_api_fee_owner_consents SET revoked_at=clock_timestamp() WHERE owner_user_id=$1',s=>s.owner],
    ['UPDATE private.strata_api_fee_rate_reviews SET revoked_at=clock_timestamp() WHERE owner_user_id=$1',s=>s.owner],
    ["UPDATE private.role_assignments SET role='USER' WHERE email=$1::text||'@example.invalid'",s=>s.issuer],
    ["UPDATE private.role_assignments SET role='USER' WHERE email=$1::text||'@example.invalid'",s=>s.reviewer],
    ['UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1',s=>s.reviewer],
    ["UPDATE public.v13_live_money_policy SET policy_hash=repeat('c',64) WHERE id=$1",s=>s.policy],
   ];
   for(const [change,id] of changes){
    const s=await seedStandingRenewal(setup);assert.equal((await renewFee(s)).ok,true);
    await setup.query(change,[id(s)]);
    const before=(await setup.query(`SELECT to_jsonb(t) AS row FROM ${feeDelegation} t WHERE delegation_id=$1`,[s.delegation])).rows;
    assert.equal((await renewFee(s)).ok,false);
    assert.deepEqual((await setup.query(`SELECT to_jsonb(t) AS row FROM ${feeDelegation} t WHERE delegation_id=$1`,[s.delegation])).rows,before);
   }
   const s=await seedStandingRenewal(setup);
   assert.equal((await renewStandingFeeObservationLease(s.owner,s.feeGrant,'ORDER_ENTRY',{db:runtime,sha:()=>'c'.repeat(40)})).ok,false,'exact deployed SHA cannot drift');
  });
 }finally{
  const closed=await Promise.allSettled([runtime.end(),setup.end()]);
  const failures=closed.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
  if(failures.length)throw new AggregateError(failures,'standing_fixture_cleanup_failed');
 }
});
