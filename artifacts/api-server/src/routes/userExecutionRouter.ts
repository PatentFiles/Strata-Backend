import { Router, type IRouter, type RequestHandler } from "express";
import {previewOwnedApiFeeMigration,migrateOwnedApiFeePolicy} from "../lib/strata/ownerApiFeePolicyMigration";
import { sanitizePublic } from "../lib/v13-production/sanitize";
import { inspectRuntimeDbIdentity } from "../lib/strata/apiFeeRuntimeDbIdentity";
import {inspectSingleOwnerFeePreflight} from "../lib/strata/singleOwnerFeePreflight";
import {observeDynamicKalshiFees} from "../lib/strata/dynamicOfficialFeeSchedule";
import {observeOfficialTariffHtml} from "../lib/strata/officialTariffHtmlObservation";
import {inspectWalletV4Readiness} from "../lib/strata/walletV4CommissioningReadiness";
import {inspectOwnerFiveGateReleaseAudit} from "../lib/strata/ownerFiveGateReleaseAudit";
import {inspectIsolatedIssuerFeeSourceStatus} from "../lib/strata/isolatedIssuerFeeSourceStatus";
import {captureIndependentOfficialFeeV5,readIndependentOfficialFeeV5} from "../lib/strata/independentOfficialFeeV5";
import {inspectOwnerSignedExchangeReleaseProof} from "../lib/strata/ownerSignedExchangeReleaseProof";
import {previewOwnerV4CommissioningRepair,repairOwnerV4CommissioningHold} from "../lib/strata/ownerV4CommissioningRepair";
import {inspectOwnerAccountOnboardingReadiness,publicOwnerAccountOnboardingReadiness} from "../lib/strata/ownerAccountOnboardingReadiness";
import {recordWalletV4FeeEvidence,authorizeWalletV4FeeModel,revokeWalletV4FeeConsent} from "../lib/strata/walletV4OwnerConsent";
import {recordOwnerV3FeeEvidence} from "../lib/strata/ownerFeeV3Evidence";
import {issueOwnerV3FeeAuthority,verifyOwnerV3FeeAuthority,revokeOwnerV3FeeAuthority} from "../lib/strata/ownerFeeV3Authority";
import {previewOwnedV3FeeMigration,migrateOwnedV3FeePolicy} from "../lib/strata/ownerFeeV3Migration";
import { probeCurrentKalshiFeeApi } from "../lib/strata/twoSourceFeeEvidence";
import { step6ApiFeeObservation } from "../lib/strata/step6ApiFeeObservation";
import { preparePdfFreeApiFeePolicyReview } from "../lib/strata/apiFeePolicyReviewCandidate";
import { recordApiFeeRateReview, issueApiFeeSourceGrant, recordApiFeeOwnerConsent, revokeApiFeeOwnerConsent, revokeApiFeeSourceGrant, inspectApiFeeSourceReadiness } from "../lib/strata/apiFeeHumanApprovals";
import {signStandingFeeModel,consentStandingFeeDelegation,
 revokeStandingFeeDelegation,revokeStandingFeeModel,inspectStandingFeeReadiness}
 from "../lib/strata/apiFeeStandingDelegation";
import { inspectOperatorFeeCandidate } from "../lib/strata/operatorFeeCandidateRead";
import { inspectCommissioningFeeEvidence } from "../lib/strata/commissioningFeeEvidenceDiagnostic";
import { inspectOwnerFeeSourceReadiness } from "../lib/strata/operatorFeeAuthorizationReadiness";
import { recordOwnerFeeSourceConsent, revokeOwnerFeeSourceConsent } from "../lib/strata/ownerFeeSourceConsent";
import { verifyOwnerFeeSourceStage } from "../lib/strata/ownerFeeSourceStage";
import { feeSourcePolicyDocument, signIndependentFeePolicyReview,
  issueReviewedOwnerFeeSourceGrant, revokeReviewedFeeSourceGrant,
  listEligibleFeeSourceOwners, inspectFeePolicySigningStatus
} from "../lib/strata/operatorFeePolicyAuthority";
import { emptyUserExecutionView, type ControlAction, type UserExecutionView } from "../lib/strata/userExecutionScope";
import type { PolicyDraft, SharedPreset } from "../lib/strata/sharedPresets";
import type { KalshiUserRead } from "../lib/strata/kalshiUserRead";
import { emptyKalshiUserRead } from "../lib/strata/kalshiUserRead";
import type { OwnerFundingMaintenanceReadiness } from "../lib/strata/ownerFundingMaintenanceReadiness";
import type { TopupStatus } from "../lib/strata/ownerVariableTopup";
import { QUALIFICATION_CONFIRMATION, RESIDUAL_RISK_CONFIRMATION, type QualificationResult } from "../lib/strata/qualifyAdvancedApi";
import { readQualificationDiagnostics, type QualificationDiagnostic } from "../lib/strata/qualificationDiagnostics";
import type { AccountSetupNextRequirement } from "../lib/strata/accountCredentialProbe";
import type {
  AccountSetupNextAuthorizedAction,
  PublicAccountSetupAttempt,
} from "../lib/strata/accountSetupPreparation";

export interface UserCommissioningStatus {
  ready: boolean;
  executable: false;
  blockers: string[];
  subaccount1Exists: boolean | null;
  subaccount1Exchange2Exists: boolean | null;
  subaccount1SafeToCreate: boolean | null;
  subaccountEvidence: "kalshi_subaccount_balance_inventory" | null;
  provisioningKeyMetadataVerified: boolean | null;
  provisioningApiTier: string | null;
  provisioningSubaccountCreationEligible: boolean | null;
  subaccountCreationAuthorityPresent: boolean;
  subaccountCreationAuthorityVerified: boolean;
  subaccountCreationExecutionRoleAvailable: boolean;
  restrictedKeyMetadataVerified: boolean | null;
  restrictedKeyReadVerified: boolean;
  executionAccountExists: boolean;
  setupReason: string;
  nextRequirement: AccountSetupNextRequirement | null;
  operationPreparationAvailable: boolean;
  /** Null until an owner-scoped database read proves draft presence or absence. */
  policyDraftExists: boolean | null;
  /** Owner-scoped saved draft; strictly read-only, approval still needs confirmation. */
  policyDraft: {
    policyId: string;
    version: number;
    capitalLimitCents: number;
    maxEntryStakeCents: number;
    maxEntryAllInCents: number;
    maxDailyLossCents: number;
    maxTotalLossCents: number;
    maxQuoteAgeMs: number;
    maxFeeEvidenceAgeMs: number;
  } | null;
  operationPreparations: PublicAccountSetupAttempt[];
  nextAuthorizedAction: AccountSetupNextAuthorizedAction | null;
}

