import type { AccountSetupOperation, AccountSetupNextAuthorizedAction, PublicAccountSetupAttempt } from "./accountSetupPreparation";

export const TECHNICAL_SETUP_CONFIRMATION = "ADVANCE_OWNER_TECHNICAL_SETUP_V1";
export const SETUP_ROLE_ORDER = ["provisioning","verification","account_setup_execution","restricted_execution"] as const;
export type SetupRole = typeof SETUP_ROLE_ORDER[number];

export type SetupRoleBinding = Readonly<{
  role: SetupRole;
  fingerprint: string;
  vaultSecretId: string;
  verified: boolean;
}>;
export type TechnicalSetupSnapshot = Readonly<{
  scope: string; // Internal owner/connection/account/exact credential version pin. Never returned.
  executionAccountExists: boolean;
  bindings: readonly SetupRoleBinding[];
  unresolvedAttemptId?: string|null;
}>;
export type TechnicalSetupPorts = {
  snapshot(): Promise<TechnicalSetupSnapshot>;
  verify(binding: SetupRoleBinding): Promise<{ok:boolean;reason:string}>;
  status(): Promise<{executionAccountExists?:boolean|null;nextAuthorizedAction?:AccountSetupNextAuthorizedAction|null;
    operationPreparations?:readonly PublicAccountSetupAttempt[]}>;
  prepare(operation:AccountSetupOperation): Promise<{ok:boolean;reason:string;attempt?:PublicAccountSetupAttempt|null}>;
  now():number;
};
type Stage = "EXISTING_ACCOUNT"|"NEEDS_CREDENTIAL"|"NEEDS_OWNER_ACTION"|"PREPARED"|
  "WAITING_RECONCILIATION"|"BLOCKED"|"UNKNOWN"|"RESUME_REQUIRED"|"BUSY";
export type TechnicalSetupResult = Readonly<{
  ok:boolean;stage:Stage;reason:string;verifiedRoles:readonly SetupRole[];
  nextAction:string|null;attemptId:string|null;
  executable:false;ordersSubmitted:false;transferAttempted:false;workerStarted:false;
}>;
const SAFE_REASON=/^[a-z][a-z0-9_]{0,99}$/;
const HEX=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const allowedOperations = new Set<AccountSetupOperation>(["create_subaccount","generate_api_key","provision_execution_account"]);
const noReplayStates=new Set(["attempted","response_received","uncertain"]);
export function technicalSetupResult(stage:Stage,reason:string,verifiedRoles:readonly SetupRole[]=[],nextAction:string|null=null,attemptId:string|null=null):TechnicalSetupResult {
  return {ok:stage==="EXISTING_ACCOUNT"||stage==="NEEDS_CREDENTIAL"||stage==="NEEDS_OWNER_ACTION"||stage==="PREPARED"||stage==="RESUME_REQUIRED",
    stage,reason:SAFE_REASON.test(reason)?reason:"technical_setup_unavailable",
    verifiedRoles:[...verifiedRoles],nextAction:nextAction&&SAFE_REASON.test(nextAction)?nextAction:null,
    attemptId:attemptId&&UUID.test(attemptId)?attemptId:null,
    executable:false,ordersSubmitted:false,transferAttempted:false,workerStarted:false};
}
const verified=(s:TechnicalSetupSnapshot)=>SETUP_ROLE_ORDER.filter(role=>s.bindings.some(b=>b.role===role&&b.verified));
const validSnapshot=(s:TechnicalSetupSnapshot)=>!!s.scope&&typeof s.executionAccountExists==="boolean"&&
  s.bindings.length<=SETUP_ROLE_ORDER.length&&new Set(s.bindings.map(b=>b.role)).size===s.bindings.length&&
  s.bindings.every(b=>SETUP_ROLE_ORDER.includes(b.role)&&HEX.test(b.fingerprint)&&UUID.test(b.vaultSecretId)&&typeof b.verified==="boolean");

/**
 * Bounded technical advancement using the existing durable credential bindings
 * and account-operation attempts as the progress journal. It has NO operation
 * execution port: cannot create a subaccount/key, transfer, approve a policy,
 * commission, ARM, or START. Preparation and signed GET verification are the
 * only permitted effects. An UNKNOWN outcome is never retried in this run.
 * The next explicit request rereads persisted facts rather than replaying.
 */
