import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {randomUUID,generateKeyPairSync,verify,constants} from 'node:crypto';
import {pool,type Pool} from '@workspace/db';
import {installFullRecoverySchema} from './ownerUnknownRecoverySchema.fixture';
import {installCombinedPlatformShape} from './restrictedCombinedRuntime.fixture';
import {dedicatedSignerFingerprint} from './commissioning';
import {ProductionLedger,type Account} from '../v13-production/ledger';
import {sweepAvailability,quoteManualSweep,confirmManualSweep,reconcileManualSweep,CASHIER_SWEEP_CONFIRMATION} from './manualProfitWithdrawals';
import {prepareOwnerTopup,executeOwnerTopup,reconcileOwnerTopup,OWNER_TOPUP_CONFIRM} from './ownerVariableTopup';
import {saveAutoRule,readAutoRule,processAutoRule,AUTO_CONFIRMATION} from './autoProfitWithdrawals';
import {getScopedKalshiJson} from '../kalshiAccountClient';
const url=process.env.V13_DISPOSABLE_DATABASE_URL;
assert.ok(url&&url===process.env.DATABASE_URL&&/^postgresql:\/\/v13_test@127\.0\.0\.1:\d+\/v13_disposable_\d+$/.test(url));
const Native=pool.constructor as new(o:{connectionString:string;max:number})=>Pool;
const setup=new Native({connectionString:url,max:1});
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const account='cash-transfer-native',foreign='cash-transfer-foreign',hash='a'.repeat(64);
const pair=generateKeyPairSync('rsa',{modulusLength:2048});const privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const creds={keyId:'offline-cash-transfer-only',privateKey};const fp=dedicatedSignerFingerprint(creds.keyId,creds.privateKey)!;
let bot=100000000n,cashier=500000000n,primary=200000000n,postCount=0,ambiguous=false,badReceipt=false;
const transfers=new Map<string,Record<string,unknown>>();
const usd=(x:bigint)=>String(x/1000000n)+'.'+String(x%1000000n).padStart(6,'0');
const get:typeof getScopedKalshiJson=async(c,path,query='')=>{
 assert.equal(c.keyId,creds.keyId);const q=new URLSearchParams(query);
 if(path.endsWith('/balance')){const sub=Number(q.get('subaccount')),index=Number(q.get('exchange_index'));assert.ok(sub===0||sub===1);assert.ok(index===0||index===2);return {subaccount:sub,exchange_index:index,balance_dollars:usd(sub===1?bot:index===2?primary:cashier),updated_ts:Math.floor(Date.now()/1000)};}
 if(path.includes('/intra_exchange_instance_transfers/')){const t=transfers.get(path.split('/').at(-1)!);assert.ok(t);return {transfer:{...t,...(badReceipt?{amount:'999.000000'}:{})}};}
 if(path.endsWith('/subaccounts/transfers'))return {transfers:[...transfers.values()].filter(t=>t.kind==='bot').map(t=>({transfer_id:t.transfer_id,from_subaccount:0,to_subaccount:1,exchange_index:2,amount_cents:t.amountCents,created_ts:t.created_ts})),cursor:''};
 if(path.endsWith('/intra_exchange_instance_transfers'))return {transfers:[...transfers.values()],cursor:''};
 for(const kind of ['orders','fills','positions','settlements'])if(path.endsWith('/'+kind))return {[kind==='positions'?'market_positions':kind]:[],cursor:''};
 throw Error('unhandled_offline_provider_read:'+path);
};
function transfer(kind:'withdraw'|'bot'|'shard',amountCents:number,clientId?:string){
 postCount++;const n=BigInt(amountCents)*10000n,id='offline-transfer-'+randomUUID();
 if(kind==='withdraw'){bot-=n;cashier+=n;}else if(kind==='bot'){primary-=n;bot+=n;}else{cashier-=n;primary+=n;}
 transfers.set(id,{transfer_id:id,kind,amountCents,client_transfer_id:kind==='shard'?clientId:undefined,source:'event_contract',destination:'event_contract',source_exchange_shard:kind==='shard'?0:2,destination_exchange_shard:kind==='withdraw'?0:2,amount:usd(n),status:'complete',created_ts:Math.floor(Date.now()/1000)});
 return id;
}
const post=async(_c:unknown,n:number)=>{const id=transfer('withdraw',n);if(ambiguous)throw Error('synthetic_response_lost_after_transfer');return {status:200,unreadable:false,transferId:id};};
const topupPost=async(_c:unknown,id:string,n:number,kind:'bot'|'shard')=>({status:200,body:{transfer_id:transfer(kind,n,id)},unreadable:false});
const originalFetch=globalThis.fetch;
function installTransport(){globalThis.fetch=async(input,init)=>{
 const u=new URL(String(input));assert.equal(u.origin,'https://external-api.kalshi.com');
 const headers=new Headers(init?.headers),method=init?.method??'GET',stamp=headers.get('KALSHI-ACCESS-TIMESTAMP')!;
 assert.equal(headers.get('KALSHI-ACCESS-KEY'),creds.keyId);
 assert.ok(verify('sha256',Buffer.from(stamp+method+u.pathname),{key:pair.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(headers.get('KALSHI-ACCESS-SIGNATURE')!,'base64')));
 if(method==='GET')return Response.json(await get(creds,u.pathname,u.search));
 assert.equal(method,'POST');assert.equal(u.pathname,'/trade-api/v2/portfolio/intra_exchange_instance_transfer');const body=JSON.parse(String(init?.body));
 assert.equal(body.source_subaccount,1);assert.equal(body.destination_subaccount,0);assert.equal(body.source_exchange_shard,2);assert.equal(body.destination_exchange_shard,0);assert.equal(body.client_transfer_id,undefined);
 const id=transfer('withdraw',body.amount/100);if(ambiguous)throw Error('synthetic_response_lost_after_transfer');return Response.json({transfer_id:id});
};}
async function seed(){
 await setup.query('TRUNCATE public.v13_production_account,public.v13_live_money_policy,public.financial_accounts,auth.users,vault.secrets CASCADE');
 await setup.query('TRUNCATE vault.decrypted_secrets CASCADE');
 bot=100000000n;cashier=500000000n;primary=200000000n;postCount=0;ambiguous=false;badReceipt=false;transfers.clear();
 for(const [user,id] of [[owner,account],[other,foreign]]){
 const fa=randomUUID(),pc=randomUUID(),secret=randomUUID();await setup.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())',[user,user+'@example.invalid']);
 await setup.query('INSERT INTO vault.secrets(id) VALUES($1)',[secret]);await setup.query('INSERT INTO vault.decrypted_secrets VALUES($1,$2)',[secret,JSON.stringify({api_key_id:creds.keyId,private_key:privateKey})]);
 await setup.query("INSERT INTO public.financial_accounts(id,user_id,provider) VALUES($1,$2,'kalshi')",[fa,user]);await setup.query('INSERT INTO private.provider_connections(id,financial_account_id) VALUES($1,$2)',[pc,fa]);
 await setup.query("INSERT INTO private.kalshi_connection_credentials(id,owner_user_id,financial_account_id,provider_connection_id,role,vault_secret_id,key_fingerprint,verified_at,verification_reason) VALUES($1,$2,$3,$4,'account_setup_execution',$5,$6,now(),'credential_verified')",[randomUUID(),user,fa,pc,secret,fp]);
 await setup.query('INSERT INTO public.v13_production_account(id,owner_user_id,kalshi_connection_id,subaccount,exchange_index,key_fingerprint,cash_micros,initial_cash_micros,reserved_micros) VALUES($1,$2,$3,1,2,$4,100000000,100000000,0)',[id,user,fa,fp]);
 await setup.query(`INSERT INTO public.v13_live_money_policy(id,version,state,execution_account_id,created_by,approved_by,approved_at,policy_hash,capital_limit_cents,max_entry_stake_cents,max_entry_all_in_cents,max_daily_loss_cents,max_total_loss_cents,max_quote_age_ms,max_fee_evidence_age_ms,champion_selection_review_id,champion_selection_evidence_hash,champion_selected_by,champion_selected_at,fee_policy_version,fee_source_url,fee_formula_version)
 VALUES($1,1,'APPROVED',$2,$3,$3,now(),$4,2500,500,625,1000,1500,5000,5000,'offline-review',$4,$3,now(),'strata_api_fee_source_signed_review_v2','strata-api-reviewed://kxbtc15m/55555555-5555-4555-8555-555555555555','standard-quadratic-0.07-v1')`,['policy-'+id,id,user,hash]);
 await setup.query('UPDATE public.v13_production_account SET policy_id=$2,commissioning_digest=$3,minimum_exit_micros=400000,fee_artifact_digest=$3,commissioned=true,cash_precision_verified=true,execution_enabled=false,kill_switch=true,reconciled_at=now() WHERE id=$1',[id,'policy-'+id,hash]);
 await setup.query('INSERT INTO public.strata_configured_stake(id,execution_account_id,configured_stake_cents,revision,updated_at) VALUES($1,$1,500,1,now())',[id]);
 }
}
async function read(){const a=(await setup.query('SELECT * FROM public.v13_production_account WHERE id=$1',[account])).rows[0] as Account;const tx=await pool.connect();try{await new ProductionLedger(pool,account).assertConservation(tx,a);}finally{tx.release();}return a;}
async function quote(amount=7500){const q=await quoteManualSweep(owner,{amountCents:amount,minimumRetainedCents:0},get);assert.equal(q.ok,true,JSON.stringify(q));assert.ok(q.id);return q;}
async function send(id:string){return confirmManualSweep(owner,{quoteId:id,confirmation:CASHIER_SWEEP_CONFIRMATION},get,post as never);}
test('real-schema owner cash movement: floor, one-use sends, exact receipts, ledger and tenant isolation',async t=>{
 try{
 await installFullRecoverySchema(setup);await installCombinedPlatformShape(setup);await setup.query('ALTER TABLE auth.users ADD COLUMN banned_until timestamptz');
 for(const file of ['lib/db/owner-self-release/001_explicit_owner_authority.sql','lib/db/owner-self-release/002_owner_standing_fee_v1.sql','docs/durable-fee/schema.sql','lib/db/owner-self-release/005_durable_fee_release_authorization.sql','lib/db/owner-self-release/006_capital_credit_repair.sql','lib/db/owner-self-release/007_platform_uploaded_fee_schedule.sql','lib/db/owner-self-release/008_terminal_lease_fee_renewal.sql','docs/member-read-budget/schema.sql'])await setup.query(readFileSync('../../'+file,'utf8'));
 await setup.query(`CREATE ROLE strata_paper_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE FUNCTION public.register_kalshi_credential(uuid,uuid,text,text,text) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'registration_outside_cash_transfer_fixture'; END $$; CREATE FUNCTION vault.create_secret(text,text,text) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'credential_creation_outside_cash_transfer_fixture'; END $$;`);
 for(const name of ['20261125183143_audit_runtime_least_privilege.sql','20261125205247_owner_arm_preparation.sql','20261126004500_economic_settlement_receipt.sql','20261126113609_economic_exit_obligation_discharge.sql','20261126183644_owner_cash_flow_accounting.sql'])await setup.query(readFileSync('../../supabase/migrations/'+name,'utf8'));
 await setup.query('CREATE ROLE cash_runtime_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;GRANT strata_api_runtime TO cash_runtime_test');
 const runtimeUrl=new URL(url!);runtimeUrl.username='cash_runtime_test';const runtime=new Native({connectionString:runtimeUrl.href,max:5});
 await pool.end();pool.query=runtime.query.bind(runtime) as typeof pool.query;pool.connect=runtime.connect.bind(runtime) as typeof pool.connect;pool.end=runtime.end.bind(runtime);
 assert.equal((await pool.query('SELECT current_user AS name')).rows[0].name,'cash_runtime_test');
 Object.assign(process.env,{STRATA_OWNER_CASH_TRANSFERS_V1_ENABLED:'true',STRATA_MANUAL_WITHDRAWALS_ENABLED:'true',STRATA_WITHDRAWAL_ROUTING_VERIFIED:'true',STRATA_OWNER_VARIABLE_TOPUP_POST_ENABLED:'true',STRATA_AUTOMATIC_WITHDRAWALS_ENABLED:'true',KALSHI_API_ENVIRONMENT:'production'});
 installTransport();
 await t.test('cash remains visible with trading safety lock off; no transfer is authorized by display',async()=>{
 await seed();await setup.query('UPDATE public.v13_production_account SET kill_switch=false,execution_enabled=true WHERE id=$1',[account]);
 const r=await sweepAvailability(owner,0,get);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.botCashCents,10000);assert.equal(r.requiredCapitalCents,2500);assert.equal(r.maximumCents,7500);assert.equal(r.transferEligible,false);
 assert.equal((await quoteManualSweep(owner,{amountCents:100,minimumRetainedCents:0},get)).ok,false);assert.equal(postCount,0);
 });
 await t.test('manual withdrawal sends once to cashier, retains $25 and preserves original funding and P&L',async()=>{
 await seed();const q=await quote();const results=await Promise.all([send(q.id!),send(q.id!)]);assert.equal(postCount,1);assert.ok(results.some(r=>r.state==='pending'),JSON.stringify(results));
 assert.equal((await reconcileManualSweep(other,q.id!,get)).ok,false);
 badReceipt=true;assert.equal((await reconcileManualSweep(owner,q.id!,get)).ok,false);assert.equal((await read()).cash_micros,'100000000');badReceipt=false;
 const r=await reconcileManualSweep(owner,q.id!,get);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.state,'completed');assert.equal((await reconcileManualSweep(owner,q.id!,get)).ok,true);
 const a=await read();assert.equal(a.cash_micros,'25000000');assert.equal(a.initial_cash_micros,'100000000');assert.equal(a.net_funding_micros,'-75000000');assert.equal(a.kill_switch,true);assert.equal(a.execution_enabled,false);
 assert.equal((await setup.query('SELECT count(*)::int n FROM public.v13_production_event')).rows[0].n,0);assert.equal((await setup.query('SELECT count(*)::int n FROM private.strata_owner_cash_flow_receipt')).rows[0].n,1);
 assert.equal((await send(q.id!)).ok,false);assert.equal(postCount,1);
 });
 await t.test('saved stake/revision change invalidates a prior quote before any POST',async()=>{
 await seed();const q=await quote();await setup.query('UPDATE public.strata_configured_stake SET configured_stake_cents=2500,revision=revision+1 WHERE execution_account_id=$1',[account]);assert.equal((await send(q.id!)).ok,false);assert.equal(postCount,0);
 });
 await t.test('lost provider response remains uncertain and cannot be resent',async()=>{
 await seed();const q=await quote(100);ambiguous=true;const r=await send(q.id!);assert.equal(r.state,'uncertain');assert.equal((await send(q.id!)).ok,false);assert.equal(postCount,1);assert.equal((await read()).cash_micros,'100000000');assert.equal((await reconcileManualSweep(owner,q.id!,get)).ok,false);
 });
 await t.test('top-up credits receipt-backed net funding once, not profit, then supports another top-up',async()=>{
 await seed();const p=await prepareOwnerTopup(pool as never,owner,2500,{get});assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.kind,'bot');
 const r=await executeOwnerTopup(pool as never,owner,{attemptId:p.attemptId,confirmation:OWNER_TOPUP_CONFIRM},{get,post:topupPost as never});assert.equal(r.transferAttempted,true,JSON.stringify(r));
 const done=await reconcileOwnerTopup(pool as never,owner,{get});assert.equal(done.state,'completed',JSON.stringify(done));
 const a=await read();assert.equal(a.cash_micros,'125000000');assert.equal(a.initial_cash_micros,'100000000');assert.equal(a.net_funding_micros,'25000000');
 await reconcileOwnerTopup(pool as never,owner,{get});assert.equal((await read()).cash_micros,'125000000');assert.equal(postCount,1);
 assert.equal((await prepareOwnerTopup(pool as never,owner,1000,{get})).ok,true);
 });
 await t.test('cashier-to-bot funding keeps two separate consented legs and never books the intermediate primary move',async()=>{
 await seed();primary=0n;const p=await prepareOwnerTopup(pool as never,owner,2500,{get});assert.equal(p.kind,'shard');
 await executeOwnerTopup(pool as never,owner,{attemptId:p.attemptId,confirmation:OWNER_TOPUP_CONFIRM},{get,post:topupPost as never});
 const next=await reconcileOwnerTopup(pool as never,owner,{get});assert.equal(next.kind,'bot',JSON.stringify(next));assert.equal(next.state,'prepared');assert.equal(postCount,1);assert.equal((await read()).net_funding_micros,'0');
 await executeOwnerTopup(pool as never,owner,{attemptId:next.attemptId,confirmation:OWNER_TOPUP_CONFIRM},{get,post:topupPost as never});const done=await reconcileOwnerTopup(pool as never,owner,{get});assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(postCount,2);assert.equal((await read()).net_funding_micros,'25000000');
 });
 await t.test('automatic rule is opt-in; excess mode uses saved floor and rejects underfunded retention',async()=>{
 await seed();assert.equal((await readAutoRule(owner)).enabled,false);await processAutoRule(owner);assert.equal(postCount,0);
 const bad=await saveAutoRule(owner,{thresholdCents:3000,withdrawCents:1,minimumRetainedCents:0,enabled:true,expectedRevision:0,sweepMode:'excess',confirmation:AUTO_CONFIRMATION});assert.equal(bad.ok,false);
 const good=await saveAutoRule(owner,{thresholdCents:2600,withdrawCents:1,minimumRetainedCents:2500,enabled:true,expectedRevision:0,sweepMode:'excess',confirmation:AUTO_CONFIRMATION});assert.equal(good.ok,true,JSON.stringify(good));assert.equal(good.sweepMode,'excess');
 for(let n=0;n<5;n++)await processAutoRule(owner);
 assert.equal(postCount,1);const a=await read();assert.equal(a.cash_micros,'25000000');assert.equal(a.net_funding_micros,'-75000000');assert.equal(a.execution_enabled,false);assert.equal(a.kill_switch,true);
 });
 await t.test('runtime cannot edit receipts and browser/paper cannot read them',async()=>{
 await assert.rejects(pool.query('UPDATE private.strata_owner_cash_flow_receipt SET delta_micros=0'),{code:'42501'});
 await assert.rejects(pool.query('DELETE FROM private.strata_owner_cash_flow_receipt'),{code:'42501'});
 const rows=(await setup.query("SELECT has_table_privilege('anon','private.strata_owner_cash_flow_receipt','SELECT') a,has_table_privilege('authenticated','private.strata_owner_cash_flow_receipt','INSERT') b,has_table_privilege('strata_paper_runtime','private.strata_owner_cash_flow_receipt','SELECT') p")).rows[0];assert.deepEqual(rows,{a:false,b:false,p:false});
 });
 }finally{globalThis.fetch=originalFetch;await pool.end();await setup.end();}
});
