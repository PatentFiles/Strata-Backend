import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { dedicatedSignerFingerprint } from "./commissioning";
import { normalizeKalshiMoney } from "./kalshiUserRead";
import { getScopedKalshiJson, postScopedKalshiCashierSweep } from "../kalshiAccountClient";

/**
 * Owner-only manual cash sweep. The cross-shard Kalshi POST is asynchronous,
 * non-atomic and not safely retryable when its response is lost.
 * This service never alters trading logic, kill switches or credentials.
 * The live POST is disabled unless two operator-reviewed flags are explicitly enabled.
 */
const TABLE = "private.strata_manual_profit_withdrawals";
const TRANSFER_PATH = "/trade-api/v2/portfolio/intra_exchange_instance_transfers";
const BALANCE_PATH = "/trade-api/v2/portfolio/balance";
export const CASHIER_SWEEP_CONFIRMATION = "WITHDRAW_VERIFIED_CASH_TO_PRIMARY_CASHIER";
type Row = Record<string, unknown>;
type Credential = { keyId: string; privateKey: string };
type Snapshot = { botCents: number; cashierCents: number };
type Get = typeof getScopedKalshiJson;
type Post = typeof postScopedKalshiCashierSweep;
export type ManualSweepState = "prepared" | "attempted" | "pending" | "uncertain" | "completed" | "expired";
export type SweepResult = {
  ok: boolean; reason: string; enabled: boolean; id: string | null;
  state: ManualSweepState | null; amountCents: number | null;
  minimumRetainedCents: number | null; botCashCents: number | null;
  cashierCashCents: number | null; maximumCents: number | null;
  expiresAt: string | null; transferId: string | null;
  origin?: "manual" | "automatic" | null;
};
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const exact = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export const withdrawalTransfersEnabled = () => process.env.STRATA_MANUAL_WITHDRAWALS_ENABLED === "true" &&
  process.env.STRATA_WITHDRAWAL_ROUTING_VERIFIED === "true" &&
  process.env.KALSHI_API_ENVIRONMENT === "production";
const enabled = withdrawalTransfersEnabled;
const fail = (reason: string): SweepResult => ({
  ok: false, reason, enabled: enabled(), id: null, state: null,
  amountCents: null, minimumRetainedCents: null, botCashCents: null,
  cashierCashCents: null, maximumCents: null, expiresAt: null, transferId: null,
});
const amountValue = (row: Row, key: string): number | null => {
  const n = Number(row[key]); return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
function exposed(row: Row, reason: string, ok = true): SweepResult {
  return { ok, reason, enabled: enabled(), id: typeof row.id === "string" ? row.id : null,
    state: typeof row.state === "string" ? row.state as ManualSweepState : null,
    amountCents: amountValue(row, "amount_cents"),
    minimumRetainedCents: amountValue(row, "retain_cents"),
    botCashCents: amountValue(row, "bot_before_cents"),
    cashierCashCents: amountValue(row, "cashier_before_cents"),
    maximumCents: null,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString()
      : typeof row.expires_at === "string" ? row.expires_at : null,
    transferId: typeof row.exchange_transfer_id === "string" ? row.exchange_transfer_id : null,
    origin: row.origin === "automatic" ? "automatic" : "manual" };
}
function parseCredential(row: Row): Credential | null {
  if (typeof row.decrypted_secret !== "string" || typeof row.key_fingerprint !== "string") return null;
  try {
    const value: unknown = JSON.parse(row.decrypted_secret);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.api_key_id !== "string" || typeof v.private_key !== "string") return null;
    if (dedicatedSignerFingerprint(v.api_key_id, v.private_key) !== row.key_fingerprint) return null;
    return { keyId: v.api_key_id, privateKey: v.private_key };
  } catch { return null; }
}

