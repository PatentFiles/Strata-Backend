import { performance } from "node:perf_hooks";
import { pool, type Pool, type PoolClient } from "@workspace/db";
import { ProductionLedger, type Account } from "../v13-production/ledger";
import { digest } from "../v13-production/types";
import { deployedGitSha } from "./deployedGitSha";
import { configuredOwnerSelfScope, ownerSelfEnrollmentAllowed } from "./ownerSelfReviewMode";
import { CREDIT_CONFIRM } from "./capitalCreditTransfers";
import { capitalNoAuthority } from "./capitalCreditRepair";
import { loadCapitalTransferSigner } from "./capitalCreditTransferSigner";
import type { Db, ProofDeps, Query, Row } from "./capitalCreditProof";
import {
  REGISTERED_OPENING_MODE, registeredOpeningProof, readRegisteredOpeningLocal,
  validRegisteredOpeningScope, type RegisteredOpeningScope,
} from "./registeredOpeningCapitalProof";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{40}$/;
const str=(v:unknown)=>typeof v==="string"?v:"";
type Deps=ProofDeps & {sha?:()=>string;scope?:typeof configuredOwnerSelfScope};
const refused=(reason:string)=>({ok:false as const,reason,...capitalNoAuthority});
const unknown=()=>({ok:false as const,outcome:"UNKNOWN" as const,reason:"registered_opening_commit_unknown",...capitalNoAuthority});
function reason(e:unknown){
  const code=e instanceof Error?e.message:"";
  return /^registered_opening_[a-z_]{1,80}$/.test(code)?code:"registered_opening_proof_or_database_refused";
}
function context(owner:string,d:Deps){
  if(process.env.NODE_ENV!=="test" && Object.keys(d).length)throw Error("registered_opening_production_override_forbidden");
  const c=(d.scope??configuredOwnerSelfScope)(),sha=(d.sha??deployedGitSha)();
  if(!UUID.test(owner)||!SHA.test(sha)||!c||!ownerSelfEnrollmentAllowed(owner,c.accountId,c))
    throw Error("registered_opening_owner_scope_unavailable");
  return {account:c.accountId,sha};
}
function recorded(id:string,scope:RegisteredOpeningScope){
  return {ok:true as const,outcome:"RECORDED" as const,reason:"registered_opening_basis_recorded",
    repairId:id,scope,currentReadinessVerified:false as const,...capitalNoAuthority};
}
function fresh(proof:Awaited<ReturnType<typeof registeredOpeningProof>>,now:number){
  return now>=proof.start && now-proof.start<=15000 && performance.now()-proof.mono<=15000;
}

/** Uses the existing owner-scoped capital journal and its immutable terminal
 * receipt. The mode/version is part of the reviewed digest. The existing
 * unregistered-credit proof still rejects all registered transfers. */
export async function registeredOpeningCapitalPreview(owner:string,d:Deps={}){
  try{
    const c=context(owner,d),proof=await registeredOpeningProof(owner,c.account,c.sha,d);
    return {ok:true as const,scope:proof.scope,confirmation:CREDIT_CONFIRM,
      observedAt:new Date(proof.start).toISOString(),expiresAt:proof.deadline,
      history:{orders:0,fills:0,positions:0,settlements:0,capitalTransfers:1},
      ...capitalNoAuthority};
  }catch(e){return refused(reason(e));}
}
async function readOutcome(db:Query,owner:string,id:string,sha:string){
  const result=await db.query(`SELECT scope,state FROM private.strata_capital_credit_repair
    WHERE repair_id=$1::uuid AND owner_user_id=$2::uuid AND release_commit_sha=$3`,[id,owner,sha]);
  if(result.rows.length===0)return null;
  if(result.rows.length!==1)return unknown();
  const row=result.rows[0]!;
  if(!validRegisteredOpeningScope(row.scope)||row.scope.ownerId!==owner||row.scope.sha!==sha)return unknown();
  return row.state==="RECORDED"?recorded(id,row.scope):unknown();
}
export async function registeredOpeningCapitalOutcome(owner:string,id:string,sha:string,db:Query=pool){
  if(!UUID.test(owner)||!UUID.test(id)||!SHA.test(sha))return unknown();
  try{return await readOutcome(db,owner,id,sha)??unknown();}catch{return unknown();}
}

/** Fresh signed evidence is collected BEFORE the transaction, then its exact
 * digest, owner, account, signer bindings and local history are checked again
 * under a serializable account lock. A single transaction establishes basis
 * and writes the existing immutable journal receipt; it never changes cash,
 * funding, permissions, stake, credentials, or worker state. */