export interface ShardAllocationView {
  ok:boolean; reason:string;
  state:"unavailable"|"prepared"|"attempted"|"uncertain"|"completed";
  attemptId:string|null; amountCents:2500; sourceCents:number|null;
  destinationCents:number|null; botCents:number|null; exchangeTransferId:string|null;
  transferAttempted:boolean;
}
export interface PilotTransferView {
  ok: boolean;
  reason: string;
  state: "unavailable" | "prepared" | "attempted" | "uncertain" | "completed";
  attemptId: string | null;
  amountCents: 2500;
  primaryCents: number | null;
  botCents: number | null;
  transferAttempted: boolean;
}

export interface HistoricalFundingView {
  ok:boolean; reason:string; historicalVerified:boolean;
  historicalVerifiedAt:string|null; botCents:number|null; transferAttempted:false;
}
export interface UserScopePort {
  ownerShardAllocationStatus(userId:string):Promise<ShardAllocationView>;
  prepareOwnerShardAllocation(userId:string):Promise<ShardAllocationView>;
  executeOwnerShardAllocation(userId:string,body:unknown):Promise<ShardAllocationView>;
  reconcileOwnerShardAllocation(userId:string):Promise<ShardAllocationView>;
  ownerPilotTransferStatus(userId:string):Promise<PilotTransferView>;
  reconcileOwnerPilotTransfer(userId:string):Promise<PilotTransferView>;
  historicalFundingStatus(userId:string):Promise<HistoricalFundingView>;
  verifyHistoricalFunding(userId:string):Promise<HistoricalFundingView>;
  prepareOwnerPilotTransfer(userId:string):Promise<PilotTransferView>;
  executeOwnerPilotTransfer(userId:string, body:unknown):Promise<PilotTransferView>;
  migrationReady(): Promise<boolean>;
  settings(userId: string): Promise<UserExecutionView>;
  wallet(userId: string): Promise<KalshiUserRead>;
  botTopupReadiness(userId: string): Promise<OwnerFundingMaintenanceReadiness>;
  ownerTopupStatus(userId:string):Promise<TopupStatus>;
  prepareOwnerTopup(userId:string,amountCents:number):Promise<TopupStatus>;
  executeOwnerTopup(userId:string,body:unknown):Promise<TopupStatus>;
  reconcileOwnerTopup(userId:string):Promise<TopupStatus>;
  cancelOwnerTopup(userId:string,confirmation:unknown):Promise<TopupStatus>;
  control(userId: string, action: ControlAction): Promise<{ ok: boolean; reason?: string; view: UserExecutionView; exchangeFlatVerified?: false; protectiveExitState?: "MANUAL_EXCHANGE_RECONCILIATION_REQUIRED" | "MANAGING_EXISTING_EXPOSURE" | "EXCHANGE_RECONCILIATION_REQUIRED" }>;
  safetyControl(userId: string, action: "STOP" | "DISARM" | "KILL"): Promise<{
    ok: boolean;
    reason?: string;
    executable: false;
    workerStarted: false;
    executionActive: false;
    view: UserExecutionView;
  }>;
  credentialStatus(userId: string): Promise<{ ok: boolean; reason: string; executable: false; roles: unknown[] }>;
  prepareRestrictedKeyRecovery(userId:string):Promise<{ok:boolean;reason:string;executable:false}>;
  executeRestrictedKeyRecovery(userId:string,body:unknown):Promise<{ok:boolean;reason:string;executable:false}>;
  registerCredential(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false }>;
  revokeCredential(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false }>;
  verifyCredential(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false }>;
  authorizeFunding(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false; transferAttempted: false }>;
  recordFundingEvidence(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; executable: false; transferAttempted: false }>;
  authorizeOperation(userId: string, body: unknown): Promise<{
    ok: boolean;
    reason: string;
    attempted: false;
    executable?: false;
    idempotent?: boolean;
    attempt?: PublicAccountSetupAttempt | null;
  }>;
  executeOperation(userId: string, body: unknown): Promise<{
    ok: boolean;
    reason: string;
    attempted: boolean;
    executable: false;
  }>;
  commissioningStatus(userId: string): Promise<UserCommissioningStatus>;
  stake(userId: string, cents: number, revision: number | null, policyConfirmation?: string, presetSelection?: {presetId:string;presetRevision:number;capitalBudgetCents:number}): Promise<{ ok: boolean; reason?: string; view: UserExecutionView }>;
  presets(userId: string): Promise<SharedPreset[]>;
  previewPreset(userId: string, body: unknown): Promise<{ ok: boolean; reason?: string; presetId?: string; presetRevision?: number; referenceCapitalCents?: number; limits?: {
    capitalLimitCents: number; maxEntryStakeCents: number; maxEntryAllInCents: number; maxDailyLossCents: number; maxTotalLossCents: number; maxQuoteAgeMs: number; maxFeeEvidenceAgeMs: number;
  }; minimumExitMicros?: number | null; approved?: false; liveEnabled?: false }>;
  savePreset(userId: string, body: unknown): Promise<{ ok: boolean; reason?: string; preset?: SharedPreset }>;
  updatePreset(userId: string, presetId: string, body: unknown): Promise<{ ok: boolean; reason?: string; preset?: SharedPreset }>;
  deletePreset(userId: string, presetId: string): Promise<{ ok: boolean; reason?: string }>;
  applyPreset(userId: string, presetId: string): Promise<{ ok: boolean; reason?: string; draft?: PolicyDraft; view: UserExecutionView }>;
  qualify(userId: string, body: unknown): Promise<QualificationResult>;
  diagnose(userId: string): Promise<QualificationDiagnostic>;
  personalReadiness(userId: string): Promise<{
    ok: true;
    accountId: string | null;
    blockers: string[];
    readyForCommissioning: boolean;
    readyForLive: boolean;
    activationRequested: boolean;
  }>;
  approvePolicy(userId: string, body: unknown): Promise<{ ok: boolean; reason: string }>;
  approvedPolicyFeeEvidence(userId: string): Promise<{
    ok: boolean; reason: string; feeArtifactDigest?: string; policyId?: string; version?: number;
  }>;
  draftPolicy(userId: string, body: unknown): Promise<{ ok: boolean; reason?: string; policyId?: string; version?: number }>;
  reconcileCash(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; transferAttempted: false }>;
  commissionAccount(userId: string, body: unknown): Promise<{ ok: boolean; reason: string; blockers: string[] }>;
  requestActivation(userId: string, body: unknown): Promise<{
    ok: boolean;
    reason: string;
    executionEnabled: false;
    killSwitchCleared: false;
    liveEnabled: false;
  }>;
  enableOwnedExecution(body: unknown): Promise<{
    ok: boolean;
    reason: string;
    globalFlagsChanged: false;
    killSwitchCleared: boolean;
    accountsTouched: number;
  }>;
  enableSharedLive(body: unknown): Promise<{ ok: boolean; reason: string; accountsTouched: 0 }>;
}

