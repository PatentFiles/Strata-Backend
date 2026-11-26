import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { readFileSync } from 'node:fs';
import { pool } from '@workspace/db';
import { fixture } from './entryBudgetChoice.fixture';
import { entryBudgetTermsDigest } from './entryBudgetChoice';
import { createPersistedBudgetChoiceReader, readCurrentPersistedBudgetChoice } from './persistedEntryBudgetChoice';
import { createStrataAccess } from './strata/supabaseAuth';
import { createWalletEntryBudgetPreviewRouter, WALLET_ENTRY_BUDGET_PATH } from '../routes/walletEntryBudgetPreviewRouter';

const model=fixture(10000,12500,50000,62500);
const scope=model.currentScope;
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
if(!url||url!==process.env.DATABASE_URL)throw Error('missing disposable database');
const parsed=new URL(url);
if(parsed.protocol!=='postgresql:'||parsed.hostname!=='127.0.0.1'||parsed.username!=='v13_test'||
  parsed.search||parsed.hash||parsed.password||!/^\/v13_disposable_[0-9]+$/.test(parsed.pathname))throw Error('refuse non-disposable DB');

const read=(gross=10000,s=scope)=>readCurrentPersistedBudgetChoice((sql,args)=>pool.query(sql,args),s,gross);
const accountLock='SELECT id FROM public.v13_production_account WHERE id=$1 FOR UPDATE';
const revokeSql='UPDATE private.strata_entry_budget_choices SET revoked_at=clock_timestamp() WHERE account_id=$1 AND gross_cents=10000 AND choice_revision=$2';
const insertSql='INSERT INTO private.strata_entry_budget_choices VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()-interval \'1 minute\',clock_timestamp()+interval \'1 hour\',NULL)';
function insertArgs(rev:number,s=scope){
  const choice={...model.choice,scope:s,choiceId:'gross-10000',choiceRevision:rev};
  return [s.ownerId,s.accountId,s.credentialFingerprint,s.releaseSha,s.policyHash,s.policyRevision,s.stakeRevision,
    s.feeApprovalId,s.feeApprovalDigest,choice.choiceId,rev,choice.grossCents,choice.allInCents,entryBudgetTermsDigest(choice)];
}
async function waitLock(client:{query:(sql:string)=>Promise<{rows:Record<string,unknown>[]}>}){
  const pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0]?.pid;
  assert.equal(typeof pid,'number');
  return async ()=>{
    for(let i=0;i<150;i++){
      if((await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return;
      await new Promise(r=>setTimeout(r,10));
    }
    assert.fail('expected PostgreSQL lock wait');
  };
}

test('review staging schema and persisted owner route on real PostgreSQL, with approval races and read-only grants',async()=>{
 try {
  const server=await pool.query('SELECT current_database() AS db,current_user AS usr,host(inet_server_addr()) AS host,inet_server_port() AS port');
  assert.deepEqual(server.rows[0],{db:parsed.pathname.slice(1),usr:'v13_test',host:'127.0.0.1',port:Number(parsed.port)});
  await pool.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE selector_reader; CREATE SCHEMA private');
  await pool.query('CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id text,key_fingerprint text,policy_id text); CREATE TABLE public.v13_live_money_policy(id text PRIMARY KEY,policy_hash text,version integer,state text,max_entry_stake_cents integer,max_entry_all_in_cents integer,capital_limit_cents integer); CREATE TABLE public.strata_configured_stake(execution_account_id text PRIMARY KEY, revision integer,configured_stake_cents integer)');
  await pool.query('INSERT INTO public.v13_live_money_policy VALUES($1,$2,$3,$4,$5,$6,$7)',
    ['policy',scope.policyHash,scope.policyRevision,'APPROVED',50000,62500,1000000]);
  await pool.query("INSERT INTO public.v13_production_account VALUES($1,$2,$3,'policy')",
    [scope.accountId,scope.ownerId,scope.credentialFingerprint]);
  await pool.query('INSERT INTO public.strata_configured_stake VALUES($1,$2,$3)',[scope.accountId,scope.stakeRevision,50000]);
  await pool.query(readFileSync('../../docs/qualification/entry-budget-selector.sql','utf8'));
  assert.equal(await read(),null);
  await assert.rejects(pool.query(insertSql,insertArgs(1,{...scope,ownerId:'foreign'})),/owner or account mismatch/);
  await pool.query(insertSql,insertArgs(1));
  assert.equal((await read())?.choice.choiceRevision,1);
  for(const drift of [
    {...scope,feeApprovalDigest:'e'.repeat(64)},{...scope,ownerId:'foreign'},{...scope,releaseSha:'e'.repeat(40)},
    {...scope,stakeRevision:scope.stakeRevision+1},{...scope,credentialFingerprint:'e'.repeat(64)},
  ])assert.equal(await read(10000,drift),null);
  // Real data lookup joins current persisted stake, not only caller-provided fixture.
  await pool.query('UPDATE public.strata_configured_stake SET revision=revision+1');
  assert.equal(await read(),null);
  await pool.query('UPDATE public.strata_configured_stake SET revision=revision-1');
  assert.equal((await read())?.choice.choiceRevision,1);
  await assert.rejects(pool.query('UPDATE private.strata_entry_budget_choices SET all_in_cents=13000'),/terms are immutable/);
  await assert.rejects(pool.query('DELETE FROM private.strata_entry_budget_choices'),/history is immutable/);
  await assert.rejects(pool.query('TRUNCATE private.strata_entry_budget_choices'),/history is immutable/);

  const a=await pool.connect(), b=await pool.connect();
  try{
    const waitB=await waitLock(b),waitA=await waitLock(a);
    await a.query('BEGIN');
    await a.query(accountLock,[scope.accountId]);
    const revoke=b.query(revokeSql,[scope.accountId,1]);
    await waitB();
    assert.equal((await readCurrentPersistedBudgetChoice((s,p)=>a.query(s,p),scope,10000))?.choice.choiceRevision,1);
    await a.query('COMMIT');
    await revoke;
    assert.equal(await read(),null);
    await assert.rejects(pool.query('UPDATE private.strata_entry_budget_choices SET revoked_at=null'),/terms are immutable/);
    await pool.query(insertSql,insertArgs(2));
    await b.query('BEGIN');
    await b.query(revokeSql,[scope.accountId,2]);
    await a.query('BEGIN');
    const lock=a.query(accountLock,[scope.accountId]);
    await waitA();await b.query('COMMIT');await lock;
    assert.equal(await readCurrentPersistedBudgetChoice((s,p)=>a.query(s,p),scope,10000),null);
    await a.query('COMMIT');

    await pool.query(insertSql,insertArgs(3));
    await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    assert.equal(await readCurrentPersistedBudgetChoice((s,p)=>a.query(s,p),scope,10000),null);
    await a.query('ROLLBACK');
    await a.query('BEGIN');await a.query(insertSql,insertArgs(5));
    const lower=b.query(insertSql,insertArgs(4)).then(()=>null,(e:unknown)=>e);
    await waitB();await a.query('COMMIT');
    assert.match((await lower as Error).message,/revision must increase/);
    assert.equal((await read())?.choice.choiceRevision,5);
    await pool.query(revokeSql,[scope.accountId,5]);
    assert.equal(await read(),null,'Revoking a later revision must never revive older unrevoked terms');
    await pool.query(insertSql,insertArgs(6));

    await a.query('SET ROLE authenticated');
    await assert.rejects(a.query('SELECT * FROM private.strata_entry_budget_choices'),/permission denied/);
    await a.query('RESET ROLE');
    await a.query('GRANT USAGE ON SCHEMA private TO selector_reader; GRANT SELECT ON private.strata_entry_budget_choices TO selector_reader; SET ROLE selector_reader');
    assert.equal((await a.query('SELECT * FROM private.strata_entry_budget_choices')).rowCount,0);
    await assert.rejects(a.query(insertSql,insertArgs(7)),/permission denied/);
    await assert.rejects(a.query(revokeSql,[scope.accountId,6]),/permission denied/);
    await a.query('RESET ROLE');
  } finally {a.release(true);b.release(true);}

  // Grant only inside this disposable fixture, never in candidate or startup.
  await pool.query('CREATE POLICY staging_selector_server_read ON private.strata_entry_budget_choices FOR SELECT TO selector_reader USING (true); GRANT SELECT ON public.v13_production_account,public.v13_live_money_policy,public.strata_configured_stake TO selector_reader');
  const reader=await pool.connect();
  try {
  await reader.query('SET ROLE selector_reader');
  assert.equal((await readCurrentPersistedBudgetChoice((sql,args)=>reader.query(sql,args),scope,10000))?.choice.choiceRevision,6);
  await assert.rejects(reader.query(insertSql,insertArgs(7)),/permission denied/);
  const access=createStrataAccess({verifyToken:async t=>{
    if(t!=='owner-aal2'&&t!=='other-aal2')throw Error('fixture auth');
    return {subject:t==='owner-aal2'?scope.ownerId:'foreign',issuer:'fixture',audience:'authenticated',aal:'aal2'};
  },roleOf:async()=> 'STANDARD'});
  const app=express();
  app.use(createWalletEntryBudgetPreviewRouter({deployment:'isolated-staging',requireOwnerAal2:access.requireUser,
    readApprovedChoice:createPersistedBudgetChoiceReader({query:(sql,args)=>reader.query(sql,args),
      loadTrustedObservation:async(subject)=>{
        const o=fixture(10000,12500,50000,62500), now=Date.now();
        o.currentScope={...o.currentScope,ownerId:subject};
        o.trustedFeeApproval={...o.trustedFeeApproval,scope:o.currentScope,verifiedAtMs:now-1000,expiresAtMs:now+10000};
        o.preflight.nowMs=now;o.preflight.feeEvidence.verifiedAtMs=now;
        return {currentScope:o.currentScope,currentConfiguredGrossCents:o.currentConfiguredGrossCents,
          trustedFeeApproval:o.trustedFeeApproval,preflight:o.preflight};
      }}),
  }));
  const http=app.listen(0,'127.0.0.1');await new Promise<void>(r=>http.once('listening',r));
  try{
    const address=http.address();assert.ok(address&&typeof address==='object');
    const get=(t:string)=>fetch('http://127.0.0.1:'+address.port+WALLET_ENTRY_BUDGET_PATH+'?grossCents=10000',
      {headers:{authorization:'Bearer '+t,'X-Strata-Read-Intent':'preview-entry-budget'}});
    const response=await get('owner-aal2');assert.equal(response.status,200);
    const body: unknown = await response.json();
    assert.ok(body && typeof body === "object" && "plan" in body && "funding" in body);
    assert.deepEqual(body.plan,{requestedContracts:62,modeledGrossCents:3162,modeledAllInCents:12394});
    assert.ok(body.funding && typeof body.funding === "object" && "fullReservationCents" in body.funding);
    assert.equal(body.funding.fullReservationCents,12500);
    assert.equal((await get('other-aal2')).status,409);
    await pool.query(revokeSql,[scope.accountId,6]);
    assert.equal((await get('owner-aal2')).status,409);
  }finally{await new Promise<void>((r,j)=>http.close(e=>e?j(e):r()));}
  }finally{reader.release(true);}
 }finally{await pool.end();}
});