const OWNER_SQL = `
SELECT a.id, a.owner_user_id, a.subaccount, a.exchange_index,
       a.kill_switch, a.execution_enabled, a.cash_precision_verified,
       a.reserved_micros::text AS reserved_micros,
       a.initial_cash_micros::text AS initial_cash_micros,
       c.id AS credential_id,c.key_fingerprint,s.decrypted_secret,
       (SELECT count(*)::int FROM v13_production_position p
         WHERE p.account_id=a.id AND p.quantity_hundredths>0) AS open_positions,
       (SELECT count(*)::int FROM v13_production_intent i
         WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED')) AS unresolved_intents,
       (SELECT count(*)::int FROM private.kalshi_account_worker_lease l
         WHERE l.execution_account_id=a.id AND (l.state='owned' OR l.arm_requested=true)) AS active_workers
FROM public.v13_production_account a
JOIN public.financial_accounts fa ON fa.id=a.kalshi_connection_id AND fa.user_id=a.owner_user_id
JOIN private.provider_connections pc ON pc.financial_account_id=fa.id
JOIN private.kalshi_connection_credentials c
  ON c.owner_user_id=a.owner_user_id
  AND c.financial_account_id=fa.id
  AND c.provider_connection_id=pc.id
  AND c.role='account_setup_execution' AND c.revoked_at IS NULL
  AND c.verified_at IS NOT NULL AND c.verification_reason='credential_verified'
JOIN vault.decrypted_secrets s ON s.id=c.vault_secret_id
WHERE a.owner_user_id=$1::uuid AND a.subaccount=1 AND a.exchange_index=2
`;
/**
 * Require account kill switch ON, stopped/disarmed worker, no positions,
 * no intents, no reservations. This ensures order submission cannot race
 * the cross-shard movement without modifying the trading engine.
 */
function ownerSafe(row: Row): boolean {
  return row.kill_switch === true &&
    row.cash_precision_verified === true &&
    row.reserved_micros === "0" &&
    Number(row.open_positions) === 0 &&
    Number(row.unresolved_intents) === 0 &&
    Number(row.active_workers) === 0;
}
async function owned(userId: string): Promise<{ row: Row; creds: Credential } | null> {
  const r = await pool.query(OWNER_SQL, [userId]);
  if (r.rows.length !== 1 || !ownerSafe(r.rows[0]!)) return null;
  const creds = parseCredential(r.rows[0]!);
  return creds ? { row: r.rows[0]!, creds } : null;
}
function readMoney(payload: unknown, subaccount: 0 | 1, shard: 0 | 2): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const outer = payload as Row;
  const raw = outer.balance && typeof outer.balance === "object" && !Array.isArray(outer.balance)
    ? outer.balance as Row : outer;
  for (const row of [outer, raw]) {
    if (row.subaccount !== undefined && row.subaccount !== subaccount) return null;
    if (row.subaccount_number !== undefined && row.subaccount_number !== subaccount) return null;
    if (row.exchange_index !== undefined && row.exchange_index !== shard) return null;
  }
  return normalizeKalshiMoney(raw).cashCents;
}
async function signedBalances(creds: Credential, get: Get): Promise<Snapshot | null> {
  try {
    const [bot, cashier] = await Promise.all([
      get(creds, BALANCE_PATH, "?subaccount=1&exchange_index=2"),
      get(creds, BALANCE_PATH, "?subaccount=0&exchange_index=0"),
    ]);
    const b = readMoney(bot, 1, 2), c = readMoney(cashier, 0, 0);
    return b !== null && c !== null && b >= 0 && c >= 0
      ? { botCents: b, cashierCents: c } : null;
  } catch { return null; }
}
const ACTIVE = "('prepared','attempted','pending','uncertain')";
const SELECT_HISTORY = `
SELECT id::text,state,amount_cents,retain_cents,bot_before_cents,
       cashier_before_cents,exchange_transfer_id,expires_at,created_at,
       attempted_at,completed_at,failure_reason,origin
FROM ${TABLE} WHERE owner_user_id=$1::uuid ORDER BY created_at DESC LIMIT 20
`;

