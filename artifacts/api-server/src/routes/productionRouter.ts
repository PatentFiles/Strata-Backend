import { getAuth } from "@clerk/express";
import { Router, type IRouter, type RequestHandler } from "express";
import type { ControlView, ProductionSupervisor } from "../lib/v13-production/control";

export interface ProductionHttpDeps {
  control: Pick<ProductionSupervisor, "start" | "stop" | "view">;
  status: () => Promise<unknown>;
  positions: () => Promise<unknown>;
  orders: () => Promise<unknown>;
  fills: () => Promise<unknown>;
  trades: () => Promise<unknown>;
  latestTrade: () => Promise<unknown>;
  stake?: {
    read: () => Promise<unknown>;
    update: (body: unknown) => Promise<{ status: number; body: unknown }>;
  };
}

const requireProductionAdmin: RequestHandler = (req, res, next) => {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const adminUserId = process.env.PHASE4_ADMIN_USER_ID;
  if (!adminUserId || userId !== adminUserId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
};

function sendControl(res: { status: (code: number) => { json: (body: unknown) => void } }, view: ControlView) {
  const body = {
    runtimeStatus: view.runtimeStatus,
    workerRunning: view.workerRunning,
    blockedReason: view.blockedReason,
    lastProductionError: view.lastProductionError,
    refused: view.refused,
    reason: view.blockedReason,
  };
  res.status(view.refused ? 409 : 200).json(body);
}

export function createProductionRouter(
  deps: ProductionHttpDeps,
  authorize: RequestHandler = requireProductionAdmin,
): IRouter {
  const router: IRouter = Router();
  router.post("/production/start", authorize, async (_req, res) => {
    try {
      sendControl(res, await deps.control.start());
    } catch {
      res.status(503).json({ error: "Production start is unavailable", runtimeStatus: "ERROR", workerRunning: false });
    }
  });
  router.post("/production/stop", authorize, async (_req, res) => {
    try {
      sendControl(res, await deps.control.stop());
    } catch {
      res.status(503).json({ error: "Production stop is unavailable", runtimeStatus: "ERROR", workerRunning: false });
    }
  });
  router.get("/production/status", authorize, async (_req, res) => {
    try {
      res.json(await deps.status());
    } catch {
      res.status(503).json({ error: "Production status is unavailable" });
    }
  });
  router.get("/production/positions", authorize, async (_req, res) => {
    try { res.json(await deps.positions()); }
    catch { res.status(503).json({ error: "Production positions are unavailable" }); }
  });
  router.get("/production/orders", authorize, async (_req, res) => {
    try { res.json(await deps.orders()); }
    catch { res.status(503).json({ error: "Production orders are unavailable" }); }
  });
  router.get("/production/fills", authorize, async (_req, res) => {
    try { res.json(await deps.fills()); }
    catch { res.status(503).json({ error: "Production fills are unavailable" }); }
  });
  router.get("/production/trades", authorize, async (_req, res) => {
    try { res.json(await deps.trades()); }
    catch { res.status(503).json({ error: "Production trades are unavailable" }); }
  });
  router.get("/production/stake", authorize, async (_req, res) => {
    if (!deps.stake) {
      res.status(503).json({ error: "Configured stake is unavailable" });
      return;
    }
    try { res.json(await deps.stake.read()); }
    catch { res.status(503).json({ error: "Configured stake is unavailable" }); }
  });
  router.put("/production/stake", authorize, async (req, res) => {
    if (!deps.stake) {
      res.status(503).json({ error: "Configured stake is unavailable" });
      return;
    }
    try {
      const result = await deps.stake.update(req.body);
      res.status(result.status).json(result.body);
    } catch {
      res.status(503).json({ error: "Configured stake is unavailable" });
    }
  });
  router.get("/production/latest-trade", authorize, async (_req, res) => {
    try { res.json(await deps.latestTrade()); }
    catch { res.status(503).json({ error: "Latest production trade is unavailable" }); }
  });
  return router;
}