export async function applyRegisteredOpeningCapital(owner:string,raw:unknown,d:Deps={}){
  let c:{account:string;sha:string};
  try{c=context(owner,d);}catch(e){return refused(reason(e));}
  const b=raw as Row;
  let scope:RegisteredOpeningScope;
  try{
    if(!b||typeof b!=="object"||Array.isArray(b)||
      Object.keys(b).sort().join(",")!=="confirmation,repairId,scope"||
      b.confirmation!==CREDIT_CONFIRM||!UUID.test(str(b.repairId))||
      !validRegisteredOpeningScope(b.scope))return refused("registered_opening_exact_consent_required");
    scope=b.scope;
  }catch{return refused("registered_opening_exact_consent_required");}
  const id=str(b.repairId);
  if(scope.mode!==REGISTERED_OPENING_MODE||scope.ownerId!==owner||scope.accountId!==c.account||scope.sha!==c.sha)
    return refused("registered_opening_scope_changed");
  const db:Db=d.db??pool;
  // A previously committed response can be safely read back even though the
  // opening basis is no longer zero. A conflicting same ID never authorizes mutation.
  try{
    const prior=await readOutcome(db,owner,id,c.sha);
    if(prior)return prior.ok&&prior.scope.scopeDigest===scope.scopeDigest?prior:unknown();
  }catch{return unknown();}
  let tx:Awaited<ReturnType<Db["connect"]>>|undefined;
  let committed=false,commitSent=false,discard:Error|undefined;
  let failure="registered_opening_proof_or_database_refused";
  try{
    const proof=await registeredOpeningProof(owner,c.account,c.sha,d);
    if(proof.scope.scopeDigest!==scope.scopeDigest)throw Error("registered_opening_review_scope_changed");
    tx=await db.connect();
    await tx.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await tx.query("SET LOCAL lock_timeout='1500ms'");
    await tx.query("SET LOCAL statement_timeout='12000ms'");
    const local=await readRegisteredOpeningLocal(tx,owner,c.account,true);
    if(local.localStateDigest!==proof.localStateDigest)throw Error("registered_opening_local_state_changed");
    const signer=await loadCapitalTransferSigner(tx,local.a,true);
    if(digest(signer.bindings)!==scope.signerBindingDigest)throw Error("registered_opening_signer_changed");
    const now=(d.now??Date.now)();
    if(!fresh(proof,now))throw Error("registered_opening_signed_evidence_expired");
    const ledger=new ProductionLedger(db as unknown as Pool,c.account);
    await ledger.finalAccountProof(tx as unknown as PoolClient,local.a as unknown as Account,proof.snapshot,now);
    // Existing unique receipt and pending-account indexes also fence this mode
    // against the separate unregistered-capital-credit service.
    const journal=await tx.query(`INSERT INTO private.strata_capital_credit_repair
      (repair_id,owner_user_id,execution_account_id,release_commit_sha,receipt_id,scope_digest,scope,confirmation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING repair_id`,
      [id,owner,c.account,c.sha,scope.receiptId,scope.scopeDigest,scope,CREDIT_CONFIRM]);
    if(journal.rows.length!==1)throw Error("registered_opening_existing_repair_requires_readback");
    const updated=await tx.query(`UPDATE public.v13_production_account
      SET initial_cash_micros=$3::bigint,revision=revision+1,reconciled_at=$7::timestamptz
      WHERE id=$1 AND owner_user_id=$2::uuid AND initial_cash_micros=$4::bigint
        AND revision=$5::bigint AND cash_micros=$6::bigint AND commissioned=true
        AND cash_precision_verified=true AND kill_switch=true AND execution_enabled=false
        AND reserved_micros=0 AND blocked_reason IS NULL
        AND (reconciled_at IS NULL OR reconciled_at<=$7::timestamptz) RETURNING *`,
      [c.account,owner,scope.newInitialCashMicros,scope.oldInitialCashMicros,
        scope.accountRevision,scope.cashMicros,new Date(proof.start).toISOString()]);
    if(updated.rows.length!==1)throw Error("registered_opening_account_cas_failed");
    await ledger.assertConservation(tx as unknown as PoolClient,updated.rows[0] as unknown as Account);
    const saved=await tx.query(`UPDATE private.strata_capital_credit_repair SET state='RECORDED',
      reason='registered_opening_basis_recorded',resolved_at=clock_timestamp(),evidence_deadline=$2::timestamptz
      WHERE repair_id=$1::uuid AND state='PENDING' RETURNING repair_id`,[id,proof.deadline]);
    if(saved.rows.length!==1)throw Error("registered_opening_journal_write_failed");
    if(!fresh(proof,(d.now??Date.now)()))throw Error("registered_opening_signed_evidence_expired");
    // Existing deferred conservation trigger validates the exact post-state
    // at COMMIT. Lost acknowledgment must be resolved by the exact receipt.
    commitSent=true;
    await tx.query("COMMIT");
    committed=true;
  }catch(e){
    failure=reason(e);
    if(commitSent)discard=Error("registered_opening_commit_unknown");
  }finally{
    if(tx){
      if(!committed&&!discard)try{await tx.query("ROLLBACK");}catch{discard=Error("registered_opening_rollback_unknown");}
      tx.release(discard);
    }
  }
  if(committed)return recorded(id,scope);
  try{
    const prior=await readOutcome(db,owner,id,c.sha);
    if(prior)return prior.ok&&prior.scope.scopeDigest===scope.scopeDigest?prior:unknown();
  }catch{return unknown();}
  return commitSent?unknown():refused(failure);
}
