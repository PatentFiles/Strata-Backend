import { EmergencyStopMicroLiveBody } from "@workspace/api-zod";
import { Router, type IRouter } from "express";
import { entryPolicyRuntimeState } from "../lib/strata/configuredStake";
import { deployedGitSha } from "../lib/strata/deployedGitSha";
import { REVIEWED_RELEASE } from "../lib/strata/reviewedRelease";
import { sanitizePublic } from "../lib/v13-production/sanitize";
import { createStrataAccess, type StrataAccessDeps } from "../lib/strata/supabaseAuth";
import { emptySnapshot } from "../lib/strata/commissioning";
import { createProductionRouter, type ProductionHttpDeps } from "./productionRouter";
import { createStrataCommissioningRouter, type CommissioningPort } from "./strataCommissioning";
import { closedUserScopePort, createUserExecutionRouter, type UserScopePort } from "./userExecutionRouter";
import { createManualProfitWithdrawalRouter } from "./manualProfitWithdrawals";
import { createProtectiveReleaseRouter } from "./protectiveReleaseRouter";
import { readForwardTestBrtiReference } from "./forwardTest";
import { readTriangulatedMarketStatus } from "../lib/strataResearchMarketObserver";

export interface StrataHttpDeps extends ProductionHttpDeps, StrataAccessDeps {
  forwardTestStatus: () => Promise<unknown>;
  forwardTestHistory: () => Promise<unknown>;
  /** Injected only for isolated read-only diagnostics tests. */
  brtiSettlementReference?: () => Promise<unknown>;
  /** Read-only observer diagnostic; injected by isolated router tests. */
  marketTriangulation?: () => Promise<unknown>;
  phase4State: () => Promise<unknown>;
  microLiveState: () => Promise<unknown>;
  emergencyStop: () => Promise<unknown>;
  commissioning?: CommissioningPort;
  userScope?: UserScopePort;
}

function blockedCommissioningPort(): CommissioningPort {
  const read = async () => emptySnapshot();
  return {
    read,
    readSubaccountStatus: async () => ({
      subaccount1Exists: false,
      subaccount1Exchange2Exists: false,
      matchingRows: 0,
      numberedSubaccounts: [],
      exchangeIndexesForSubaccount1: [],
      readyForCleanBoundary: false,
      reason: "subaccount_status_unavailable",
      apiTier: null,
      subaccountCreationTierEligible: false,
      nettingSubaccount1Exists: false,
      balanceInventorySubaccount1Exists: false,
    }),
    createSubaccount: async () => ({
      state: "blocked",
      reason: "subaccount_creation_unavailable",
      posts: 0,
      returnedSubaccount: null,
      workerStarted: false,
      environmentChanged: false,
      funded: false,
      commissioned: false,
    }),
    generateIndex2Key: async () => ({
      state: "blocked",
      reason: "index2_generation_unavailable",
      posts: 0,
      privateKeyPersisted: false,
      verified: false,
      workerStarted: false,
      environmentChanged: false,
    }),
    replaceIndex2Key: async () => ({
      state: "blocked",
      reason: "index2_replacement_unavailable",
      posts: 0,
      privateKeyPersisted: false,
      verified: false,
      workerStarted: false,
      environmentChanged: false,
    }),
    verifySigner: async () => ({ snapshot: emptySnapshot(), calls: [] }),
    verifyBoundary: read,
    reconcileFunding: async () => ({
      state: "blocked", reason: "funding_anchor_missing", transferAttempted: false,
    }),
    fund: async () => ({
      state: "blocked", reason: "reviewed_funding_not_invoked", transferAttempted: false, attempts: 0,
    }),
    verifyFee: async () => ({
      snapshot: await read(),
      feeVerification: {
        ok: false,
        reason: "official_fee_schedule_not_verified",
        digestStored: false,
        httpStatus: null,
        contentType: null,
        finalOrigin: null,
        finalPathname: null,
        retryAfterSeconds: null,
        networkAttempts: 0,
      },
    }),
    verifyFeeUpload: async () => ({
      feeVerification: {
        ok: false,
        reason: "uploaded_fee_pdf_invalid",
        digestStored: false,
        sourceMode: null,
        effectiveDate: null,
        formulaVersion: null,
      },
    }),
    verifyCash: read,
    captureBoundary: async () => ({
      snapshot: emptySnapshot(), calls: [], blocked: true, reason: "boundary_capture_unavailable",
    }),
    acknowledgePreBoundaryRoundTrip: async () => ({
      status: "BLOCKED",
      reason: "pre_boundary_acknowledgment_unavailable",
      acknowledged: false,
      eligible: false,
      inboundTransferId: null,
      outboundTransferId: null,
      amountCents: null,
      inboundCreatedAt: null,
      outboundCreatedAt: null,
      evidenceDigest: null,
      calls: [],
      funded: false,
      commissioned: false,
      armed: false,
      workerStarted: false,
      executionFlagsChanged: false,
    }),
    readPolicy: async () => ({ draft: null, approved: false }),
    proposePolicy: async () => ({ status: "BLOCKED", reason: "policy_proposal_unavailable" }),
    approvePolicy: async () => ({ status: "BLOCKED", reason: "policy_approval_unavailable" }),
    approveMinimumExit: async () => ({ status: "BLOCKED", reason: "minimum_exit_approval_unavailable" }),
    arm: async () => ({ status: "BLOCKED", reason: "arm_unavailable", workerStarted: false, environmentChanged: false }),
    disarm: async () => ({ status: "BLOCKED", reason: "disarm_unavailable", emergencyStop: false }),
    commission: async () => ({
      status: "BLOCKED",
      blockers: ["live_money_policy_missing"],
      executionEnabled: null,
      killSwitch: null,
      commissioned: null,
      workerStarted: false,
      environmentChanged: false,
      accountCount: 0,
    }),
  };
}

