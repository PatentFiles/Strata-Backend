import test from 'node:test';
import assert from 'node:assert/strict';
import {openRestrictedPlatformVault,assertVaultIdentity,seedVaultSigner,probeVaultSigner,vaultDenied,
 vaultOwner,vaultRuntime,vaultUnrelated,vaultHelper,signerTables} from './restrictedPlatformVault.fixture';

// Native PostgreSQL only, through the unchanged canonical disposable runner.
// All projection values are deliberately invalid credential strings. No worker
// can start, and no provider, encryption extension or actual secret is used.
test('platform-shaped Vault view and invoker helper boundaries',{timeout:120000},async t=>{
 const {setup,runtime,unrelated}=await openRestrictedPlatformVault();
 const previousFetch=globalThis.fetch;
 const failures:unknown[]=[];
 globalThis.fetch=async()=>{throw Error('platform_vault_external_io_forbidden');};
 try{
  const a=await seedVaultSigner(setup,'owner-a'),b=await seedVaultSigner(setup,'owner-b');
  await t.test('restricted sessions cannot regain table owner or bootstrap authority',async()=>{
   await assertVaultIdentity(runtime);await assertVaultIdentity(unrelated,vaultUnrelated);
   for(const role of ['v13_test','unknown_recovery_backend','service_role',vaultOwner])await vaultDenied(runtime,`SET ROLE ${role}`);
   const client=await runtime.connect();
   try{await client.query('RESET ROLE');await assertVaultIdentity(client);}finally{client.release();}
   assert.notEqual(setup,runtime);
  });
  await t.test('view and base have managed owner, while helper runs with invoker rights',async()=>{
   const relations=(await setup.query(`SELECT relname,relkind,pg_get_userbyid(relowner) AS owner,
    relrowsecurity,relforcerowsecurity,reloptions FROM pg_class WHERE oid IN
    ('vault.secrets'::regclass,'vault.decrypted_secrets'::regclass) ORDER BY relname`)).rows;
   assert.deepEqual(relations,[
    {relname:'decrypted_secrets',relkind:'v',owner:vaultOwner,relrowsecurity:false,relforcerowsecurity:false,reloptions:null},
    {relname:'secrets',relkind:'r',owner:vaultOwner,relrowsecurity:false,relforcerowsecurity:false,reloptions:null},
   ]);
   const helper=(await setup.query(`SELECT pg_get_userbyid(proowner) AS owner,prosecdef,provolatile,
    l.lanname FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=$1::regprocedure`,[vaultHelper])).rows[0];
   assert.deepEqual(helper,{owner:vaultOwner,prosecdef:false,provolatile:'i',lanname:'plpgsql'});
   assert.equal((await setup.query(`SELECT count(*)::int AS n FROM aclexplode(
    (SELECT proacl FROM pg_proc WHERE oid=$1::regprocedure)) WHERE grantee=0`,[vaultHelper])).rows[0].n,0);
  });
  await t.test('real signer SQL reads owner-style projection without direct base SELECT',async()=>{
   for(const s of [a,b]){
    const probe=await probeVaultSigner(runtime,s.owner,s.account);
    assert.deepEqual(probe.errors,[]);assert.equal(probe.rows.length,1);assert.equal(probe.rows[0].length,1);
    assert.equal(probe.rows[0][0].decrypted_secret,s.dummy);
    assert.equal(probe.rows[0][0].vault_secret_id,s.secret);
    assert.equal(probe.rows[0][0].financial_account_id,s.financial);
   }
   await vaultDenied(runtime,'SELECT secret FROM vault.secrets');
   await vaultDenied(runtime,'SELECT id FROM vault.secrets');
  });
  await t.test('real signer query rejects wrong owner, account, fingerprint and revoked material',async()=>{
   for(const [owner,account] of [[b.owner,a.account],[a.owner,b.account],[a.owner,'missing-account']]){
    const probe=await probeVaultSigner(runtime,owner,account);assert.deepEqual(probe,{rows:[[]],errors:[]});
   }
   await setup.query('UPDATE private.kalshi_connection_credentials SET key_fingerprint=$2 WHERE id=$1',[a.credential,'b'.repeat(64)]);
   try{assert.deepEqual(await probeVaultSigner(runtime,a.owner,a.account),{rows:[[]],errors:[]});}
   finally{await setup.query('UPDATE private.kalshi_connection_credentials SET key_fingerprint=$2 WHERE id=$1',[a.credential,a.fingerprint]);}
   await setup.query('UPDATE private.kalshi_connection_credentials SET revoked_at=now() WHERE id=$1',[a.credential]);
   try{assert.deepEqual(await probeVaultSigner(runtime,a.owner,a.account),{rows:[[]],errors:[]});}
   finally{await setup.query('UPDATE private.kalshi_connection_credentials SET revoked_at=NULL WHERE id=$1',[a.credential]);}
  });
  await t.test('helper EXECUTE is independent of owner-style view SELECT and fails closed',async()=>{
   await setup.query(`REVOKE EXECUTE ON FUNCTION ${vaultHelper} FROM ${vaultRuntime}`);
   try{
    assert.equal((await runtime.query('SELECT id FROM vault.decrypted_secrets WHERE id=$1',[a.secret])).rows[0].id,a.secret,
     'an id-only projection must not be mistaken for a decrypt-helper test');
    await vaultDenied(runtime,'SELECT decrypted_secret FROM vault.decrypted_secrets WHERE id=$1',[a.secret]);
    const probe=await probeVaultSigner(runtime,a.owner,a.account);
    assert.deepEqual(probe,{rows:[],errors:['42501']});
   }finally{await setup.query(`GRANT EXECUTE ON FUNCTION ${vaultHelper} TO ${vaultRuntime}`);}
   assert.equal((await probeVaultSigner(runtime,a.owner,a.account)).rows[0][0].decrypted_secret,a.dummy);
  });
  await t.test('view and schema rights are separate from helper EXECUTE',async()=>{
   for(const permission of ['SELECT(id,decrypted_secret) ON vault.decrypted_secrets','USAGE ON SCHEMA vault']){
    await setup.query(`REVOKE ${permission} FROM ${vaultRuntime}`);
    try{assert.deepEqual(await probeVaultSigner(runtime,a.owner,a.account),{rows:[],errors:['42501']});}
    finally{await setup.query(`GRANT ${permission} TO ${vaultRuntime}`);}
   }
   await vaultDenied(unrelated,'SELECT id,decrypted_secret FROM vault.decrypted_secrets');
   await vaultDenied(unrelated,'SELECT id,secret FROM vault.secrets');
   assert.equal((await unrelated.query(`SELECT encode(vault.fixture_invoker_decode('abc'::bytea,''::bytea,0::bigint,''::bytea,''::bytea),'escape') AS dummy`)).rows[0].dummy,'abc');
  });
  await t.test('service-wide view access does not authenticate caller or isolate owners',async()=>{
   const rows=(await runtime.query('SELECT id,decrypted_secret FROM vault.decrypted_secrets ORDER BY id')).rows;
   assert.deepEqual(rows,[{id:a.secret,decrypted_secret:a.dummy},{id:b.secret,decrypted_secret:b.dummy}].sort((x,y)=>x.id.localeCompare(y.id)));
   // A writable session setting cannot turn a trusted service into tenant RLS.
   const client=await runtime.connect(),problems:unknown[]=[];let discard=false;
   try{
    await client.query('BEGIN');await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[a.owner]);
    assert.equal((await client.query('SELECT id FROM vault.decrypted_secrets WHERE id=$1',[b.secret])).rows.length,1);
   }catch(error){problems.push(error);}finally{
    try{await client.query('ROLLBACK');}catch(error){discard=true;problems.push(error);}
    try{client.release(discard);}catch(error){problems.push(error);}
   }
   if(problems.length)throw new AggregateError(problems,'platform_vault_setting_probe_failed');
   assert.equal((await runtime.query("SELECT nullif(current_setting('request.jwt.claim.sub',true),'') AS subject")).rows[0].subject,null);
  });
  await t.test('read-only runtime cannot rewrite dummy secret, view, credentials or account owner',async()=>{
   await vaultDenied(runtime,'UPDATE vault.secrets SET secret=$2 WHERE id=$1',[a.secret,'changed-dummy']);
   await vaultDenied(runtime,'UPDATE vault.decrypted_secrets SET id=$2 WHERE id=$1',[a.secret,b.secret]);
   await vaultDenied(runtime,'ALTER VIEW vault.decrypted_secrets OWNER TO restricted_platform_vault');
   await vaultDenied(runtime,'UPDATE private.kalshi_connection_credentials SET vault_secret_id=$2 WHERE id=$1',[a.credential,b.secret]);
   await vaultDenied(runtime,'UPDATE public.v13_production_account SET owner_user_id=$2 WHERE id=$1',[a.account,b.owner]);
   for(const table of signerTables)await vaultDenied(runtime,`DELETE FROM ${table}`);
   assert.equal((await probeVaultSigner(runtime,a.owner,a.account)).rows[0][0].decrypted_secret,a.dummy);
  });
 }catch(error){failures.push(error);}finally{
  globalThis.fetch=previousFetch;
  const cleanup=await Promise.allSettled([runtime.end(),unrelated.end(),setup.end()]);
  failures.push(...cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]));
 }
 if(failures.length===1)throw failures[0];
 if(failures.length>1)throw new AggregateError(failures,'platform_vault_test_and_cleanup_failed');
});
