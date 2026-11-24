import { accountSetupPreconditionDigest, type AccountSetupOperation, type AccountSetupNextAuthorizedAction, type PublicAccountSetupAttempt } from "./accountSetupPreparation";

export const TECHNICAL_SETUP_CONFIRMATION = "ADVANCE_OWNER_TECHNICAL_SETUP_V1";
export const EXECUTE_TECHNICAL_SETUP_CONFIRMATION = "EXECUTE_OWNER_TECHNICAL_SETUP_V2";
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
  preparedAttempts?: readonly {attemptId:string;operation:AccountSetupOperation;state:string}[];
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
  review?: TechnicalSetupReview;
  completedOperations?: readonly AccountSetupOperation[];
  elapsedMs?: number;
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
export async function advanceTechnicalSetup(ports:TechnicalSetupPorts,budgetMs=65_000):Promise<TechnicalSetupResult> {
  const start=ports.now();
  const expired=()=>!Number.isFinite(start)||!Number.isFinite(ports.now())||
    ports.now()<start||ports.now()-start>=Math.min(65_000,Math.max(0,budgetMs));
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
      // A slow snapshot can exhaust the budget after the earlier check.
      if(expired())return technicalSetupResult("RESUME_REQUIRED","technical_setup_request_budget_reached",observed);
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
    if(expired())return technicalSetupResult("RESUME_REQUIRED","technical_setup_request_budget_reached",observed);
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
    const readback=await refresh();
    if(!readback.preparedAttempts?.some(a=>a.attemptId===attempt.attemptId&&a.operation===op&&a.state==="prepared"))
      return technicalSetupResult("UNKNOWN","prepared_operation_readback_unconfirmed",observed);
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


/** This approval is for provisioning only. The persisted operation journal,
 * not browser state or a previous HTTP response, determines whether an
 * operation is eligible. A resumed request always reviews current bindings. */
export type TechnicalSetupReview=Readonly<{
  version:"technical_setup_v2";digest:string;attemptId:string;
  operations:readonly AccountSetupOperation[];
}>;
export type TechnicalSetupPlan=Readonly<{
  scope:string;firstAttemptId:string;firstOperation:AccountSetupOperation;
  firstPreconditionDigest:string;operations:readonly AccountSetupOperation[];
  digest:string;
}>;
export function buildTechnicalSetupPlan(
  snapshot:TechnicalSetupSnapshot,attempt:Readonly<{attemptId:string;operation:AccountSetupOperation;preconditionDigest:string}>,
):TechnicalSetupPlan|null{
  if(!validSnapshot(snapshot)||snapshot.executionAccountExists||snapshot.unresolvedAttemptId||
     !UUID.test(attempt.attemptId)||!HEX.test(attempt.preconditionDigest)||
     !snapshot.preparedAttempts?.some(a=>a.attemptId===attempt.attemptId&&a.operation===attempt.operation&&a.state==="prepared")||
     !SETUP_ROLE_ORDER.slice(0,3).every(role=>snapshot.bindings.some(b=>b.role===role&&b.verified)))return null;
  const restricted=snapshot.bindings.find(b=>b.role==="restricted_execution");
  // Never rotate a saved key through the automated workflow.
  if(restricted&&!restricted.verified||restricted&&attempt.operation==="generate_api_key")return null;
  const ordered:AccountSetupOperation[]=["create_subaccount",...(restricted?[]:["generate_api_key" as const]),"provision_execution_account"];
  const start=ordered.indexOf(attempt.operation);if(start<0)return null;
  const operations=ordered.slice(start);
  const body={version:"technical_setup_v2",scope:snapshot.scope,firstAttemptId:attempt.attemptId,
    firstOperation:attempt.operation,firstPreconditionDigest:attempt.preconditionDigest,operations,
    target:{subaccount:1,exchangeIndex:2},allowRotation:false,allowFunding:false,allowTrading:false};
  return {...body,digest:accountSetupPreconditionDigest(body)};
}
export function publicTechnicalSetupReview(plan:TechnicalSetupPlan):TechnicalSetupReview{
  return {version:"technical_setup_v2",digest:plan.digest,attemptId:plan.firstAttemptId,operations:[...plan.operations]};
}
export type ReviewedSetupAttempt=Readonly<{attemptId:string;operation:AccountSetupOperation;preconditionDigest:string}>;
export type AuthorizedTechnicalSetupPorts={
  snapshot():Promise<TechnicalSetupSnapshot>;
  advance(remainingMs:number):Promise<TechnicalSetupResult>;
  nextAttempt():Promise<ReviewedSetupAttempt|null>;
  execute(attempt:ReviewedSetupAttempt,scope:string,deadline:number):Promise<{ok:boolean;reason:string;state?:string|null;attempted?:boolean}>;
  confirmCompleted(attempt:ReviewedSetupAttempt,prior:TechnicalSetupSnapshot):Promise<TechnicalSetupSnapshot|null>;
  now():number;
};
/** Only an explicit matching review can enter this path. Each actual executor
 * must atomically check the exact scope and record its claim before any POST.
 * There is no long transaction across network I/O, no automatic HTTP retries,
 * and no path to funding, policy acceptance, commissioning approval or START. */
export async function executeAuthorizedTechnicalSetup(plan:TechnicalSetupPlan,ports:AuthorizedTechnicalSetupPorts):Promise<TechnicalSetupResult>{
  const start=ports.now(),deadline=start+65_000;
  const completed:AccountSetupOperation[]=[];
  let observed:SetupRole[]=[],inFlight=false;
  const result=(stage:Stage,reason:string,attemptId:string|null=null)=>({
    ...technicalSetupResult(stage,reason,observed,null,attemptId),completedOperations:[...completed],
    elapsedMs:Math.max(0,Math.floor(ports.now()-start)),
  });
  const remaining=()=>Number.isFinite(ports.now())&&ports.now()>=start?deadline-ports.now():0;
  try{
    let snapshot=await ports.snapshot();
    if(!validSnapshot(snapshot)||snapshot.scope!==plan.scope||snapshot.executionAccountExists)
      return result("BLOCKED","technical_setup_scope_changed");
    observed=verified(snapshot);
    for(let index=0;index<plan.operations.length;index++){
      if(remaining()<=0)return result("RESUME_REQUIRED","technical_setup_request_budget_reached");
      if(snapshot.unresolvedAttemptId)return result("WAITING_RECONCILIATION","prior_operation_requires_reconciliation",snapshot.unresolvedAttemptId);
      if(index>0){
        const prepared=await ports.advance(remaining());
        if(prepared.stage!=="PREPARED"&&prepared.stage!=="NEEDS_OWNER_ACTION")
          return {...prepared,completedOperations:[...completed],elapsedMs:Math.max(0,Math.floor(ports.now()-start))};
      }
      const current=await ports.snapshot();
      if(!validSnapshot(current)||current.scope!==snapshot.scope||current.executionAccountExists)
        return result("BLOCKED","technical_setup_scope_changed");
      if(current.unresolvedAttemptId)return result("WAITING_RECONCILIATION","prior_operation_requires_reconciliation",current.unresolvedAttemptId);
      const attempt=await ports.nextAttempt();
      if(!attempt||attempt.operation!==plan.operations[index]||!UUID.test(attempt.attemptId)||!HEX.test(attempt.preconditionDigest)||
          !current.preparedAttempts?.some(a=>a.attemptId===attempt.attemptId&&a.operation===attempt.operation&&a.state==="prepared")||
          (index===0&&(attempt.attemptId!==plan.firstAttemptId||attempt.preconditionDigest!==plan.firstPreconditionDigest)))
        return result("NEEDS_OWNER_ACTION","technical_setup_plan_changed");
      if(remaining()<=0)return result("RESUME_REQUIRED","technical_setup_request_budget_reached",attempt.attemptId);
      inFlight=true;
      const outcome=await ports.execute(attempt,current.scope,deadline);
      if(!outcome.ok||outcome.state!=="completed"){
        inFlight=false;
        const readback=await ports.snapshot();
        if(readback.unresolvedAttemptId||outcome.attempted||noReplayStates.has(outcome.state??""))
          return result("WAITING_RECONCILIATION","prior_operation_requires_reconciliation",readback.unresolvedAttemptId??attempt.attemptId);
        return result("BLOCKED",outcome.reason,attempt.attemptId);
      }
      const next=await ports.confirmCompleted(attempt,current);
      if(!next||!validSnapshot(next))return result("UNKNOWN","technical_setup_completed_readback_unconfirmed",attempt.attemptId);
      inFlight=false;completed.push(attempt.operation);snapshot=next;observed=verified(snapshot);
      if(attempt.operation==="provision_execution_account")
        return snapshot.executionAccountExists?result("EXISTING_ACCOUNT","technical_setup_provisioned_owner_review_required"):
          result("UNKNOWN","technical_setup_completed_readback_unconfirmed",attempt.attemptId);
      if(snapshot.executionAccountExists)return result("BLOCKED","technical_setup_scope_changed");
    }
    return result("NEEDS_OWNER_ACTION","technical_setup_owner_or_external_action_required");
  }catch{return result(inFlight?"UNKNOWN":"BLOCKED",inFlight?"technical_setup_outcome_unconfirmed":"technical_setup_unavailable");}
}