export async function advanceTechnicalSetup(ports:TechnicalSetupPorts):Promise<TechnicalSetupResult> {
  const start=ports.now();
  const expired=()=>!Number.isFinite(start)||!Number.isFinite(ports.now())||
    ports.now()<start||ports.now()-start>=65_000;
  let snapshot:TechnicalSetupSnapshot|undefined;
  let observed:SetupRole[]=[];
  let actionInFlight=false;
  try {
    snapshot=await ports.snapshot();
    if(!validSnapshot(snapshot))return technicalSetupResult("BLOCKED","technical_setup_scope_unverified");
    observed=verified(snapshot);
    if(snapshot.executionAccountExists)return technicalSetupResult("EXISTING_ACCOUNT","existing_execution_account_preserved",observed);
    if(snapshot.unresolvedAttemptId)return technicalSetupResult("WAITING_RECONCILIATION","prior_operation_requires_reconciliation",observed,null,snapshot.unresolvedAttemptId);
    const scope=snapshot.scope;
    const refresh=async()=>{
      const current=await ports.snapshot();
      if(!validSnapshot(current)||current.scope!==scope||current.executionAccountExists)
        throw new Error("technical_setup_scope_changed");
      if(current.unresolvedAttemptId)throw new Error("technical_setup_prior_operation_unresolved");
      snapshot=current;
      observed=verified(current);
      return current;
    };
    for(const role of SETUP_ROLE_ORDER){
      if(expired())return technicalSetupResult("RESUME_REQUIRED","technical_setup_request_budget_reached",observed);
      const current=await refresh();
      const binding=current.bindings.find(b=>b.role===role);
      if(!binding){
        // Restricted execution is generated by the separately confirmed
        // existing provisioning operation; its absence is normal here.
        if(role==="restricted_execution")break;
        return technicalSetupResult("NEEDS_CREDENTIAL","setup_role_missing",observed,"register_"+role);
      }
      if(binding.verified)continue;
      actionInFlight=true;
      const result=await ports.verify(binding);
      actionInFlight=false;
      if(!result.ok)return technicalSetupResult("BLOCKED",result.reason,observed,"verify_"+role);
      const updated=await refresh();
      if(!updated.bindings.some(b=>b.role===role&&b.verified))
        return technicalSetupResult("UNKNOWN","verification_readback_unconfirmed",observed);
    }
    if(expired())return technicalSetupResult("RESUME_REQUIRED","technical_setup_request_budget_reached",observed);
    const status=await ports.status();
    await refresh();
    if(status.executionAccountExists===true)return technicalSetupResult("EXISTING_ACCOUNT","existing_execution_account_preserved",observed);
    const next=status.nextAuthorizedAction;
    const unresolved=status.operationPreparations?.find(a=>noReplayStates.has(a.state));
    if(unresolved)return technicalSetupResult("WAITING_RECONCILIATION","prior_operation_requires_reconciliation",observed,next?.action??null,unresolved.attemptId);
    if(!next)return technicalSetupResult("NEEDS_OWNER_ACTION","technical_setup_next_action_unverified",observed);
    const op=next.operation;
    if(next.attemptId)return technicalSetupResult("NEEDS_OWNER_ACTION","existing_prepared_or_reviewed_operation",observed,next.action,next.attemptId);
    if(!op||!allowedOperations.has(op)||next.action!=="prepare_"+op)
      return technicalSetupResult("NEEDS_OWNER_ACTION","technical_setup_owner_or_external_action_required",observed,next.action);
    if(expired())return technicalSetupResult("RESUME_REQUIRED","technical_setup_request_budget_reached",observed);
    actionInFlight=true;
    const prepared=await ports.prepare(op);
    actionInFlight=false;
    if(!prepared.ok)return technicalSetupResult("BLOCKED",prepared.reason,observed,next.action);
    const attempt=prepared.attempt;
    if(!attempt||attempt.state!=="prepared"||attempt.operation!==op||!UUID.test(attempt.attemptId))
      return technicalSetupResult("UNKNOWN","prepared_operation_readback_unconfirmed",observed);
    await refresh();
    return technicalSetupResult("PREPARED","technical_operation_prepared_for_owner_review",observed,next.action,attempt.attemptId);
  }catch(error){
    if(!actionInFlight&&error instanceof Error&&error.message==="technical_setup_prior_operation_unresolved")
      return technicalSetupResult("WAITING_RECONCILIATION","prior_operation_requires_reconciliation",observed);
    if(!actionInFlight&&error instanceof Error&&error.message==="technical_setup_scope_changed")
      return technicalSetupResult("BLOCKED","technical_setup_scope_changed",observed);
    return technicalSetupResult(actionInFlight?"UNKNOWN":"BLOCKED",actionInFlight?"technical_setup_outcome_unconfirmed":"technical_setup_unavailable",observed);
  }
}

/** Per-process pressure bound. Durable attempt uniqueness and binding checks
 * remain the authority across Railway replicas. No queued/infinite retries. */
export function createTechnicalSetupAdmission(max=8){
  const active=new Set<string>();
  return async function run(owner:string,work:()=>Promise<TechnicalSetupResult>):Promise<TechnicalSetupResult>{
    if(active.has(owner)||active.size>=max)return technicalSetupResult("BUSY","technical_setup_busy");
    active.add(owner);
    try{return await work();}
    finally{active.delete(owner);}
  };
}
