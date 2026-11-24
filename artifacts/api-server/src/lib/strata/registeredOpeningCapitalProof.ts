import { performance } from "node:perf_hooks";
import { pool } from "@workspace/db";
import { digest } from "../v13-production/types";
import { approvedFromRow } from "./ownerStakePolicyAmendment";
import { computeV13LiveMoneyPolicyHash } from "../v13LiveMoneyRisk";
import { dedicatedSignerFingerprint } from "./commissioning";
import { loadedMaterial } from "./inAppProtectiveRelease";
import { getScopedKalshiJson } from "../kalshiAccountClient";
import { readOwnedKalshiFeeds, getOwnedProductionKalshiJson, personalAccountSnapshot, type OwnedKalshiRead } from "./personalExchangeRead";
import { loadCapitalTransferSigner } from "./capitalCreditTransferSigner";
import {capitalStage} from './capitalCreditDiagnostic';
import { readCapitalTransfers, type CapitalTransfer } from "./capitalCreditTransfers";
import { validCreditScope, type CreditScope, type ProofDeps, type Query, type Row } from "./capitalCreditProof";

export const REGISTERED_OPENING_MODE = "REGISTERED_OPENING_BASIS_V1";
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RECEIPT = /^[A-Za-z0-9_-]{8,128}$/;
const digits = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);
const str = (v: unknown) => typeof v === "string" ? v : "";
const time = (v: unknown) => v instanceof Date ? v.getTime() : Date.parse(String(v ?? ""));
function requireOpening(value: unknown, code: string): asserts value {
  if (!value) throw Error("registered_opening_" + code);
}
export type RegisteredOpeningScope = Omit<CreditScope, "scopeDigest"> & {
  mode: typeof REGISTERED_OPENING_MODE;
  currency: "USD";
  receiptKind: "PILOT" | "HISTORICAL";
  financialAccountId: string;
  providerConnectionId: string;
  localStateDigest: string;
  historyDigest: string;
  signerBindingDigest: string;
  scopeDigest: string;
};
export function validRegisteredOpeningScope(raw: unknown): raw is RegisteredOpeningScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const {mode,currency,receiptKind,financialAccountId,providerConnectionId,localStateDigest,
    historyDigest,signerBindingDigest,scopeDigest:hash,...base} = raw as RegisteredOpeningScope;
  const {scopeDigest:_,...core} = raw as RegisteredOpeningScope;
  return mode === REGISTERED_OPENING_MODE && currency === "USD" &&
    (receiptKind === "PILOT" || receiptKind === "HISTORICAL") &&
    UUID.test(financialAccountId) && UUID.test(providerConnectionId) &&
    [localStateDigest,historyDigest,signerBindingDigest,hash].every(v=>typeof v==="string"&&HASH.test(v)) &&
    validCreditScope({...base,scopeDigest:digest(base)}) &&
    base.oldInitialCashMicros === "0" && base.newInitialCashMicros === base.cashMicros &&
    digest(core) === hash;
}
export type RegisteredReceipt = {
  kind: "PILOT" | "HISTORICAL"; registryId: string; receiptId: string; amountCents: number;
  earliestCreatedMs: number; latestCreatedMs: number; verifiedAtMs: number;
  completedAtMs: number; providerConnectionId: string | null; registryDigest: string;
};
export function registeredReceipt(pilot: Row[], historical: Row[], owner: string, account: Row): RegisteredReceipt {
  requireOpening(pilot.length + historical.length === 1, "initial_receipt_ambiguous");
  const t = (pilot[0] ?? historical[0])!;
  requireOpening(t.owner_user_id === owner && t.execution_account_id === account.id, "receipt_scope_mismatch");
  const kind = pilot.length ? "PILOT" : "HISTORICAL";
  const amountCents = Number(kind === "PILOT" ? t.amount_cents : t.bot_after_cents);
  const verifiedAtMs = time(t.verified_at);
  const completedAtMs = kind === "PILOT" ? time(t.completed_at) : verifiedAtMs;
  const createdBoundary = kind === "PILOT" ? time(t.attempted_at) : time(t.transfer_created_at);
  const receiptId = str(kind === "PILOT" ? t.verified_exchange_transfer_id : t.exchange_transfer_id);
  requireOpening(RECEIPT.test(receiptId) && Number.isSafeInteger(amountCents) && amountCents > 0 &&
    amountCents <= 2500000 && Number.isFinite(verifiedAtMs) && Number.isFinite(completedAtMs) &&
    Number.isFinite(createdBoundary) && createdBoundary <= verifiedAtMs && createdBoundary <= completedAtMs,
    "receipt_fields_unverified");
  if (kind === "PILOT") {
    requireOpening(t.state === "completed" && t.financial_account_id === account.kalshi_connection_id &&
      UUID.test(str(t.id)) && UUID.test(str(t.provider_connection_id)) &&
      Number(t.from_subaccount) === 0 && Number(t.to_subaccount) === 1 && Number(t.exchange_index) === 2 &&
      String(t.bot_before_cents) === "0" && String(t.bot_after_cents) === String(amountCents),
      "receipt_scope_mismatch");
  } else {
    requireOpening(String(t.primary_after_cents) === "0", "receipt_scope_mismatch");
  }
  return {kind, registryId:kind==="PILOT"?str(t.id):receiptId, receiptId, amountCents,
    // Applied transfer history timestamps have second precision.
    earliestCreatedMs:Math.floor(createdBoundary/1000)*1000,
    latestCreatedMs:Math.floor((kind==="PILOT"?Math.min(verifiedAtMs,completedAtMs):createdBoundary)/1000)*1000,
    verifiedAtMs, completedAtMs, providerConnectionId:kind==="PILOT"?str(t.provider_connection_id):null,
    registryDigest:digest(t)};
}