export async function sweepAvailability(userId: string, minimumRetainedCents = 0,
  get: Get = getScopedKalshiJson): Promise<SweepResult> {
  const retain = exact(minimumRetainedCents);
  if (retain === null) return fail("invalid_minimum_retained_cash");
  try {
    const account = await owned(userId);
    if (!account) return fail("withdrawal_account_not_safely_stopped_or_authorized");
    // Preserve the audit record but release unused quotes after their 5m TTL.
    await pool.query(`UPDATE ${TABLE} SET state='expired',updated_at=now()
      WHERE owner_user_id=$1::uuid AND execution_account_id=$2
        AND state='prepared' AND expires_at < now()`, [userId,account.row.id]);
    const active = await pool.query(`SELECT id FROM ${TABLE}
      WHERE execution_account_id=$1 AND state IN ${ACTIVE} LIMIT 1`, [account.row.id]);
    if (active.rows.length) return fail("existing_withdrawal_requires_reconciliation");
    const balance = await signedBalances(account.creds, get);
    if (!balance) return fail("kalshi_scoped_cash_unverified");
    // Always preserve at least the original verified starting capital,
    // as well as any higher owner-requested retained amount.
    const original = BigInt(String(account.row.initial_cash_micros ?? "0"));
    if (original < 0n || original % 10_000n !== 0n) return fail("initial_capital_precision_unverified");
    const floor = Math.max(retain, Number(original / 10_000n));
    if (!Number.isSafeInteger(floor)) return fail("capital_floor_invalid");
    const max = Math.max(0, balance.botCents - floor);
    return { ok: true, reason: enabled() ? "withdrawal_available" : "withdrawal_feature_disabled",
      enabled: enabled(), id: null, state: null, amountCents: null,
      minimumRetainedCents: floor, botCashCents: balance.botCents,
      cashierCashCents: balance.cashierCents, maximumCents: max,
      expiresAt: null, transferId: null };
  } catch { return fail("withdrawal_read_unavailable"); }
}

export async function quoteManualSweep(userId: string, input: unknown,
  get: Get = getScopedKalshiJson): Promise<SweepResult> {
  if (!enabled()) return fail("withdrawal_feature_disabled");
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_request");
  const data = input as Row;
  const amount = exact(data.amountCents), retain = exact(data.minimumRetainedCents);
  if (amount === null || amount < 1 || amount > 100_000_000_000 || retain === null) return fail("invalid_amount");
  const availability = await sweepAvailability(userId, retain, get);
  if (!availability.ok || availability.maximumCents === null ||
      amount > availability.maximumCents || availability.botCashCents === null ||
      availability.cashierCashCents === null || availability.minimumRetainedCents === null) {
    return fail("withdrawal_exceeds_verified_unreserved_cash");
  }
  const account = await owned(userId);
  if (!account) return fail("withdrawal_account_not_safely_stopped_or_authorized");
  const id = randomUUID();
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT id FROM public.v13_production_account WHERE id=$1 AND owner_user_id=$2::uuid FOR UPDATE",
      [account.row.id,userId]);
    await db.query(`UPDATE ${TABLE} SET state='expired',updated_at=now() WHERE execution_account_id=$1 AND state='prepared' AND expires_at<now()`,
      [account.row.id]);
    const inserted = await db.query(`INSERT INTO ${TABLE}
      (id,owner_user_id,execution_account_id,state,amount_cents,retain_cents,
       bot_before_cents,cashier_before_cents,authority_fingerprint)
      VALUES ($1::uuid,$2::uuid,$3,'prepared',$4,$5,$6,$7,$8)
      RETURNING id::text,state,amount_cents,retain_cents,bot_before_cents,
        cashier_before_cents,expires_at,exchange_transfer_id`,
      [id,userId,account.row.id,amount,availability.minimumRetainedCents,
        availability.botCashCents,availability.cashierCashCents,account.row.key_fingerprint]);
    await db.query("COMMIT");
    return exposed(inserted.rows[0]!, "withdrawal_quote_prepared");
  } catch {
    await db.query("ROLLBACK").catch(()=>null);
    return fail("existing_withdrawal_or_quote_failed");
  } finally { db.release(); }
}