/** Supabase-authenticated launch routes. Legacy Clerk routes stay on their own router. */
export function createStrataRouter(deps: StrataHttpDeps): IRouter {
  const access = createStrataAccess(deps);
  const router: IRouter = Router();
  router.use(createProductionRouter(deps, access.requireDeveloper));
  const userScope = deps.userScope ?? closedUserScopePort();
  router.use("/me/profit-withdrawals", createManualProfitWithdrawalRouter(access.requireUser));
  router.use("/me", createUserExecutionRouter(access.requireUser, userScope));
  router.use("/production/protective-release", createProtectiveReleaseRouter(access.requireUser));
  router.post("/production/owned-execution/enable", access.requireDeveloper, async (req, res) => {
    const result = await userScope.enableOwnedExecution(req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.post("/production/shared-live/enable", access.requireDeveloper, async (req, res) => {
    const result = await userScope.enableSharedLive(req.body ?? {});
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.use("/commissioning", createStrataCommissioningRouter(
    access.requireDeveloper,
    deps.commissioning ?? blockedCommissioningPort(),
  ));
  router.get("/release", (_req, res) => {
    res.json(sanitizePublic({
      ...REVIEWED_RELEASE,
      ...entryPolicyRuntimeState(),
      deployedGitSha: deployedGitSha(),
    }));
  });
  router.get("/forward-test/status", access.requireUser, async (_req, res) => {
    try { res.json(await deps.forwardTestStatus()); }
    catch { res.status(503).json({ error: "Forward-test status is unavailable" }); }
  });
  // The published Wallets/Dashboard uses Supabase JWTs, not the legacy
  // Clerk /api/forward-test endpoint. Reuse its identical read-only payload.
  // Never expose a current BRTI tick as official settlement or live authority.
  router.get("/forward-test/settlement-reference", access.requireUser, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await (deps.brtiSettlementReference ?? readForwardTestBrtiReference)());
    } catch {
      res.status(503).json({ error: "BRTI reference is temporarily unavailable" });
    }
  });
  router.get("/forward-test/market-triangulation", access.requireUser, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try{res.json(await (deps.marketTriangulation ?? (async()=>readTriangulatedMarketStatus()))());}
    catch{res.status(503).json({error:"Market data research diagnostics unavailable"});}
  });
  router.get("/forward-test/history", access.requireUser, async (_req, res) => {
    res.setHeader("Cache-Control","no-store");
    try { res.json(await deps.forwardTestHistory()); }
    catch { res.status(503).json({ error: "Forward-test history is unavailable" }); }
  });
  router.get("/phase4/state", access.requireDeveloper, async (_req, res) => {
    try { res.json(await deps.phase4State()); }
    catch { res.status(503).json({ error: "Phase 4 state is unavailable" }); }
  });
  router.get("/micro-live/state", access.requireDeveloper, async (_req, res) => {
    try { res.json(await deps.microLiveState()); }
    catch { res.status(503).json({ error: "Micro-live state is unavailable" }); }
  });
  router.post("/micro-live/emergency-stop", access.requireDeveloper, async (req, res) => {
    const input = EmergencyStopMicroLiveBody.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Invalid emergency-stop request" });
      return;
    }
    try {
      res.json(await deps.emergencyStop());
    } catch {
      res.status(503).json({ error: "Unable to persist micro-live emergency stop" });
    }
  });
  return router;
}
