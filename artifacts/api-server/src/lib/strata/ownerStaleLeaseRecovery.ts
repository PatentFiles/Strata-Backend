import { randomUUID, createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { readOwnedKalshiFeeds, personalAccountSnapshot } from "./personalExchangeRead";
import { loadedMaterial } from "./inAppProtectiveRelease";
import { readUnresolvedIntentMode } from "./workerUncertainOrderGate";
import type { Identity, Request } from "../v13-production/types";

/**
 * Issue #155: only the authenticated owner may request a fenced recovery.
 * A stale heartbeat alone NEVER qualifies. No order, ARM/START, policy change,
 * balance adjustment or risk-freeze removal is performed by this function.
 */
export const OWNER_STALE_LEASE_CONFIRMATION =
  "I_STOP_AND_DISARM_MY_ACCOUNT_AND_AUTHORIZE_SIGNED_FLAT_STALE_LEASE_RECOVERY";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const BOOT_AT_MS = Date.now();
type Row = Record<string, unknown>;
type Query = { query(sql: string, args?: unknown[]): Promise<{ rows: Row[] }> };
type Client = Query & { release(): void };
type DB = Query & { connect(): Promise<Client> };
type Deps = {
  db?: DB;
  readFeeds?: typeof readOwnedKalshiFeeds;
  now?: () => number;
  isScheduled?: (ownerId: string, accountId: string) => boolean;
  bootAtMs?: number;
};
const val = (x: unknown) => String(x ?? "");
const timestamp = (x: unknown) => new Date(String(x)).getTime();
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const fail = (reason: string) => ({
  ok: false as const, reason, ordersSubmitted: false as const,
  workerStarted: false as const, riskFreezeCleared: false as const
});

/** Exported for clock, identity, and active-worker race regression tests. */
export function eligibleStaleLeaseRecovery(x: {
  nowMs: number; bootAtMs: number; heartbeatAtMs: number; localWorkerRunning: boolean;
  sameOwner: boolean; owned: boolean; accountKill: boolean;
  cashMatches: boolean; exchangeFlat: boolean; localFlat: boolean;
}): {ok: true} | {ok: false; reason: string} {
  if (!x.sameOwner) return {ok: false, reason: "foreign_execution_account"};
  if (x.localWorkerRunning) return {ok: false, reason: "worker_still_running"};
  if (!x.owned || x.accountKill) return {ok: false, reason: "owned_lease_recovery_not_eligible"};
  if (![x.nowMs,x.bootAtMs,x.heartbeatAtMs].every(Number.isSafeInteger) ||
      x.heartbeatAtMs >= x.bootAtMs || x.nowMs-x.heartbeatAtMs < 120000)
    return {ok: false, reason: "stale_worker_death_not_proven"};
  if (!x.cashMatches || !x.exchangeFlat || !x.localFlat)
    return {ok: false, reason: "cash_or_exposure_not_reconciled"};
  return {ok: true};
}

const ACCOUNT = [
 "SELECT a.id,a.owner_user_id::text,a.kalshi_connection_id,a.key_fingerprint,",
 "a.cash_micros::text,a.reserved_micros::text,a.revision,a.blocked_reason,",
 "l.state,l.holder_id,l.fencing_token::text,l.heartbeat_at,l.arm_requested,",
 "l.account_kill,l.credential_fingerprint",
 "FROM public.v13_production_account a",
 "JOIN private.kalshi_account_worker_lease l ON l.execution_account_id=a.id",
 "AND l.owner_user_id=a.owner_user_id",
 "WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2 LIMIT 2"
].join(" ");
const LOCK_ACCOUNT = [
 "SELECT id,revision,cash_micros::text,key_fingerprint FROM public.v13_production_account",
 "WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE"
].join(" ");
const LOCK_LEASE = [
 "SELECT state,holder_id,fencing_token::text,heartbeat_at FROM private.kalshi_account_worker_lease",
 "WHERE execution_account_id=$1 AND owner_user_id=$2::uuid FOR UPDATE"
].join(" ");
const CAS_RELEASE = [
 "UPDATE private.kalshi_account_worker_lease",
 "SET state='released',released_at=now(),heartbeat_at=now(),",
 "arm_requested=false,fencing_token=fencing_token+1",
 "WHERE execution_account_id=$1 AND owner_user_id=$2::uuid AND state='owned'",
 "AND holder_id=$3 AND fencing_token=$4::bigint",
 "AND heartbeat_at=$5::timestamptz AND heartbeat_at<now()-interval '120 seconds'",
 "AND account_kill=false",
 "AND NOT EXISTS(SELECT 1 FROM public.v13_production_position p WHERE p.account_id=$1 AND p.quantity_hundredths<>0)",
 "AND NOT EXISTS(SELECT 1 FROM public.v13_production_intent i WHERE i.account_id=$1 AND i.state IN ('PREPARED','DISPATCHED','UNKNOWN'))",
 "AND NOT EXISTS(SELECT 1 FROM private.strata_emergency_exit_reservations e",
 "WHERE e.execution_account_id=$1 AND e.state IN ('PREPARED','DISPATCHED','UNKNOWN'))",
 "RETURNING fencing_token::text"
].join(" ");

/** Signed GETs take place BEFORE and AFTER the short DB write transaction. */
export async function recoverOwnerStaleLease(
 ownerId: string, confirmation: unknown, deps: Deps = {}
) {
 if (!UUID.test(ownerId) || confirmation !== OWNER_STALE_LEASE_CONFIRMATION)
   return fail("explicit_owner_stop_and_disarm_confirmation_required");
 const db = deps.db ?? pool, now = deps.now ?? Date.now;
 const signedGet = deps.readFeeds ?? readOwnedKalshiFeeds;
 let account: Row, beforeReadAt = 0, signedCash = "";
 const requests: Request[] = [];
 try {
   const records = await db.query(ACCOUNT,[ownerId]);
   if (records.rows.length!==1) return fail("owner_lease_not_unique_or_missing");
   account=records.rows[0]!;
   const id=val(account.id);
   if (deps.isScheduled?.(ownerId,id)) return fail("worker_still_running");
   const intents = await db.query(
     "SELECT request FROM public.v13_production_intent WHERE account_id=$1 ORDER BY created_at,id",[id]);
   for (const row of intents.rows) {
     const req = typeof row.request==="string" ? JSON.parse(row.request) : row.request;
     if (!req || typeof req!=="object") return fail("intent_history_unreadable");
     requests.push(req as Request);
   }
   const creds=await loadedMaterial(db as never,{
     id, owner_id:ownerId, kalshi_connection_id:account.kalshi_connection_id,
     key_fingerprint:account.key_fingerprint
   });
   if (!creds) return fail("restricted_signer_not_available");
   beforeReadAt=now();
   const feed=await signedGet(creds,beforeReadAt);
   if (!feed.ok || feed.observedAtMs!==beforeReadAt) return fail("signed_kalshi_read_unavailable");
   const identity: Identity={subaccount:1,exchangeIndex:2,keyFingerprint:val(account.key_fingerprint)};
   const snapshot=personalAccountSnapshot(identity,feed,requests);
   const unresolved=await readUnresolvedIntentMode((sql,args)=>db.query(sql,args),id);
   const positions=await db.query(
      "SELECT count(*)::int AS n FROM public.v13_production_position WHERE account_id=$1 AND quantity_hundredths<>0",[id]);
   signedCash=feed.cashMicros;
   const eligible=eligibleStaleLeaseRecovery({
      nowMs:now(),bootAtMs:deps.bootAtMs??BOOT_AT_MS,
      heartbeatAtMs:timestamp(account.heartbeat_at),
      localWorkerRunning:deps.isScheduled?.(ownerId,id)??false,
      sameOwner:val(account.owner_user_id)===ownerId &&
       val(account.key_fingerprint)===val(account.credential_fingerprint),
      owned:account.state==="owned",accountKill:account.account_kill===true,
      cashMatches:signedCash===val(account.cash_micros)&&val(account.reserved_micros)==="0",
      exchangeFlat:"identity" in snapshot && snapshot.authenticated &&
       snapshot.complete && snapshot.positions.length===0 &&
       snapshot.orders.every(o=>o.terminal),
      localFlat:positions.rows.length===1&&Number(positions.rows[0]?.n)===0 &&
       unresolved.ok && unresolved.mode==="entries",
   });
   if (!eligible.ok) return fail(eligible.reason);
   if (now()-beforeReadAt>15000) return fail("signed_kalshi_read_expired");
 } catch {return fail("stale_lease_preflight_unavailable");}
 const id=val(account.id);
 let client:Client|null=null,committed=false;
 try {
   client=await db.connect();
   await client.query("BEGIN");
   await client.query("SET LOCAL lock_timeout='1200ms'");
   await client.query("SET LOCAL statement_timeout='8000ms'");
   const a=await client.query(LOCK_ACCOUNT,[id,ownerId]);
   const l=await client.query(LOCK_LEASE,[id,ownerId]);
   if (a.rows.length!==1 || l.rows.length!==1 ||
     val(a.rows[0]?.revision)!==val(account.revision) ||
     val(a.rows[0]?.cash_micros)!==val(account.cash_micros) ||
     val(a.rows[0]?.key_fingerprint)!==val(account.key_fingerprint) ||
     val(l.rows[0]?.fencing_token)!==val(account.fencing_token) ||
     val(l.rows[0]?.holder_id)!==val(account.holder_id) ||
     timestamp(l.rows[0]?.heartbeat_at)!==timestamp(account.heartbeat_at) ||
     l.rows[0]?.state!=="owned" || now()-beforeReadAt>15000 ||
     deps.isScheduled?.(ownerId,id))
      return fail("stale_lease_fence_or_account_changed");
   const released=await client.query(CAS_RELEASE,
     [id,ownerId,account.holder_id,account.fencing_token,account.heartbeat_at]);
   if(released.rows.length!==1)return fail("stale_lease_atomic_fence_refused");
   const event={ownerId,accountId:id,priorToken:val(account.fencing_token),
      nextToken:val(released.rows[0]?.fencing_token),readAt:beforeReadAt,
      accountRevision:account.revision,exchangeDigest:hash({cash:signedCash,requests})};
   await client.query(
    "INSERT INTO public.v13_production_observation(id,account_id,kind,payload,digest) VALUES($1,$2,'OWNER_STALE_LEASE_FENCED_RECOVERY',$3::jsonb,$4)",
    [randomUUID(),id,JSON.stringify(event),hash(event)]);
   await client.query("COMMIT");
   committed=true;
 } catch {return fail("stale_lease_transaction_failed");}
 finally {if(client){if(!committed)try{await client.query("ROLLBACK");}catch{}client.release();}}
 // Does not claim a fresh post-recovery exchange attestation; the account
 // remains blocked until a NEW owner qualification and reconciliation succeed.
 return {ok:true as const,reason:"stale_lease_released_new_signed_qualification_required",
  ordersSubmitted:false as const,workerStarted:false as const,riskFreezeCleared:false as const};
}
