import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { openCredentialFixture, type CredentialFixtureDb } from "./credentialFixtureDb.testHelper";
import { dedicatedSignerFingerprint } from "./commissioning";
import { approvedFromRow } from "./ownerStakePolicyAmendment";
import { computeV13LiveMoneyPolicyHash } from "../v13LiveMoneyRisk";
import { CREDIT_CONFIRM, CREDIT_CANCEL } from "./capitalCreditTransfers";
import { applyRegisteredOpeningCapital, registeredOpeningCapitalPreview,
  registeredOpeningCapitalOutcome, cancelRegisteredOpeningCapital } from "./registeredOpeningCapitalRecovery";
import { validRegisteredOpeningScope, type RegisteredOpeningScope } from "./registeredOpeningCapitalProof";
import type { Db } from "./capitalCreditProof";
import type { OwnedKalshiRead } from "./personalExchangeRead";
import { sanitizePublic } from "../v13-production/sanitize";

const OWNER="11111111-1111-4111-8111-111111111111", OTHER="22222222-2222-4222-8222-222222222222";
const FINANCIAL="33333333-3333-4333-8333-333333333333", PROVIDER="44444444-4444-4444-8444-444444444444";
const ACCOUNT="registered-opening-synthetic", SHA="a".repeat(40), RECEIPT="synthetic-initial-funding";
const material=(keyId:string)=>({keyId,privateKey:generateKeyPairSync("rsa",{modulusLength:2048})
 .privateKey.export({type:"pkcs8",format:"pem"}).toString()});
const restricted=material("restricted-synthetic"),setup=material("setup-synthetic");
const fp=dedicatedSignerFingerprint(restricted.keyId,restricted.privateKey)!;
const setupFp=dedicatedSignerFingerprint(setup.keyId,setup.privateKey)!;

