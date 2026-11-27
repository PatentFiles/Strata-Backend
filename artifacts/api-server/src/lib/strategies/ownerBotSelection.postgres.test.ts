import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pool} from '@workspace/db';
import {CHAMPION_BOT,WARREN_BOT,WARREN_BOT_HASH,selectOwnedBot,readRuntimeBotChoice,
 BOT_SELECT_CONFIRM,readOwnerBotCatalog} from './ownerBotCatalog';
import {V13_CHAMPION_PARAMETER_HASH} from '@workspace/v13-strategy';
const u=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(u&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(u),'disposable database required');
after(()=>pool.end());
const owner=randomUUID(),foreign=randomUUID(),policyHash='a'.repeat(64),sha='b'.repeat(40),account='native-owner-bot';
const body=(botId:string,expectedRevision:number,other:Record<string,unknown>={})=>({
 botId,expectedRevision,expectedPolicyHash:policyHash,expectedSha:sha,
 requestId:randomUUID(),confirmation:BOT_SELECT_CONFIRM,...other
});
test('native PostgreSQL: owner-only bot selection retains original policy and rejects live or wrong-account switches',async()=>{
 const orig={NODE_ENV:process.env.NODE_ENV,RAILWAY_GIT_COMMIT_SHA:process.env.RAILWAY_GIT_COMMIT_SHA,
  STRATA_WARREN_BUFFETT_LIVE_ENABLED:process.env.STRATA_WARREN_BUFFETT_LIVE_ENABLED,
  STRATA_WARREN_BUFFETT_LIVE_SHA:process.env.STRATA_WARREN_BUFFETT_LIVE_SHA};
 try{
  await pool.query('CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS private');
  await pool.query("DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;");
  await pool.query('CREATE TABLE IF NOT EXISTS auth.users(id uuid primary key)');
  await pool.query('ALTER TABLE public.v13_production_account ADD COLUMN IF NOT EXISTS owner_user_id uuid; ALTER TABLE public.v13_production_account ADD COLUMN IF NOT EXISTS owner_control_epoch bigint NOT NULL DEFAULT 0');
  await pool.query('CREATE TABLE IF NOT EXISTS private.kalshi_account_worker_lease(execution_account_id text primary key,owner_user_id uuid,state text,arm_requested boolean,account_kill boolean,fencing_token bigint default 1,released_at timestamptz,heartbeat_at timestamptz)');
  await pool.query('CREATE TABLE IF NOT EXISTS private.strata_emergency_exit_reservations(execution_account_id text,state text)');
  const sql=readFileSync('../../lib/db/owner-self-release/009_owner_bot_selection.sql','utf8');
  await pool.query(sql);
  await pool.query('INSERT INTO auth.users(id) VALUES($1),($2)',[owner,foreign]);
  await pool.query(`INSERT INTO public.v13_live_money_policy
   (id,version,state,champion_selection_review_id,champion_selection_evidence_hash,champion_selected_by,
    champion_selected_at,capital_limit_cents,max_entry_stake_cents,max_entry_all_in_cents,max_daily_loss_cents,
    max_total_loss_cents,max_quote_age_ms,max_fee_evidence_age_ms,fee_policy_version,fee_source_url,fee_formula_version,
    policy_hash,created_by,approved_by,approved_at)
   VALUES('native-bot-policy',1,'APPROVED','native-test',$1,$2,clock_timestamp()-interval '1 minute',
    2500,500,625,1000,1500,5000,15000,'native-test','native-fee://source','test-v1',$3,$2,$2,clock_timestamp())`,
   ['e'.repeat(64),owner,policyHash]);
  await pool.query(`INSERT INTO public.v13_production_account
   (id,policy_id,subaccount,exchange_index,key_fingerprint,commissioning_digest,minimum_exit_micros,
    fee_artifact_digest,cash_precision_verified,commissioned,kill_switch,execution_enabled,cash_micros,
    initial_cash_micros,reconciled_at,owner_user_id)
   VALUES($1,'native-bot-policy',1,2,$2,$3,10000,$3,true,true,true,false,25000000,25000000,clock_timestamp(),$4::uuid)`,
   [account,'d'.repeat(64),'f'.repeat(64),owner]);
  await pool.query('UPDATE public.v13_live_money_policy SET execution_account_id=$1 WHERE id=$2',[account,'native-bot-policy']);
  process.env.NODE_ENV='production';process.env.RAILWAY_GIT_COMMIT_SHA=sha;
  process.env.STRATA_WARREN_BUFFETT_LIVE_ENABLED='true';process.env.STRATA_WARREN_BUFFETT_LIVE_SHA=sha;
  const first=await readRuntimeBotChoice(pool,owner,account,policyHash,sha);
  assert.equal(first,CHAMPION_BOT);
  const a=await readOwnerBotCatalog(owner,pool);
  assert.equal(a.ok,true);if(!a.ok)return;
  assert.equal(a.currentBotId,CHAMPION_BOT);assert.equal(a.selectionEnabled,true);
  const req=body(WARREN_BOT,0);
  const saved=await selectOwnedBot(owner,req,pool);

  assert.equal(saved.ok,true,JSON.stringify(saved));
  if(!saved.ok)return;
  assert.equal(saved.selectionRevision,1);
  assert.equal(await readRuntimeBotChoice(pool,owner,account,policyHash,sha),WARREN_BOT);
  const accountRow=(await pool.query('SELECT kill_switch,execution_enabled,owner_control_epoch::text AS epoch,cash_micros::text,reserved_micros::text,policy_id FROM public.v13_production_account WHERE id=$1',[account])).rows[0]!;
  assert.equal(accountRow.kill_switch,true);assert.equal(accountRow.execution_enabled,false);
  assert.equal(accountRow.epoch,'1');assert.equal(accountRow.cash_micros,'25000000');
  assert.equal(accountRow.reserved_micros,'0');assert.equal(accountRow.policy_id,'native-bot-policy');
  const history=(await pool.query('SELECT to_bot_id,bot_fingerprint,policy_hash FROM private.strata_owner_bot_selection_history WHERE execution_account_id=$1',[account])).rows;
  assert.equal(history.length,1);assert.equal(history[0]!.to_bot_id,WARREN_BOT);
  assert.equal(history[0]!.bot_fingerprint,WARREN_BOT_HASH);assert.equal(history[0]!.policy_hash,policyHash);
  const replay=await selectOwnedBot(owner,req,pool);assert.equal(replay.ok,true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM private.strata_owner_bot_selection_history')).rows[0].n,1);
  const other=await selectOwnedBot(foreign,body(CHAMPION_BOT,1),pool);
  assert.equal(other.ok,false);
  const wrongVersion=await selectOwnedBot(owner,body(CHAMPION_BOT,0),pool);
  assert.equal(wrongVersion.ok,false);
  await pool.query('UPDATE public.v13_production_account SET reserved_micros=10000 WHERE id=$1',[account]);
  const withheld=await selectOwnedBot(owner,body(CHAMPION_BOT,1),pool);
  assert.equal(withheld.ok,false);
  await pool.query('UPDATE public.v13_production_account SET reserved_micros=0 WHERE id=$1',[account]);
  await pool.query(`INSERT INTO private.kalshi_account_worker_lease(execution_account_id,owner_user_id,state,arm_requested,account_kill)
    VALUES($1,$2::uuid,'owned',true,false)`,[account,owner]);
  const active=await selectOwnedBot(owner,body(CHAMPION_BOT,1),pool);
  assert.equal(active.ok,false,'running lease cannot switch bots');
  assert.equal((await pool.query('SELECT count(*)::int n FROM private.strata_owner_bot_selection_history')).rows[0].n,1);
  // On the next qualified release, the exact same selected bot requires fresh owner consent.
  await pool.query("UPDATE private.kalshi_account_worker_lease SET state='released',arm_requested=false,account_kill=false WHERE execution_account_id=$1",[account]);
  // Owner pressed normal STOP, not KILL: eligibility remains on, no owned lease.
  await pool.query("UPDATE public.v13_production_account SET kill_switch=false,execution_enabled=true,reconciled_at=clock_timestamp() WHERE id=$1",[account]);
  const nextSha='c'.repeat(40);
  process.env.RAILWAY_GIT_COMMIT_SHA=nextSha;process.env.STRATA_WARREN_BUFFETT_LIVE_SHA=nextSha;
  const stale=await readOwnerBotCatalog(owner,pool);
  assert.equal(stale.ok,true);if(!stale.ok)return;
  assert.equal(stale.currentBotId,WARREN_BOT);
  assert.equal(stale.currentPolicyVerified,false);
  assert.equal(stale.requiresReauthorization,true);
  await assert.rejects(readRuntimeBotChoice(pool,owner,account,policyHash,nextSha),/bot_runtime_selection_stale/);
  const renewed=await selectOwnedBot(owner,body(WARREN_BOT,1,{expectedSha:nextSha}),pool);
  assert.equal(renewed.ok,true,JSON.stringify(renewed));
  if(!renewed.ok)return;
  assert.equal(renewed.selectionRevision,2);
  const stopped=(await pool.query('SELECT kill_switch,execution_enabled FROM public.v13_production_account WHERE id=$1',[account])).rows[0];
  assert.deepEqual(stopped,{kill_switch:true,execution_enabled:false},'switch closes START authority; owner must re-ARM');
  assert.equal(await readRuntimeBotChoice(pool,owner,account,policyHash,nextSha),WARREN_BOT);
  assert.equal((await pool.query('SELECT count(*)::int n FROM private.strata_owner_bot_selection_history')).rows[0].n,2);
  const acl=(await pool.query(`SELECT c.relrowsecurity AS rls,
   has_table_privilege('anon','private.strata_owner_bot_selection','SELECT') AS anon_select,
   has_table_privilege('authenticated','private.strata_owner_bot_selection','UPDATE') AS authed_update
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='private' AND c.relname='strata_owner_bot_selection'`)).rows[0]!;
  assert.deepEqual(acl,{rls:true,anon_select:false,authed_update:false});
 }finally{
  for(const [k,v] of Object.entries(orig)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 }
});