/** Durable COMMIT before one financial POST; NEVER automatically retry a lost response. */
export async function confirmManualSweep(userId: string, input: unknown,
  get: Get = getScopedKalshiJson, post: Post = postScopedKalshiCashierSweep,
  automaticAuthorization = false): Promise<SweepResult> {
  if (!enabled()) return fail("withdrawal_feature_disabled");
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_request");
  const data = input as Row;
  if (data.confirmation !== CASHIER_SWEEP_CONFIRMATION ||
      typeof data.quoteId !== "string" || !UUID.test(data.quoteId)) return fail("explicit_confirmation_required");
  try {
    const account = await owned(userId);
    if (!account) return fail("withdrawal_account_not_safely_stopped_or_authorized");
    const plan = await pool.query(`SELECT id::text,state,amount_cents,retain_cents,bot_before_cents,
      cashier_before_cents,authority_fingerprint,expires_at,origin,auto_rule_id,auto_rule_revision FROM ${TABLE}
      WHERE id=$1::uuid AND owner_user_id=$2::uuid AND execution_account_id=$3`,
      [data.quoteId,userId,account.row.id]);
    if (plan.rows.length !== 1 || plan.rows[0]!.state !== "prepared") return fail("quote_missing_or_already_used");
    const row = plan.rows[0]!;
    // A manually supplied quote ID cannot execute an automated quote.
    if ((row.origin === "automatic") !== automaticAuthorization)
      return fail("withdrawal_origin_mismatch");
    const amount = amountValue(row,"amount_cents");
    const retain = amountValue(row,"retain_cents");
    if (amount === null || retain === null || amount <= 0 ||
        row.authority_fingerprint !== account.row.key_fingerprint ||
        !(row.expires_at instanceof Date) || row.expires_at.getTime() <= Date.now())
      return fail("quote_expired_or_credential_changed");
    const cash = await signedBalances(account.creds,get);
    if (!cash || cash.botCents !== amountValue(row,"bot_before_cents") ||
        cash.cashierCents !== amountValue(row,"cashier_before_cents") ||
        cash.botCents - amount < retain) return fail("cash_changed_requote_required");
    const db = await pool.connect(); let claimed = false;
    try {
      await db.query("BEGIN");
      const locked = await db.query(`UPDATE ${TABLE}
        SET state='attempted',attempted_at=now(),updated_at=now()
        WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state='prepared'
          AND expires_at>now() AND authority_fingerprint=$3
          AND (origin='manual' OR EXISTS (
            SELECT 1 FROM private.strata_auto_profit_withdrawal_rules r
            WHERE r.id=strata_manual_profit_withdrawals.auto_rule_id
              AND r.owner_user_id=$2::uuid
              AND r.execution_account_id=strata_manual_profit_withdrawals.execution_account_id
              AND r.enabled=true AND r.revision=strata_manual_profit_withdrawals.auto_rule_revision
              AND r.latched=true AND r.last_attempt_id=strata_manual_profit_withdrawals.id))
          AND EXISTS(SELECT 1 FROM public.v13_production_account a
            WHERE a.id=execution_account_id AND a.owner_user_id=$2::uuid
              AND a.kill_switch=true AND a.reserved_micros=0
              AND NOT EXISTS(SELECT 1 FROM v13_production_position p
                WHERE p.account_id=a.id AND p.quantity_hundredths>0)
              AND NOT EXISTS(SELECT 1 FROM v13_production_intent i
                WHERE i.account_id=a.id AND i.state NOT IN ('TERMINAL','BLOCKED'))
              AND NOT EXISTS(SELECT 1 FROM private.kalshi_account_worker_lease l
                WHERE l.execution_account_id=a.id AND (l.state='owned' OR l.arm_requested=true)))
        RETURNING id`,[data.quoteId,userId,account.row.key_fingerprint]);
      await db.query("COMMIT");
      claimed = locked.rows.length === 1;
    } catch { await db.query("ROLLBACK").catch(()=>null); }
    finally { db.release(); }
    if (!claimed) return fail("withdrawal_claim_not_committed");
    let transferId: string | null = null;
    try {
      const response = await post(account.creds,amount);
      if (response.status === 200 && !response.unreadable) transferId=response.transferId;
    } catch { /* Lost response = UNCERTAIN. Never make a second POST. */ }
    const status = transferId ? "pending" : "uncertain";
    await pool.query(`UPDATE ${TABLE} SET state=$3,exchange_transfer_id=$4,
      failure_reason=$5,updated_at=now()
      WHERE id=$1::uuid AND owner_user_id=$2::uuid AND state='attempted'`,
      [data.quoteId,userId,status,transferId,transferId?null:"kalshi_transfer_response_unconfirmed"]).catch(()=>null);
    return { ...exposed({...row,id:data.quoteId,state:status,exchange_transfer_id:transferId},
      transferId ? "transfer_submitted_reconcile_before_cashier_claim" : "transfer_outcome_uncertain", !!transferId),
      enabled:enabled() };
  } catch { return fail("withdrawal_submission_uncertain_check_history"); }
}

