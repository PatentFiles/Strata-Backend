import { EmergencyStopMicroLiveBody } from "@workspace/api-zod";
import { Router, type IRouter } from "express";
import { V13_CHAMPION_PARAMETER_HASH, V13_CHAMPION_PARAMETER_SET } from "@workspace/v13-strategy";
import { REVIEWED_RELEASE } from "../lib/strata/reviewedRelease";
import { createStrataAccess, type StrataAccessDeps } from "../lib/strata/supabaseAuth";
import { createProductionRouter, type ProductionHttpDeps } from "./productionRouter";

export interface StrataHttpDeps extends ProductionHttpDeps, StrataAccessDeps {
  forwardTestStatus: () => Promise<unknown>;
  forwardTestHistory: () => Promise<unknown>;
  phase4State: () => Promise<unknown>;
  microLiveState: () => Promise<unknown>;
  emergencyStop: () => Promise<unknown>;
}

/** Supabase-authenticated launch routes. Legacy Clerk routes stay on their own router. */
export function createStrataRouter(deps: StrataHttpDeps): IRouter {
  const access = createStrataAccess(deps);
  const router: IRouter = Router();
  router.use(createProductionRouter(deps, access.requireDeveloper));
  router.get("/release", (_req, res) => {
    res.json({
      ...REVIEWED_RELEASE,
      championId: V13_CHAMPION_PARAMETER_SET.id,
      parameterHash: V13_CHAMPION_PARAMETER_HASH,
    });
  });
  router.get("/forward-test/status", access.requireUser, async (_req, res) => {
    try { res.json(await deps.forwardTestStatus()); }
    catch { res.status(503).json({ error: "Forward-test status is unavailable" }); }
  });
  router.get("/forward-test/history", access.requireUser, async (_req, res) => {
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