/** Fail closed. Does not read the legacy account and does not mutate Kalshi or the database. */
export function closedUserScopePort(): UserScopePort {
  const refused = async (userId: string) => ({ ok: false, reason: "user_scope_not_migrated", view: emptyUserExecutionView(userId) });
  return {
    migrationReady: async () => false,
    settings: async (userId) => emptyUserExecutionView(userId),
    wallet: async () => emptyKalshiUserRead(),
    botTopupReadiness: async () => ({ok:false,reason:"user_scope_not_migrated",
      accountScopedMaintenanceEligible:false,executable:false as const,
      transferAttempted:false as const,variableTransferImplemented:false as const,
      requiresSignedKalshiCashRead:true as const,
      requiresAuthenticatedExchangeReconciliation:true as const,
      requiresOwnerTransferConsent:true as const,recordedBotCashCents:null,reconciledAt:null}),
    ownerTopupStatus: async()=>({ok:false,reason:"topup_not_configured",planId:null,attemptId:null,state:"unavailable",kind:null,amountCents:null,transferAttempted:false}),
    prepareOwnerTopup: async()=>({ok:false,reason:"topup_not_configured",planId:null,attemptId:null,state:"unavailable",kind:null,amountCents:null,transferAttempted:false}),
    executeOwnerTopup: async()=>({ok:false,reason:"topup_not_configured",planId:null,attemptId:null,state:"unavailable",kind:null,amountCents:null,transferAttempted:false}),
    reconcileOwnerTopup: async()=>({ok:false,reason:"topup_not_configured",planId:null,attemptId:null,state:"unavailable",kind:null,amountCents:null,transferAttempted:false}),
    cancelOwnerTopup: async()=>({ok:false,reason:"topup_not_configured",planId:null,attemptId:null,state:"unavailable",kind:null,amountCents:null,transferAttempted:false}),
    control: async (userId) => refused(userId),
    safetyControl: async (userId) => ({ ...await refused(userId), executable: false, workerStarted: false, executionActive: false }),
    credentialStatus: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false, roles: [] }),
    prepareRestrictedKeyRecovery: async()=>({ok:false,reason:"user_scope_not_migrated",executable:false as const}),
    executeRestrictedKeyRecovery: async()=>({ok:false,reason:"user_scope_not_migrated",executable:false as const}),
    registerCredential: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false }),
    revokeCredential: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false }),
    verifyCredential: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false }),
    ownerShardAllocationStatus: async () => ({ ok:false, reason:"user_scope_not_migrated", state:"unavailable" as const, attemptId:null, amountCents:2500 as const, sourceCents:null, destinationCents:null, botCents:null, exchangeTransferId:null, transferAttempted:false }),
    prepareOwnerShardAllocation: async () => ({ ok:false, reason:"user_scope_not_migrated", state:"unavailable" as const, attemptId:null, amountCents:2500 as const, sourceCents:null, destinationCents:null, botCents:null, exchangeTransferId:null, transferAttempted:false }),
    executeOwnerShardAllocation: async () => ({ ok:false, reason:"user_scope_not_migrated", state:"unavailable" as const, attemptId:null, amountCents:2500 as const, sourceCents:null, destinationCents:null, botCents:null, exchangeTransferId:null, transferAttempted:false }),
    reconcileOwnerShardAllocation: async () => ({ ok:false, reason:"user_scope_not_migrated", state:"unavailable" as const, attemptId:null, amountCents:2500 as const, sourceCents:null, destinationCents:null, botCents:null, exchangeTransferId:null, transferAttempted:false }),
    ownerPilotTransferStatus: async () => ({ ok:false, reason:"user_scope_not_migrated", state:"unavailable" as const, attemptId:null, amountCents:2500 as const, primaryCents:null, botCents:null, transferAttempted:false }),
    reconcileOwnerPilotTransfer: async () => ({ ok:false, reason:"user_scope_not_migrated", state:"unavailable" as const, attemptId:null, amountCents:2500 as const, primaryCents:null, botCents:null, transferAttempted:false }),
    historicalFundingStatus: async () => ({ok:false,reason:"user_scope_not_migrated",historicalVerified:false,historicalVerifiedAt:null,botCents:null,transferAttempted:false}),
    verifyHistoricalFunding: async () => ({ok:false,reason:"user_scope_not_migrated",historicalVerified:false,historicalVerifiedAt:null,botCents:null,transferAttempted:false}),
    prepareOwnerPilotTransfer: async () => ({ ok:false, reason:"user_scope_not_migrated", state:"unavailable" as const, attemptId:null, amountCents:2500 as const, primaryCents:null, botCents:null, transferAttempted:false }),
    executeOwnerPilotTransfer: async () => ({ ok:false, reason:"user_scope_not_migrated", state:"unavailable" as const, attemptId:null, amountCents:2500 as const, primaryCents:null, botCents:null, transferAttempted:false }),
    authorizeFunding: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false, transferAttempted: false }),
    recordFundingEvidence: async () => ({ ok: false, reason: "user_scope_not_migrated", executable: false, transferAttempted: false }),
    authorizeOperation: async () => ({ ok: false, reason: "user_scope_not_migrated", attempted: false, executable: false }),
    executeOperation: async () => ({ ok: false, reason: "user_scope_not_migrated", attempted: false, executable: false }),
    commissioningStatus: async () => ({
      ready: false,
      executable: false,
      blockers: ["user_scope_not_migrated"],
      subaccount1Exists: null,
      subaccount1Exchange2Exists: null,
      subaccount1SafeToCreate: null,
      subaccountEvidence: null,
      provisioningKeyMetadataVerified: null,
      provisioningApiTier: null,
      provisioningSubaccountCreationEligible: null,
      subaccountCreationAuthorityPresent: false,
      subaccountCreationAuthorityVerified: false,
      subaccountCreationExecutionRoleAvailable: false,
      restrictedKeyMetadataVerified: null,
      restrictedKeyReadVerified: false,
      executionAccountExists: false,
      setupReason: "user_scope_not_migrated",
      nextRequirement: null,
      operationPreparationAvailable: false,
      policyDraftExists: null,
      policyDraft: null,
      operationPreparations: [],
      nextAuthorizedAction: {
        action: "resolve_account_setup_blocker",
        operation: null,
        endpoint: null,
        requiredConfirmation: null,
        effect: "user_scope_not_migrated",
        attemptId: null,
      },
    }),
    stake: async (userId) => refused(userId),
    presets: async () => [],
    previewPreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    savePreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    updatePreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    deletePreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    applyPreset: async (userId) => refused(userId),
    qualify: async () => ({ status: "USER_SCOPE_CLOSED" }),
    diagnose: async () => ({ ...await readQualificationDiagnostics({ guard: null }), status: "USER_SCOPE_CLOSED" }),
    personalReadiness: async () => ({
      ok: true as const, accountId: null, blockers: ["user_scope_not_migrated"],
      readyForCommissioning: false, readyForLive: false, activationRequested: false,
    }),
    approvePolicy: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    approvedPolicyFeeEvidence: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    draftPolicy: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    reconcileCash: async () => ({ ok: false, reason: "user_scope_not_migrated", transferAttempted: false as const }),
    commissionAccount: async () => ({ ok: false, reason: "user_scope_not_migrated", blockers: ["user_scope_not_migrated"] }),
    requestActivation: async () => ({
      ok: false, reason: "user_scope_not_migrated",
      executionEnabled: false as const, killSwitchCleared: false as const, liveEnabled: false as const,
    }),
    enableOwnedExecution: async () => ({
      ok: false, reason: "user_scope_not_migrated",
      globalFlagsChanged: false as const, killSwitchCleared: false, accountsTouched: 0,
    }),
    enableSharedLive: async () => ({ ok: false, reason: "user_scope_not_migrated", accountsTouched: 0 as const }),
  };
}