/** This mode deliberately repairs only a never-traded, solely initially funded
 * account with a missing zero opening basis. More complex histories require a
 * separate full accounting proof; they never become a balance-only correction. */
export async function readRegisteredOpeningLocal(db: Query, owner: string, account: string, lock = false) {
  const aRows = await db.query(`SELECT a.*,a.owner_user_id::text AS owner_id,a.cash_micros::text AS cash_text,
    a.initial_cash_micros::text AS initial_text,a.revision::text AS revision_text,p.policy_hash,to_jsonb(p) AS policy
    FROM public.v13_production_account a
    JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.execution_account_id=a.id
    WHERE a.owner_user_id=$1::uuid AND a.id=$2 AND a.subaccount=1 AND a.exchange_index=2
    AND p.created_by=$1::text AND p.state='APPROVED' ${lock?"FOR UPDATE OF a FOR SHARE OF p":""}`,[owner,account]);
  requireOpening(aRows.rows.length===1,"account_scope_unverified");
  const a = aRows.rows[0]!;
  requireOpening(a.commissioned===true && a.cash_precision_verified===true && a.kill_switch===true &&
    a.execution_enabled===false && a.blocked_reason===null && String(a.reserved_micros)==="0" &&
    a.initial_text==="0" && digits(a.cash_text) && BigInt(String(a.cash_text))>0n &&
    digits(a.revision_text) && UUID.test(str(a.kalshi_connection_id)) &&
    HASH.test(str(a.key_fingerprint)) && HASH.test(str(a.policy_hash)), "stopped_missing_basis_required");
  const policy = approvedFromRow(a.policy as Row);
  requireOpening(policy && policy.policyHash===computeV13LiveMoneyPolicyHash(policy),"policy_unverified");
  const stake = (await db.query(`SELECT configured_stake_cents::text AS cents FROM public.strata_configured_stake
    WHERE execution_account_id=$1 ${lock?"FOR SHARE":""}`,[account])).rows;
  requireOpening(stake.length===1 && digits(stake[0]!.cents) && BigInt(String(stake[0]!.cents))>0n,"stake_unverified");
  const lease = (await db.query(`SELECT owner_user_id::text,state,account_kill,arm_requested,fencing_token::text
    FROM private.kalshi_account_worker_lease WHERE execution_account_id=$1 ${lock?"FOR UPDATE":""}`,[account])).rows;
  // A never-started account has no lease. Any present lease must be stopped and
  // owned by this account; an absent lease is not a license to start one.
  requireOpening(lease.length===0 || (lease.length===1 && lease[0]!.owner_user_id===owner &&
    lease[0]!.state==="killed" && lease[0]!.account_kill===true && lease[0]!.arm_requested===false),"worker_not_stopped");
  for (const [table,column] of [
    ["public.v13_production_intent","account_id"],
    ["public.v13_production_event","account_id"],
    ["public.v13_production_position","account_id"],
    ["private.strata_emergency_exit_reservations","execution_account_id"],
    ["private.kalshi_owner_topups","execution_account_id"],
  ] as const) {
    // All identifiers are compile-time constants; no client SQL.
    const rows=await db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1 LIMIT 1 ${lock?"FOR SHARE":""}`,[account]);
    requireOpening(rows.rows.length===0,"local_financial_activity_present");
  }
  const pilot=(await db.query(`SELECT * FROM private.kalshi_owner_pilot_transfers WHERE execution_account_id=$1
    LIMIT 2 ${lock?"FOR SHARE":""}`,[account])).rows;
  const historical=(await db.query(`SELECT * FROM private.kalshi_owner_historical_funding WHERE execution_account_id=$1
    LIMIT 2 ${lock?"FOR SHARE":""}`,[account])).rows;
  const receipt=registeredReceipt(pilot,historical,owner,a);
  requireOpening(BigInt(String(a.cash_text))===BigInt(receipt.amountCents)*10000n,"receipt_amount_does_not_explain_cash");
  const registered=await db.query(`SELECT 1 FROM private.kalshi_owner_pilot_transfers
    WHERE owner_user_id=$1::uuid AND verified_exchange_transfer_id=$2
    UNION ALL SELECT 1 FROM private.kalshi_owner_historical_funding
    WHERE owner_user_id=$1::uuid AND exchange_transfer_id=$2
    UNION ALL SELECT 1 FROM private.kalshi_owner_topup_legs l JOIN private.kalshi_owner_topups t ON t.id=l.topup_id
    WHERE t.owner_user_id=$1::uuid AND l.exchange_transfer_id=$2`,[owner,receipt.receiptId]);
  requireOpening(registered.rows.length===1,"initial_receipt_ambiguous");
  const prior=await db.query(`SELECT repair_id FROM private.strata_capital_credit_repair
    WHERE state IN ('PENDING','RECORDED') AND (execution_account_id=$1 OR (owner_user_id=$2::uuid AND receipt_id=$3))
    LIMIT 1 ${lock?"FOR SHARE":""}`,[account,owner,receipt.receiptId]);
  requireOpening(prior.rows.length===0,"existing_repair_requires_readback");
  const localStateDigest=digest({account:a,receipt,stake,lease});
  return {a,receipt,localStateDigest};
}

/** Only complete, fresh, scoped signed reads from the existing transport are
 * used. The client never supplies receipt amounts or provider evidence. */
export function proveRegisteredOpeningEvidence(
  receipt:RegisteredReceipt, cashMicros:string, feeds:OwnedKalshiRead, transfers:CapitalTransfer[], start:number,
) {
  requireOpening(feeds.observedAtMs===start && feeds.historicalCoverageComplete===true &&
    feeds.cashMicros===cashMicros && feeds.orders.length===0 && feeds.fills.length===0 &&
    feeds.positions.length===0 && feeds.settlements.length===0 &&
    receipt.verifiedAtMs<=start && receipt.completedAtMs<=start,"signed_history_unverified");
  const scoped=transfers.filter(r=>r.exchangeIndex===2&&(r.fromSubaccount===1||r.toSubaccount===1));
  requireOpening(scoped.length===1,"additional_or_missing_capital_movements");
  const found=scoped[0]!;
  requireOpening(found.transferId===receipt.receiptId && found.fromSubaccount===0 && found.toSubaccount===1 &&
    found.amountCents===receipt.amountCents && found.createdAtMs>=receipt.earliestCreatedMs &&
    found.createdAtMs<=receipt.latestCreatedMs &&
    BigInt(cashMicros)===BigInt(found.amountCents)*10000n,"signed_receipt_mismatch");
  return found;
}
export async function registeredOpeningProof(owner:string,account:string,sha:string,d:ProofDeps={}) {
  const db=d.db??pool, now=d.now??Date.now, start=now(), mono=performance.now();
  const local=await capitalStage('local_ledger',()=>readRegisteredOpeningLocal(db,owner,account));
  const material=await capitalStage('restricted_signer',async()=>{
    const loaded=await(d.load??loadedMaterial)(db,local.a);
    requireOpening(loaded && dedicatedSignerFingerprint(loaded.keyId,loaded.privateKey)===local.a.key_fingerprint,
      "restricted_signer_unverified");
    return loaded;
  });
  const signer=await capitalStage('transfer_signer',async()=>{
    const loaded=await loadCapitalTransferSigner(db,local.a);
    requireOpening(!local.receipt.providerConnectionId || local.receipt.providerConnectionId===loaded.bindings.setup.providerConnectionId,
      "receipt_provider_connection_mismatch");
    return loaded;
  });
  const signal=AbortSignal.timeout(15000);
  const [feeds,transfers]=await Promise.all([
    capitalStage('signed_trade_history',async()=>{
      // The shared reader returns a safe coarse reason. Retain its underlying
      // exception here only for the existing allowlisted capital diagnostic.
      let failure:unknown;
      const get:typeof getScopedKalshiJson=async(...args)=>{
        try{return await getOwnedProductionKalshiJson(...args);}
        catch(error){failure??=error;throw error;}
      };
      const read=d.read?await d.read(material,start):await readOwnedKalshiFeeds(material,start,get);
      if(!read.ok&&failure)throw failure;
      requireOpening(read.ok,"signed_evidence_stale_or_unavailable");return read;
    }),
    capitalStage('transfer_history',()=>readCapitalTransfers((path,q)=>(d.get??getScopedKalshiJson)(signer.material,path,q,fetch,"https://external-api.kalshi.com",owner,signal),start)),
  ]);
  const {found,snapshot}=await capitalStage('signed_trade_history',async()=>{
    requireOpening(now()>=start && now()-start<=15000 && performance.now()-mono<=15000,
      "signed_evidence_stale_or_unavailable");
    const found=proveRegisteredOpeningEvidence(local.receipt,String(local.a.cash_text),feeds,transfers,start);
    const snapshot=personalAccountSnapshot({subaccount:1,exchangeIndex:2,keyFingerprint:String(local.a.key_fingerprint)},feeds,[]);
    requireOpening("identity" in snapshot && snapshot.authenticated && snapshot.complete &&
      snapshot.cashExact && !snapshot.unexplainedCashActivity,"signed_history_unverified");
    return {found,snapshot};
  });
  // checkpointId/Digest name the actual immutable initial-funding registry
  // evidence in this mode, never a fabricated RECONCILIATION observation.
  const core:Omit<RegisteredOpeningScope,"scopeDigest">={
    mode:REGISTERED_OPENING_MODE,currency:"USD",ownerId:owner,accountId:account,sha,
    policyHash:String(local.a.policy_hash),checkpointId:local.receipt.registryId,
    checkpointDigest:local.receipt.registryDigest,receiptKind:local.receipt.kind,
    receiptId:found.transferId,receiptDigest:digest(found),receiptCreatedAt:new Date(found.createdAtMs).toISOString(),
    amountCents:found.amountCents,oldInitialCashMicros:"0",newInitialCashMicros:String(local.a.cash_text),
    cashMicros:String(local.a.cash_text),accountRevision:String(local.a.revision_text),
    financialAccountId:String(local.a.kalshi_connection_id),providerConnectionId:signer.bindings.setup.providerConnectionId,
    localStateDigest:local.localStateDigest,signerBindingDigest:digest(signer.bindings),
    historyDigest:digest({cashMicros:snapshot.cashMicros,orders:snapshot.orders,fills:snapshot.fills,
      positions:snapshot.positions,settlements:snapshot.settlements,receipt:found}),
  };
  const scope={...core,scopeDigest:digest(core)};
  requireOpening(validRegisteredOpeningScope(scope),"scope_invalid");
  return {...local,scope,snapshot,start,mono,deadline:new Date(start+15000).toISOString()};
}