/** READ-ONLY reconciliation: never submits another exchange POST. */
export async function reconcileManualSweep(userId:string, withdrawalId:unknown,
  get:Get=getScopedKalshiJson):Promise<SweepResult> {
  if(typeof withdrawalId!=="string" || !UUID.test(withdrawalId))return fail("invalid_withdrawal_id");
  try{
    const result=await pool.query(`SELECT id::text,state,amount_cents,retain_cents,bot_before_cents,
      cashier_before_cents,exchange_transfer_id,expires_at,execution_account_id
      FROM ${TABLE} WHERE owner_user_id=$1::uuid AND id=$2::uuid`,[userId,withdrawalId]);
    if(result.rows.length!==1)return fail("withdrawal_not_found");
    const record=result.rows[0]!;
    if(record.state==="completed")return exposed(record,"withdrawal_completed");
    if(record.state==="prepared")return exposed(record,"withdrawal_not_submitted");
    if(typeof record.exchange_transfer_id!=="string")return exposed(record,"transfer_unconfirmed_manual_review_required",false);
    const account=await owned(userId);
    if(!account || account.row.id!==record.execution_account_id ||
        !ownerSafe(account.row))return exposed(record,"reconciliation_owner_or_safety_unproven",false);
    const payload=await get(account.creds,`${TRANSFER_PATH}/${record.exchange_transfer_id}`,"");
    if(!payload || typeof payload!=="object" || Array.isArray(payload))return exposed(record,"exchange_receipt_unavailable",false);
    const transfer=(payload as Row).transfer;
    if(!transfer || typeof transfer!=="object" || Array.isArray(transfer))
      return exposed(record,"exchange_receipt_invalid",false);
    const t=transfer as Row;
    if(t.transfer_id!==record.exchange_transfer_id ||
       t.source!=="event_contract" || t.destination!=="event_contract" ||
       t.source_exchange_shard!==2 || t.destination_exchange_shard!==0)
      return exposed(record,"exchange_receipt_identity_mismatch",false);
    const amount=amountValue(record,"amount_cents");
    if(amount===null)return fail("withdrawal_amount_invalid");
    // Intra-transfer receipts express dollars as a fixed-point decimal string.
    const raw=String(t.amount??"");
    if(!/^\d+(?:\.\d{1,6})?$/.test(raw))return exposed(record,"exchange_receipt_amount_unverified",false);
    const [whole,frac=""]=raw.split(".");
    const micros=BigInt(whole!)*1_000_000n+BigInt(frac.padEnd(6,"0"));
    if(micros!==BigInt(amount)*10_000n)return exposed(record,"exchange_receipt_amount_mismatch",false);
    if(t.status!=="complete")return exposed(record,"exchange_transfer_still_pending",false);
    const balances=await signedBalances(account.creds,get);
    const beforeBot=amountValue(record,"bot_before_cents");
    const beforeCashier=amountValue(record,"cashier_before_cents");
    if(!balances || beforeBot===null || beforeCashier===null ||
       balances.botCents!==beforeBot-amount ||
       balances.cashierCents!==beforeCashier+amount)
      return exposed(record,"cashier_and_bot_balance_reconciliation_pending",false);
    const update=await pool.query(`UPDATE ${TABLE}
      SET state='completed',completed_at=now(),updated_at=now(),failure_reason=NULL
      WHERE owner_user_id=$1::uuid AND id=$2::uuid AND state IN ('attempted','pending','uncertain')
      RETURNING id::text,state,amount_cents,retain_cents,bot_before_cents,cashier_before_cents,
        exchange_transfer_id,expires_at`,[userId,withdrawalId]);
    return update.rows.length===1?exposed(update.rows[0]!,"withdrawal_completed"):
      exposed(record,"withdrawal_status_changed_refresh",false);
  }catch{return fail("withdrawal_reconciliation_unavailable");}
}
export interface CashierRouteDiagnostic {
  ok:boolean;reason:string;documentedRoute:boolean;signedBalancesVerified:boolean;
  transferHistoryReadVerified:boolean;liveTransfersEnabled:boolean;
  source:string;destination:string;cashierCashCents:number|null;botCashCents:number|null;
}
/** Owner-scoped authenticated GETs only. Never attest that a POST has worked. */
export async function inspectCashierRouteReadOnly(userId:string):Promise<CashierRouteDiagnostic>{
  const result:CashierRouteDiagnostic={ok:false,reason:"signed_route_not_verified",
    documentedRoute:true,signedBalancesVerified:false,transferHistoryReadVerified:false,
    liveTransfersEnabled:enabled(),source:"subaccount_1_index_2",
    destination:"primary_subaccount_0_index_0",botCashCents:null,cashierCashCents:null};
  try{
    const account=await owned(userId);
    if(!account)return {...result,reason:"account_not_flat_stopped_or_execution_authority_unavailable"};
    const balances=await signedBalances(account.creds,getScopedKalshiJson);
    if(!balances)return {...result,reason:"scoped_bot_or_cashier_cash_unverified"};
    const history=await getScopedKalshiJson(account.creds,TRANSFER_PATH,"?limit=1");
    if(!history||typeof history!=="object"||Array.isArray(history)||
       !Array.isArray((history as Row).transfers))
      return {...result,reason:"authenticated_transfer_history_invalid",
        signedBalancesVerified:true,botCashCents:balances.botCents,cashierCashCents:balances.cashierCents};
    return {...result,ok:true,reason:enabled()?"read_only_routing_verified_money_movement_enabled":
        "read_only_routing_verified_live_destination_receipt_unproven",
      signedBalancesVerified:true,transferHistoryReadVerified:true,
      botCashCents:balances.botCents,cashierCashCents:balances.cashierCents};
  }catch{return {...result,reason:"signed_cashier_route_read_unavailable"};}
}

export async function listManualSweeps(userId:string):Promise<SweepResult[]>{
  try{
    const r=await pool.query(SELECT_HISTORY,[userId]);
    return r.rows.map(row=>exposed(row,row.state==="completed"?"withdrawal_completed":"withdrawal_not_yet_confirmed"));
  }catch{return [];}
}