function subject(res: { locals: { strata?: { subject?: string } } }): string | null {
  const value = res.locals.strata?.subject;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ignoreForeignOwner(body: unknown): void {
  if (!body || typeof body !== "object") return;
  delete (body as Record<string, unknown>).owner_user_id;
  delete (body as Record<string, unknown>).target_user_id;
}

function qualificationRequest(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const copy = { ...(body as Record<string, unknown>) };
  for (const key of ["owner_user_id", "target_user_id", "api_key", "apiKey", "private_key", "privateKey", "pem"]) delete copy[key];
  return copy;
}

export function createUserExecutionRouter(requireUser: RequestHandler, port: UserScopePort): IRouter {
  const router: IRouter = Router();
  router.use(requireUser);
  const migrated = async (res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    try {
      if (await port.migrationReady()) return true;
    } catch {
      // A missing schema is a closed scope, not a process failure.
    }
    res.status(409).json({ error: "user_scope_not_migrated" });
    return false;
  };
  router.get("/bot-settings", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    if (!await migrated(res)) return;
    res.json(sanitizePublic(await port.settings(userId)));
  });
  router.get("/wallet", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.json(sanitizePublic(await port.wallet(userId)));
  });
  router.post("/control", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const action = req.body?.action;
    if (action !== "ARM" && action !== "DISARM" && action !== "START" && action !== "STOP" && action !== "KILL") {
      return void res.status(400).json({ error: "control_action_invalid" });
    }
    if (action === "STOP" || action === "DISARM" || action === "KILL") {
      const result = await port.safetyControl(userId, action);
      return void res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
    }
    if (!await migrated(res)) return;
    const result = await port.control(userId, action);
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.get("/commissioning", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.json(sanitizePublic(await port.commissioningStatus(userId)));
  });
  router.get("/credentials", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.json(sanitizePublic(await port.credentialStatus(userId)));
  });
  router.post("/credentials", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.registerCredential(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  // Requires the signed-in owner and MFA already enforced by requireUser.
  // No user ID, private key, or external URL is accepted in the body.
  router.post("/credentials/recover-restricted/prepare", async (_req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    if(!await migrated(res))return;
    const result=await port.prepareRestrictedKeyRecovery(userId);
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.post("/credentials/recover-restricted/execute", async (req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    if(!await migrated(res))return;
    const body=req.body&&typeof req.body==="object"&&!Array.isArray(req.body)
      ? {attemptId:req.body.attemptId,confirmation:req.body.confirmation}:{};
    const result=await port.executeRestrictedKeyRecovery(userId,body);
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.post("/credentials/revoke", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.revokeCredential(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/credentials/verify", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.verifyCredential(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  // The primary index 0 -> index 2 allocation is independently funded and
  // reconciled. These routes never invoke bot trading or the bot-subaccount POST.
  router.get("/shard-allocation/status", async (_req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.status(200).json(sanitizePublic(await port.ownerShardAllocationStatus(userId)));
  });
  router.post("/shard-allocation/prepare", async (req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    const report=await port.prepareOwnerShardAllocation(userId);
    res.status(report.ok?200:409).json(sanitizePublic(report));
  });
  router.post("/shard-allocation/execute", async (req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    const report=await port.executeOwnerShardAllocation(userId,req.body??{});
    res.status(report.ok?200:409).json(sanitizePublic(report));
  });
  router.post("/shard-allocation/reconcile", async (req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    // This operation reads Kalshi and persists only verified receipt metadata.
    const report=await port.reconcileOwnerShardAllocation(userId);
    res.status(report.ok?200:409).json(sanitizePublic(report));
  });
  router.post("/bot-transfer/reconcile", async (req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    // This route NEVER calls a Kalshi transfer POST. Only signed history/balance GETs.
    const report=await port.reconcileOwnerPilotTransfer(userId);
    res.status(report.ok?200:409).json(sanitizePublic(report));
  });
  router.get("/historical-funding/status", async (_req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.status(200).json(sanitizePublic(await port.historicalFundingStatus(userId)));
  });
  router.post("/historical-funding/verify", async (req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    // Signed Kalshi GET and receipt evidence persistence ONLY; no fund transfer.
    const report=await port.verifyHistoricalFunding(userId);
    res.status(report.ok?200:409).json(sanitizePublic(report));
  });
  router.get("/bot-topup/status",async(_req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.status(200).json(sanitizePublic(await port.ownerTopupStatus(userId)));
  });
  router.post("/bot-topup/prepare",async(req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    const amount=req.body?.amountCents;
    if(!Number.isSafeInteger(amount))return void res.status(400).json({error:"topup_amount_invalid"});
    const result=await port.prepareOwnerTopup(userId,amount);
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.post("/bot-topup/execute",async(req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    const result=await port.executeOwnerTopup(userId,req.body??{});
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.post("/bot-topup/cancel",async(req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    const result=await port.cancelOwnerTopup(userId,req.body?.confirmation);
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.post("/bot-topup/reconcile",async(_req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    const result=await port.reconcileOwnerTopup(userId);
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.get("/bot-topup/readiness", async (_req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    // The legacy $25 commissioning POST endpoints remain unchanged.
    // This independently evaluates the owner's commissioned account only.
    // It proves ZERO money moved, and must never permit ARM/START.
    res.status(200).json(sanitizePublic(await port.botTopupReadiness(userId)));
  });
  router.get("/bot-transfer/status", async (_req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    // Status is a read-only receipt, not a mutation acknowledgement.
    // Uncertain, attempted, and missing records MUST remain inspectable after
    // a reload; a non-2xx response previously concealed their state in the UI.
    const report=await port.ownerPilotTransferStatus(userId);
    res.status(200).json(sanitizePublic(report));
  });
  router.post("/bot-transfer/prepare", async (req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    const report=await port.prepareOwnerPilotTransfer(userId);
    res.status(report.ok?200:409).json(sanitizePublic(report));
  });
  router.post("/bot-transfer/execute", async (req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    const report=await port.executeOwnerPilotTransfer(userId,req.body??{});
    res.status(report.ok?200:409).json(sanitizePublic(report));
  });
  router.post("/funding-authorization", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.authorizeFunding(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/funding-evidence", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.recordFundingEvidence(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/account-operations", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.authorizeOperation(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/account-operations/execute", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.executeOperation(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/stake", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    if (!await migrated(res)) return;
    const cents = req.body?.configuredStakeCents;
    const revision = req.body?.revision ?? null;
    if (typeof cents !== "number") return void res.status(400).json({ error: "stake_cents_not_integer" });
    const consent = typeof req.body?.policyConfirmation === "string" ? req.body.policyConfirmation : undefined;
    const selectionRaw = req.body?.presetSelection;
    const presetSelection = selectionRaw &&
      typeof selectionRaw.presetId === "string" &&
      Number.isSafeInteger(selectionRaw.presetRevision) &&
      Number.isSafeInteger(selectionRaw.capitalBudgetCents)
      ? {presetId:selectionRaw.presetId,presetRevision:selectionRaw.presetRevision,
         capitalBudgetCents:selectionRaw.capitalBudgetCents} : undefined;
    if (selectionRaw !== undefined && !presetSelection)
      return void res.status(400).json({error:"risk_preset_selection_invalid"});
    const result = await port.stake(userId, cents,
      typeof revision === "number" ? revision : null, consent, presetSelection);
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.get("/presets", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    if (!await migrated(res)) return;
    res.json(sanitizePublic({ presets: await port.presets(userId) }));
  });
  router.post("/presets/preview", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    if (!await migrated(res)) return;
    const result = await port.previewPreset(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/presets", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    if (!await migrated(res)) return;
    const result = await port.savePreset(userId, req.body ?? {});
    res.status(result.ok ? 200 : 400).json(sanitizePublic(result));
  });
  router.post("/presets/:id", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    if (!await migrated(res)) return;
    const result = await port.updatePreset(userId, String(req.params.id), req.body ?? {});
    res.status(result.ok ? 200 : 403).json(sanitizePublic(result));
  });
  router.delete("/presets/:id", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    if (!await migrated(res)) return;
    const result = await port.deletePreset(userId, String(req.params.id));
    res.status(result.ok ? 200 : 403).json(sanitizePublic(result));
  });
  router.post("/presets/:id/apply", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    if (!await migrated(res)) return;
    const result = await port.applyPreset(userId, String(req.params.id));
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/qualify-advanced-api", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    const body = qualificationRequest(req.body);
    if (body.confirm !== QUALIFICATION_CONFIRMATION && body.confirm !== RESIDUAL_RISK_CONFIRMATION) {
      return void res.status(400).json({ status: "CONFIRMATION_REQUIRED" });
    }
    const result = await port.qualify(userId, body);
    const ok = result.status === "ADVANCED_VERIFIED" || result.status === "ALREADY_ADVANCED";
    res.status(ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.get("/qualification-diagnostics", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    for (const key of ["user_id", "owner_user_id", "target_user_id", "provider_connection_id", "order_id", "client_order_id", "ticker", "api_key", "apiKey", "private_key", "privateKey", "pem"]) {
      delete req.query[key];
    }
    const result = await port.diagnose(userId);
    res.status(result.status === "QUALIFICATION_DIAGNOSTIC_READY" ? 200 : 409).json(sanitizePublic(result));
  });
  router.get("/personal-readiness", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.json(sanitizePublic(await port.personalReadiness(userId)));
  });
  router.post("/policy/draft", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.draftPolicy(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  // Step 6: authenticated, strictly READ-ONLY validation of the currently
  // published Kalshi fee schedule. No approved policy, fee write, or trading
  // authorization is necessary. Step 9 and 11 MUST independently verify it
  // again; this endpoint is informational, not a source of approval authority.
  // Standalone read-only market metadata diagnostic. This explicitly cannot
  // approve the separate PDF provenance, policy, commissioning, or live orders.
  // The account owner must authenticate; no caller-supplied ticker or URL.
  router.get("/fees/market-preflight", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "private, no-store");
    const evidence = await probeCurrentKalshiFeeApi();
    res.status(evidence.ok ? 200 : 409).json(sanitizePublic(evidence));
  });
  // One authenticated LIVE first-party HTML fetch, strictly evidence-only.
  // No caller-supplied URL, fee override, source signature or other account.
  router.get("/fees/official-tariff-html",async (_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const evidence=await observeOfficialTariffHtml();
    res.status(evidence.ok?200:409).json(sanitizePublic(evidence));
  });
  // Read-only Step 9 preparation: canonical official API observation with a
  // versioned, NON-AUTHORIZING review-candidate digest. No PDF fetch, account
  // policy update, admin signature, owner consent, transfer or order occurs.
  router.get("/fees/api-policy-review-candidate", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "private, no-store");
    const market = await probeCurrentKalshiFeeApi();
    const candidate = preparePdfFreeApiFeePolicyReview(market);
    res.status(candidate.ok ? 200 : 409).json(sanitizePublic(candidate));
  });
  // Diagnostic only: human-attested candidate is not authenticated official PDF
  // evidence. The result never authorizes Step 9, Step 11 or live orders.
  router.get("/fees/operator-candidate", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "private, no-store");
    const result = await inspectOperatorFeeCandidate();
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  // Separate versioned API-source human actions, authenticated by the user
  // session. These only write audit records; NEVER approve Step 9/11 or orders.
  // Admin-only, read-only runtime database identity. No credentials or live powers.
  router.get("/fees/runtime-db-attestation", async (_req,res)=>{
    const actor=subject(res);
    if(!actor)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await inspectRuntimeDbIdentity(actor);
    res.status(result.ok?200:403).json(sanitizePublic(result));
  });
  // AAL2 owner-authenticated Wallets-only V4 evidence/consent lifecycle.
  // requireUser validates JWT AAL2; never accept browser-supplied owner IDs.
  // Even when grants are recorded, signed POST V4 remains disabled.
  router.post("/fees/wallets/v4/evidence",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    res.setHeader("Cache-Control","private, no-store");
    const out=await recordWalletV4FeeEvidence(owner,req.body);
    res.status(out.ok?201:409).json(sanitizePublic(out));
  });
  router.post("/fees/wallets/v4/consent",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    res.setHeader("Cache-Control","private, no-store");
    const out=await authorizeWalletV4FeeModel(owner,req.body);
    res.status(out.ok?201:409).json(sanitizePublic(out));
  });
  router.post("/fees/wallets/v4/revoke",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    res.setHeader("Cache-Control","private, no-store");
    const out=await revokeWalletV4FeeConsent(owner,req.body);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  // Early personal account onboarding is not Steps 12-13 or trading
  // authorization. No exchange calls, credentials, fee PDF or mutations.
  router.get("/onboarding/my-setup-readiness",async (_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const out=await inspectOwnerAccountOnboardingReadiness(owner);
    res.status(out.ok?200:409).json(publicOwnerAccountOnboardingReadiness(out));
  });
  // Explicit owner-initiated SIGNED Kalshi READ verification, not a stale
  // dashboard record, monetary grant or execution permission. No request body,
  // owner selector, fee PDF, order, transfer, cash update or approval writes.
  router.post("/release/my-signed-exchange-proof",async (_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const out=await inspectOwnerSignedExchangeReleaseProof(owner);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  // Isolated Kalshi PDF upstream capture/lease status only. NO issuer HTTP
  // request, NO fee grant, NO cash/exit authorization or trade is attempted.
  router.get("/fees/issuer-source-status",async(_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const status=await inspectIsolatedIssuerFeeSourceStatus();
    res.status(status.ok?200:409).json(sanitizePublic(status));
  });

  // Owner-only AAL2 trusted alternate egress. The server performs ONE real
  // fixed-URL issuer GET under the SAME shared 30-minute project cooldown.
  // No browser-supplied PDF, account identifier, fee formula or grant exists.
  router.post("/fees/issuer-independent-capture",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    if(req.body&&typeof req.body==="object"&&Object.keys(req.body).length!==0)
      return void res.status(400).json({error:"issuer_capture_accepts_no_client_data"});
    res.setHeader("Cache-Control","private, no-store");
    const out=await captureIndependentOfficialFeeV5(owner);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  // Observation only, never contacts the issuer or creates permission.
  router.get("/fees/issuer-independent-status",async(_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const out=await readIndependentOfficialFeeV5();
    const status=out.ok?{ok:true,digest:out.digest,capturedAt:out.originalCapturedAt,
      effectiveDate:out.effectiveDate,sourceKind:"railway_canonical_https_direct",
      tradingAuthorized:false,ordersSubmitted:false}:out;
    res.status(out.ok?200:409).json(sanitizePublic(status));
  });
  // #165: compare all five owner release-evidence gates independently. This
  // read-only report NEVER fetches the official PDF, signs Kalshi requests,
  // grants permissions, clears a kill or authorizes an order.
  router.get("/release/five-gate-audit",async (_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const out=await inspectOwnerFiveGateReleaseAudit(owner);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  // Wallets-only Step 12 V4 diagnostics. JWT owner-scoped, no body account selector.
  // Returns explicit blocked readiness; does not authorize or submit orders.
  router.get("/fees/wallets/v4/readiness",async (_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const out=await inspectWalletV4Readiness(owner);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  // #165 phase 1: verified owner-only official fee evidence candidate, strictly
  // read-only. This endpoint never grants V3 authority or approves live entries.
  router.get("/fees/single-owner/evidence-preview", async (_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const out=await inspectSingleOwnerFeePreflight(owner);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  // Dynamic official monetary fee discovery is a feature-flagged owner-only
  // READ, not a V3 grant or an approved payable fee schedule. Off by default:
  // no extra provider PDF/API pressure while exchange traffic is rate limited.
  router.get("/fees/single-owner/dynamic-schedule-preview",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    if(process.env.STRATA_DYNAMIC_FEE_PREVIEW_ENABLED!=="true")
      return void res.status(503).json({ok:false,
        reason:"dynamic_fee_observation_disabled",tradingAuthorized:false});
    const ticker=typeof req.query.marketTicker==="string"?req.query.marketTicker:"";
    const digest=typeof req.query.reviewedDigest==="string"?req.query.reviewedDigest:null;
    const out=await observeDynamicKalshiFees(ticker,digest);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  // #165 V3: owner self-consent to an official server-verified fee RECEIPT.
  // No review impersonation, migration, trading or approval is performed.
  router.post("/fees/single-owner/evidence-consent", async (req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    res.setHeader("Cache-Control","private, no-store");
    const out=await recordOwnerV3FeeEvidence(owner,req.body??{});
    res.status(out.ok?201:409).json(sanitizePublic(out));
  });
  // V3 monetary fee source authorization; requires authenticated owner AAL2.
  // Explicit feature-flag plus immutable server-verified fee consent needed.
  // Does not migrate policy, enable entries, or bypass legacy V2 review.
  router.post("/fees/single-owner/authority/issue",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    res.setHeader("Cache-Control","private, no-store");
    const out=await issueOwnerV3FeeAuthority(owner,req.body??{});
    res.status(out.ok?201:409).json(sanitizePublic(out));
  });
  router.post("/fees/single-owner/authority/revoke",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    res.setHeader("Cache-Control","private, no-store");
    const out=await revokeOwnerV3FeeAuthority(owner,req.body??{});
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  router.get("/fees/single-owner/authority/check",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    const source=typeof req.query.sourceUrl==="string"?req.query.sourceUrl:"";
    res.setHeader("Cache-Control","private, no-store");
    const out=await verifyOwnerV3FeeAuthority(owner,"STEP_9",source);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  router.get("/fees/api-source-readiness", async (req,res)=>{
    const viewer=subject(res);
    if(!viewer)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const selected=typeof req.query.ownerUserId==="string"?req.query.ownerUserId:undefined;
    const result=await inspectApiFeeSourceReadiness(viewer,selected);
    res.status(result.ok?200:403).json(sanitizePublic(result));
  });
  // Versioned, independently reviewed standing monetary model, NOT quote/order approval.
  router.get("/fees/standing/readiness",async(_req,res)=>{
   const owner=subject(res);
   if(!owner)return void res.status(401).json({error:"Unauthorized"});
   res.setHeader("Cache-Control","private, no-store");
   const out=await inspectStandingFeeReadiness(owner);
   res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  router.post("/fees/standing-model/review",async(req,res)=>{
   const actor=subject(res);
   if(!actor)return void res.status(401).json({error:"Unauthorized"});
   res.setHeader("Cache-Control","private, no-store");
   const out=await signStandingFeeModel(actor,req.body??{});
   res.status(out.ok?201:409).json(sanitizePublic(out));
  });
  router.post("/fees/standing-model/revoke",async(req,res)=>{
   const actor=subject(res);
   if(!actor)return void res.status(401).json({error:"Unauthorized"});
   res.setHeader("Cache-Control","private, no-store");
   const out=await revokeStandingFeeModel(actor,req.body??{});
   res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  // Owner AAL2 identity comes from the authenticated JWT; selecting another
  // owner's grant or risking policy cannot create an active delegation.
  router.post("/fees/standing-delegation/consent",async(req,res)=>{
   const owner=subject(res);
   if(!owner)return void res.status(401).json({error:"Unauthorized"});
   ignoreForeignOwner(req.body);
   res.setHeader("Cache-Control","private, no-store");
   const out=await consentStandingFeeDelegation(owner,req.body??{});
   res.status(out.ok?201:409).json(sanitizePublic(out));
  });
  router.post("/fees/standing-delegation/revoke",async(req,res)=>{
   const owner=subject(res);
   if(!owner)return void res.status(401).json({error:"Unauthorized"});
   res.setHeader("Cache-Control","private, no-store");
   const out=await revokeStandingFeeDelegation(owner,req.body??{});
   res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  router.post("/fees/api-rate-review", async (req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await recordApiFeeRateReview(userId,req.body??{});
    res.status(result.ok?201:409).json(sanitizePublic(result));
  });
  router.post("/fees/api-source-grants", async (req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await issueApiFeeSourceGrant(userId,req.body??{});
    res.status(result.ok?201:409).json(sanitizePublic(result));
  });
  router.post("/fees/api-owner-consent", async (req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await recordApiFeeOwnerConsent(userId,req.body??{});
    res.status(result.ok?201:409).json(sanitizePublic(result));
  });
  router.post("/fees/api-owner-consent/revoke", async(req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await revokeApiFeeOwnerConsent(userId,req.body??{});
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.post("/fees/api-source-grants/revoke", async(req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await revokeApiFeeSourceGrant(userId,req.body??{});
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.get("/fees/reviewed-evidence", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "private, no-store");
    const result = await inspectCommissioningFeeEvidence();
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  // Authenticated, owner-scoped grant + consent diagnostic. Even a positive
  // readiness response NEVER approves Step 6/9/11 or an order.
  router.get("/fees/authorization-readiness", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "private, no-store");
    const status = await inspectOwnerFeeSourceReadiness(userId);
    res.status(200).json(sanitizePublic(status));
  });
  // Explicit owner action: records source consent only. Never approves policy,
  // commissions an account or changes the execution kill-switch.
  router.post("/fees/owner-consent", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "private, no-store");
    const result = await recordOwnerFeeSourceConsent(userId, req.body ?? {});
    res.status(result.ok ? 201 : 409).json(sanitizePublic(result));
  });

  // Human-signed policy authority requires current admin roles and separate
  // distinct review records; none of these endpoints arm or submit orders.
  router.post("/fees/owner-consent/revoke", async (req, res) => {
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await revokeOwnerFeeSourceConsent(userId,req.body ?? {});
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.get("/fees/source-policy-document", (_req, res) => {
    const userId=subject(res);
    if (!userId) return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    res.json(sanitizePublic(feeSourcePolicyDocument()));
  });
  router.get("/fees/source-policy-owners", async (_req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await listEligibleFeeSourceOwners(userId);
    res.status(result.ok?200:403).json(sanitizePublic(result));
  });
  router.post("/fees/source-policy-status", async (req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    const ownerId=typeof req.body?.ownerUserId==="string"?req.body.ownerUserId:"";
    res.setHeader("Cache-Control","private, no-store");
    const result=await inspectFeePolicySigningStatus(userId,ownerId);
    res.status(200).json(sanitizePublic(result));
  });
  router.post("/fees/source-policy-review", async (req, res) => {
    const userId=subject(res);
    if (!userId) return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await signIndependentFeePolicyReview(userId, req.body ?? {});
    res.status(result.ok?201:409).json(sanitizePublic(result));
  });
  router.post("/fees/source-grants", async (req, res) => {
    const userId=subject(res);
    if (!userId) return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await issueReviewedOwnerFeeSourceGrant(userId, req.body ?? {});
    res.status(result.ok?201:409).json(sanitizePublic(result));
  });
  router.post("/fees/source-grants/revoke", async (req, res) => {
    const userId=subject(res);
    if (!userId) return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await revokeReviewedFeeSourceGrant(userId, req.body ?? {});
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.get("/fees/authorized-preflight", async (_req,res)=>{
    const userId=subject(res);
    if(!userId)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const proof=await verifyOwnerFeeSourceStage(userId,"STEP_6");
    if(!proof.ok)return void res.status(200).json(sanitizePublic({
      ok:false,reason:proof.reason,
      providerPdfVerified:false,policyApproved:false,commissioningPerformed:false,
      tradingAuthorized:false,
    }));
    res.status(200).json(sanitizePublic({
      ok:true,reason:"operator_attested_source_verified_read_only",
      feeArtifactDigest:proof.identity.digest,
      checkedAt:new Date(proof.identity.verifiedAtMs).toISOString(),
      sourceUrl:proof.identity.sourceUrl,
      provenanceType:"operator_attested_not_provider",
      feePolicyVersion:proof.identity.policyVersion,
      providerPdfVerified:false,policyApproved:false,commissioningPerformed:false,
      tradingAuthorized:false,
    }));
  });
  router.get("/fees/preflight", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    res.setHeader("Cache-Control", "private, no-store");

    // Step 6 is a READ-ONLY live fee diagnostic, not provider PDF provenance.
    // Never start by fetching a rate-limited PDF: this endpoint works from
    // the official Kalshi Trade API or from an already separately authorized
    // operator grant. Neither path creates policy/commissioning/order authority.
    const reviewed = await verifyOwnerFeeSourceStage(userId, "STEP_6");
    if (reviewed.ok) {
      return void res.status(200).json(sanitizePublic({
        ok: true, reason: "operator_attested_fee_source_verified_read_only",
        feeArtifactDigest: reviewed.identity.digest,
        checkedAt: new Date(reviewed.identity.verifiedAtMs).toISOString(),
        sourceUrl: reviewed.identity.sourceUrl,
        feePolicyVersion: reviewed.identity.policyVersion,
        provenanceType: "operator_attested_not_provider",
        providerPdfVerified: false,
        policyApproved: false, commissioningPerformed: false,
        tradingAuthorized: false,
      }));
    }

    // Probe the exact KXBTC15M market, Index 2, fee parameters, event
    // overrides, scheduled changes and freshness. A good API observation
    // is NOT a PDF digest and must not auto-advance Step 9/10/11.
    const market = await probeCurrentKalshiFeeApi();
    const observation = step6ApiFeeObservation(market);
    if (observation) {
      return void res.status(200).json(sanitizePublic(observation));
    }
    return void res.status(409).json(sanitizePublic({
      ok: false,
      reason: market.reason || "live_kalshi_fee_metadata_unavailable",
      alternateAuthorizationReason: reviewed.reason,
      provenanceType: "kalshi_api_fee_metadata_not_pdf",
      providerPdfVerified: false,
      policyApproved: false,
      commissioningPerformed: false,
      tradingAuthorized: false,
    }));
  });
  router.get("/policy/evidence", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    const result = await port.approvedPolicyFeeEvidence(userId);
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  // Genuine owner-only V4 path: no reviewed-API ADMIN fee grant needed, but
  // a *real* issuer PDF/API-backed V4 grant, signed exchange flatness and a
  // stopped owner lease are compulsory. Does not ARM or approve exits.
  router.get("/fees/wallets/v4/provisional-repair/preview",async(_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const out=await previewOwnerV4CommissioningRepair(owner);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  router.post("/fees/wallets/v4/provisional-repair/confirm",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    res.setHeader("Cache-Control","private, no-store");
    const out=await repairOwnerV4CommissioningHold(owner,req.body??{});
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  // AAL2 JWT subject only; no account id or owner id accepted from a client.
  router.get("/fees/api-policy-migration/preview",async(_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const result=await previewOwnedApiFeeMigration(owner);
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  router.post("/fees/api-policy-migration/confirm",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    res.setHeader("Cache-Control","private, no-store");
    const result=await migrateOwnedApiFeePolicy(owner,req.body??{});
    res.status(result.ok?200:409).json(sanitizePublic(result));
  });
  // Guarded V1->V3 policy migration. Existing V2 remains separate.
  // Owner AAL2, provider signed cash/order/fill reconciliation, atomic CAS
  // and confirmed historical freeze repair are REQUIRED inside backend.
  router.get("/fees/single-owner/migration/preview",async(_req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    res.setHeader("Cache-Control","private, no-store");
    const out=await previewOwnedV3FeeMigration(owner);
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  router.post("/fees/single-owner/migration/confirm",async(req,res)=>{
    const owner=subject(res);
    if(!owner)return void res.status(401).json({error:"Unauthorized"});
    ignoreForeignOwner(req.body);
    res.setHeader("Cache-Control","private, no-store");
    const out=await migrateOwnedV3FeePolicy(owner,req.body??{});
    res.status(out.ok?200:409).json(sanitizePublic(out));
  });
  router.post("/policy/approve", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.approvePolicy(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/cash/reconcile", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.reconcileCash(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/activation/request", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.requestActivation(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/commission", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    const result = await port.commissionAccount(userId, req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/legacy/claim", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    res.status(409).json({ executable: false, reason: "legacy_claim_not_executed", ownerAssigned: false });
  });
  return router;
}