type Deps=NonNullable<Parameters<typeof registeredOpeningCapitalPreview>[1]>;
async function fixture(t:TestContext,amount=2500) {
 const db=await openCredentialFixture();
 if(!db?.nativePool){
  if(db)await db.close();
  assert.notEqual(process.env.STRATA_CREDENTIAL_NATIVE_TESTS,"1");
  t.skip("native disposable PostgreSQL fixture required");return null;
 }
 t.after(()=>db.close());
 const native=db.nativePool as unknown as Db;
 // Minimal production-shaped native schema. The immutable journal guards and
 // unique indexes below mirror the deployed capital-credit journal contract.
 // These fixtures are not substitutes for migration/production qualification.
 await db.exec(`
 CREATE SCHEMA private; CREATE SCHEMA vault;
 CREATE TABLE public.v13_production_account(id text PRIMARY KEY,owner_user_id uuid,kalshi_connection_id uuid,
 policy_id text,subaccount bigint,exchange_index bigint,key_fingerprint text,cash_micros bigint,
 initial_cash_micros bigint,reserved_micros bigint,revision bigint,commissioned boolean,cash_precision_verified boolean,
 execution_enabled boolean,kill_switch boolean,blocked_reason text,reconciled_at timestamptz);
 CREATE TABLE public.v13_live_money_policy(id text PRIMARY KEY,execution_account_id text,created_by text,state text,
 policy_hash text,version integer,capital_limit_cents integer,max_entry_stake_cents integer,max_entry_all_in_cents integer,
 max_open_positions integer,max_daily_loss_cents integer,max_total_loss_cents integer,max_quote_age_ms integer,max_fee_evidence_age_ms integer);
 CREATE TABLE public.strata_configured_stake(execution_account_id text,configured_stake_cents integer);
 CREATE TABLE public.financial_accounts(id uuid PRIMARY KEY,user_id uuid,provider text);
 CREATE TABLE private.provider_connections(id uuid PRIMARY KEY,financial_account_id uuid);
 CREATE TABLE private.kalshi_connection_credentials(id uuid PRIMARY KEY,owner_user_id uuid,financial_account_id uuid,provider_connection_id uuid,
 role text,key_fingerprint text,vault_secret_id uuid,revoked_at timestamptz,verified_at timestamptz,verification_reason text);
 CREATE TABLE vault.decrypted_secrets(id uuid PRIMARY KEY,decrypted_secret text);
 CREATE TABLE private.kalshi_account_worker_lease(execution_account_id text,owner_user_id uuid,state text,account_kill boolean,arm_requested boolean,fencing_token bigint);
 CREATE TABLE public.v13_production_intent(account_id text,created_at timestamptz,client_order_id text,request jsonb,
 exchange_order_id text,terminal boolean,filled_hundredths bigint,reserved_micros bigint);
 CREATE TABLE public.v13_production_event(account_id text,event_id text,digest text,cash_delta_micros bigint,pnl_micros bigint);
 CREATE TABLE public.v13_production_position(account_id text,market text,side text,quantity_hundredths bigint,basis_micros bigint,realized_pnl_micros bigint);
 CREATE TABLE private.strata_emergency_exit_reservations(execution_account_id text);
 CREATE TABLE private.kalshi_owner_topups(id uuid,execution_account_id text,owner_user_id uuid);
 CREATE TABLE private.kalshi_owner_topup_legs(topup_id uuid,exchange_transfer_id text);
 CREATE TABLE private.kalshi_owner_historical_funding(execution_account_id text,owner_user_id uuid,exchange_transfer_id text,
 transfer_created_at timestamptz,verified_at timestamptz,primary_after_cents bigint,bot_after_cents bigint);
 CREATE TABLE private.kalshi_owner_pilot_transfers(id uuid PRIMARY KEY,execution_account_id text,owner_user_id uuid,financial_account_id uuid,
 provider_connection_id uuid,state text,amount_cents integer,from_subaccount smallint,to_subaccount smallint,exchange_index smallint,
 bot_before_cents bigint,bot_after_cents bigint,verified_exchange_transfer_id text,attempted_at timestamptz,verified_at timestamptz,completed_at timestamptz);
 CREATE TABLE private.strata_capital_credit_repair(repair_id uuid PRIMARY KEY,owner_user_id uuid,execution_account_id text,
 release_commit_sha text,receipt_id text,scope_digest text,scope jsonb,confirmation text,state text DEFAULT 'PENDING',reason text,
 created_at timestamptz DEFAULT clock_timestamp(),resolved_at timestamptz,evidence_deadline timestamptz,
 CHECK(confirmation='I_RECORD_THIS_VERIFIED_PAST_FUNDING_CREDIT_AS_CAPITAL_NOT_PROFIT_V1'),
 CHECK(scope->>'ownerId'=owner_user_id::text AND scope->>'accountId'=execution_account_id
 AND scope->>'sha'=release_commit_sha AND scope->>'receiptId'=receipt_id AND scope->>'scopeDigest'=scope_digest));
 CREATE UNIQUE INDEX capital_credit_one_receipt ON private.strata_capital_credit_repair(owner_user_id,receipt_id) WHERE state IN ('PENDING','RECORDED');
 CREATE UNIQUE INDEX capital_credit_one_pending_account ON private.strata_capital_credit_repair(execution_account_id) WHERE state='PENDING';
 CREATE FUNCTION private.capital_credit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog','pg_temp' AS $fn$
 BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'capital credit history retained';END IF;
 IF TG_OP='INSERT' AND NOT(NEW.state='PENDING' OR (NEW.state='REJECTED' AND NEW.reason='capital_owner_canceled_exact_repair'))
 THEN RAISE EXCEPTION 'capital credit must begin pending or canceled';END IF;
 IF TG_OP='UPDATE' AND (OLD.state<>'PENDING' OR NEW.state NOT IN('RECORDED','REJECTED') OR
 (to_jsonb(OLD)-'state'-'reason'-'resolved_at'-'evidence_deadline') IS DISTINCT FROM
 (to_jsonb(NEW)-'state'-'reason'-'resolved_at'-'evidence_deadline')) THEN RAISE EXCEPTION 'capital credit immutable';END IF;
 RETURN NEW;END $fn$;
 CREATE TRIGGER capital_credit_immutable BEFORE INSERT OR UPDATE OR DELETE ON private.strata_capital_credit_repair
 FOR EACH ROW EXECUTE FUNCTION private.capital_credit_immutable();
 CREATE FUNCTION private.capital_credit_commit_guard() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog','pg_temp' AS $fn$
 DECLARE a public.v13_production_account%ROWTYPE;ec bigint;ep bigint;pb bigint;pp bigint;ir bigint;
 BEGIN
 IF NEW.state<>'RECORDED' THEN RETURN NEW;END IF;
 IF NEW.evidence_deadline<clock_timestamp() OR NEW.evidence_deadline>clock_timestamp()+interval '15 seconds' THEN RAISE EXCEPTION 'capital evidence expired';END IF;
 SELECT * INTO a FROM public.v13_production_account WHERE id=NEW.execution_account_id AND owner_user_id=NEW.owner_user_id;
 IF NOT FOUND OR a.initial_cash_micros::text<>NEW.scope->>'newInitialCashMicros' OR a.cash_micros::text<>NEW.scope->>'cashMicros'
 OR a.revision<>(NEW.scope->>'accountRevision')::bigint+1 OR a.execution_enabled OR NOT a.kill_switch
 OR a.blocked_reason IS NOT NULL OR a.reserved_micros<>0 THEN RAISE EXCEPTION 'capital account changed';END IF;
 IF (NEW.scope->>'amountCents')::bigint<=0 OR (NEW.scope->>'amountCents')::bigint>2500000 OR
 (NEW.scope->>'newInitialCashMicros')::bigint<>(NEW.scope->>'oldInitialCashMicros')::bigint+(NEW.scope->>'amountCents')::bigint*10000
 THEN RAISE EXCEPTION 'capital amount mismatch';END IF;
 SELECT coalesce(sum(cash_delta_micros),0),coalesce(sum(pnl_micros),0) INTO ec,ep FROM public.v13_production_event WHERE account_id=a.id;
 SELECT coalesce(sum(basis_micros),0),coalesce(sum(realized_pnl_micros),0) INTO pb,pp FROM public.v13_production_position WHERE account_id=a.id;
 SELECT coalesce(sum(reserved_micros),0) INTO ir FROM public.v13_production_intent WHERE account_id=a.id;
 IF a.cash_micros<>a.initial_cash_micros+ec OR a.cash_micros+pb<>a.initial_cash_micros+ep OR pp<>ep OR ir<>a.reserved_micros
 THEN RAISE EXCEPTION 'capital conservation failed';END IF;
 RETURN NEW;END $fn$;
 CREATE CONSTRAINT TRIGGER capital_credit_commit_guard AFTER UPDATE ON private.strata_capital_credit_repair DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION private.capital_credit_commit_guard();
 `);
 const cash=String(BigInt(amount)*10000n);
 const created=Math.floor((Date.now()-60000)/1000);
 const attempted=new Date((created-1)*1000).toISOString(),verified=new Date((created+1)*1000).toISOString();
 await db.query("INSERT INTO v13_production_account VALUES($1,$2,$3,'policy',1,2,$4,$5,0,0,2,true,true,false,true,NULL,$6)",[ACCOUNT,OWNER,FINANCIAL,fp,cash,verified]);
 await db.query("INSERT INTO v13_live_money_policy VALUES('policy',$1,$2,'APPROVED',NULL,3,2500,500,600,1,250,1000,10000,15000)",[ACCOUNT,OWNER]);
 const policy=approvedFromRow((await db.query("SELECT * FROM v13_live_money_policy")).rows[0]!)!;
 await db.query("UPDATE v13_live_money_policy SET policy_hash=$1",[computeV13LiveMoneyPolicyHash(policy)]);
 await db.query("INSERT INTO strata_configured_stake VALUES($1,500)",[ACCOUNT]);
 await db.query("INSERT INTO financial_accounts VALUES($1,$2,'kalshi')",[FINANCIAL,OWNER]);
 await db.query("INSERT INTO private.provider_connections VALUES($1,$2)",[PROVIDER,FINANCIAL]);
 for(const [role,keys,fingerprint] of [["restricted_execution",restricted,fp],["account_setup_execution",setup,setupFp]] as const){
  const vault=randomUUID();
  await db.query("INSERT INTO vault.decrypted_secrets VALUES($1,$2)",[vault,JSON.stringify({api_key_id:keys.keyId,private_key:keys.privateKey})]);
  await db.query("INSERT INTO private.kalshi_connection_credentials VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8,'credential_verified')",
   [randomUUID(),OWNER,FINANCIAL,PROVIDER,role,fingerprint,vault,verified]);
 }
 await db.query("INSERT INTO private.kalshi_owner_pilot_transfers VALUES($1,$2,$3,$4,$5,'completed',$6::integer,0,1,2,0,$6::integer::bigint,$7,$8,$9,$9)",
  [randomUUID(),ACCOUNT,OWNER,FINANCIAL,PROVIDER,amount,RECEIPT,attempted,verified]);
 const transfers=[{transfer_id:RECEIPT,from_subaccount:0,to_subaccount:1,exchange_index:2,amount_cents:amount,created_ts:created}];
 const feed:Omit<OwnedKalshiRead,"observedAtMs">={ok:true,cashMicros:cash,historicalCoverageComplete:true,orders:[],fills:[],positions:[],settlements:[]};
 const deps:Deps={db:native,sha:()=>SHA,scope:()=>({ownerId:OWNER,accountId:ACCOUNT}),
  read:async(_material,now)=>({...feed,observedAtMs:now}),
  get:async(_material,path)=>{assert.equal(path,"/trade-api/v2/portfolio/subaccounts/transfers");return {transfers,cursor:""};}};
 return {db,native,deps,feed,transfers,cash};
}
async function preview(d:Deps):Promise<RegisteredOpeningScope>{
 const r=await registeredOpeningCapitalPreview(OWNER,d);
 if(!r.ok)throw Error(r.reason);
 assert.equal(validRegisteredOpeningScope(r.scope),true);
 assert.deepEqual(sanitizePublic(r),r);
 return r.scope;
}
const body=(scope:RegisteredOpeningScope,repairId=randomUUID())=>({scope,repairId,confirmation:CREDIT_CONFIRM});
async function state(db:CredentialFixtureDb){
 return (await db.query("SELECT cash_micros::text,initial_cash_micros::text,revision::text,kill_switch,execution_enabled,key_fingerprint FROM v13_production_account")).rows[0]!;
}
async function expectRecorded(f:NonNullable<Awaited<ReturnType<typeof fixture>>>){
 const a=await state(f.db);
 assert.equal(a.cash_micros,f.cash);assert.equal(a.initial_cash_micros,f.cash);assert.equal(a.revision,"3");
 assert.equal(a.kill_switch,true);assert.equal(a.execution_enabled,false);assert.equal(a.key_fingerprint,fp);
 assert.equal(String((await f.db.query("SELECT configured_stake_cents FROM strata_configured_stake")).rows[0]!.configured_stake_cents),"500");
 assert.equal(String((await f.db.query("SELECT count(*) AS n FROM private.kalshi_owner_pilot_transfers")).rows[0]!.n),"1");
 assert.equal(String((await f.db.query("SELECT count(*) AS n FROM private.strata_capital_credit_repair WHERE state='RECORDED'")).rows[0]!.n),"1");
 assert.equal(String((await f.db.query("SELECT count(*) AS n FROM v13_production_event")).rows[0]!.n),"0");
}
test("registered initial funding repair is real, owner-authorized, conserved and idempotent",async t=>{
 const f=await fixture(t);if(!f)return;
 const scope=await preview(f.deps);
 assert.equal(scope.cashMicros,"25000000");assert.equal(scope.oldInitialCashMicros,"0");
 assert.equal((await state(f.db)).initial_cash_micros,"0");
 const request=body(scope);
 assert.equal((await applyRegisteredOpeningCapital(OTHER,request,f.deps)).ok,false);
 assert.equal((await applyRegisteredOpeningCapital(OWNER,{...request,scope:{...scope,amountCents:2501}},f.deps)).ok,false);
 assert.equal((await applyRegisteredOpeningCapital(OWNER,request,f.deps)).ok,true);
 await expectRecorded(f);
 assert.equal((await applyRegisteredOpeningCapital(OWNER,request,f.deps)).ok,true);
 assert.equal((await registeredOpeningCapitalOutcome(OWNER,request.repairId,SHA,f.native)).outcome,"RECORDED");
 assert.equal((await registeredOpeningCapitalOutcome(OTHER,request.repairId,SHA,f.native)).outcome,"UNKNOWN");
 await assert.rejects(f.db.exec("DELETE FROM private.strata_capital_credit_repair"),/capital credit history retained/);
 await expectRecorded(f);
});
test("cross-replica competing attempt IDs cannot double-credit the same receipt",async t=>{
 const f=await fixture(t,2731);if(!f)return;
 const scope=await preview(f.deps);
 const results=await Promise.all([applyRegisteredOpeningCapital(OWNER,body(scope),f.deps),applyRegisteredOpeningCapital(OWNER,body(scope),f.deps)]);
 assert.equal(results.filter(r=>r.ok).length,1);await expectRecorded(f);
});
test("wrong receipt, incomplete signed history, deposits, withdrawals and local exposure are refused",async t=>{
 const f=await fixture(t);if(!f)return;
 const scope=await preview(f.deps);
 f.feed.historicalCoverageComplete=false;assert.equal((await registeredOpeningCapitalPreview(OWNER,f.deps)).ok,false);f.feed.historicalCoverageComplete=true;
 f.transfers[0]!.amount_cents++;assert.equal((await registeredOpeningCapitalPreview(OWNER,f.deps)).ok,false);f.transfers[0]!.amount_cents--;
 f.transfers.push({...f.transfers[0]!,transfer_id:"synthetic-withdrawal",from_subaccount:1,to_subaccount:0});
 assert.equal((await registeredOpeningCapitalPreview(OWNER,f.deps)).ok,false);f.transfers.pop();
 f.transfers.push({...f.transfers[0]!,transfer_id:"synthetic-additional-deposit"});
 assert.equal((await registeredOpeningCapitalPreview(OWNER,f.deps)).ok,false);f.transfers.pop();
 for(const field of ["orders","fills","positions","settlements"] as const){
  f.feed[field].push({synthetic:true});assert.equal((await registeredOpeningCapitalPreview(OWNER,f.deps)).ok,false);f.feed[field].pop();
 }
 await f.db.query("UPDATE private.kalshi_owner_pilot_transfers SET owner_user_id=$1",[OTHER]);
 assert.equal((await registeredOpeningCapitalPreview(OWNER,f.deps)).ok,false);
 await f.db.query("UPDATE private.kalshi_owner_pilot_transfers SET owner_user_id=$1",[OWNER]);
 await f.db.exec("UPDATE v13_production_account SET execution_enabled=true,kill_switch=false");
 assert.equal((await applyRegisteredOpeningCapital(OWNER,body(scope),f.deps)).ok,false);
 await f.db.exec("UPDATE v13_production_account SET execution_enabled=false,kill_switch=true");
 for(const sql of ["INSERT INTO v13_production_intent(account_id,terminal,reserved_micros) VALUES($1,false,0)",
  "INSERT INTO v13_production_event(account_id,cash_delta_micros,pnl_micros) VALUES($1,0,0)",
  "INSERT INTO v13_production_position(account_id,quantity_hundredths,basis_micros,realized_pnl_micros) VALUES($1,100,1000000,0)"]){
  await f.db.query(sql,[ACCOUNT]);assert.equal((await registeredOpeningCapitalPreview(OWNER,f.deps)).ok,false);
 }
 assert.equal((await state(f.db)).initial_cash_micros,"0");
});
function interrupt(db:Db,at:"beforeCommit"|"afterCommit"):Db{
 return {query:db.query.bind(db),connect:async()=>{
  const c=await db.connect();
  return {release:c.release.bind(c),query:async(sql,args)=>{
   if(sql==="COMMIT"&&at==="beforeCommit")throw Error("synthetic connection interruption");
   const r=await c.query(sql,args);
   if(sql==="COMMIT"&&at==="afterCommit")throw Error("synthetic lost acknowledgment");
   return r;
  }};
 }};
}
test("lost COMMIT acknowledgment is resolved by authoritative receipt, not a repeat credit",async t=>{
 const f=await fixture(t);if(!f)return;
 const scope=await preview(f.deps);
 const request=body(scope);
 const r=await applyRegisteredOpeningCapital(OWNER,request,{...f.deps,db:interrupt(f.native,"afterCommit")});
 assert.equal(r.ok,true);await expectRecorded(f);
});
test("interrupted pre-COMMIT attempt can be canceled exactly and recovered",async t=>{
 const f=await fixture(t);if(!f)return;
 const scope=await preview(f.deps),request=body(scope);
 const r=await applyRegisteredOpeningCapital(OWNER,request,{...f.deps,db:interrupt(f.native,"beforeCommit")});
 assert.equal(r.ok,false);
 assert.equal((await state(f.db)).initial_cash_micros,"0");
 const canceled=await cancelRegisteredOpeningCapital(OWNER,{...request,confirmation:CREDIT_CANCEL},f.deps);
 assert.equal(canceled.outcome,"REJECTED");
 assert.equal((await applyRegisteredOpeningCapital(OWNER,request,f.deps)).ok,false);
 const next=await preview(f.deps);
 assert.equal((await applyRegisteredOpeningCapital(OWNER,body(next),f.deps)).ok,true);
 await expectRecorded(f);
});
