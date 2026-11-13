import { getAuth } from "@clerk/express";
import { Router, type IRouter, type RequestHandler } from "express";
import {
  getKalshiCredentialsState,
  readKalshiAccount,
  type KalshiAccountSnapshot,
} from "../lib/kalshiAccountClient";
import {
  GetPhase4AccountResponse,
  GetPhase4StateResponse,
  SetPhase4ShadowLimitsBody,
} from "@workspace/api-zod";
import {
  getPhase4State,
  scanShadowOnce,
  setShadowMode,
  setShadowLimits,
} from "../lib/shadowLive";

const router: IRouter = Router();

const requireDevelopment: RequestHandler = (_req, res, next) => {
  if (process.env.NODE_ENV !== "development") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
};

export const requirePhase4Admin: RequestHandler = (req, res, next) => {
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

router.get("/phase4/account", requirePhase4Admin, async (_req, res) => {
  if (getKalshiCredentialsState() === "NOT_CONFIGURED") {
    const response = GetPhase4AccountResponse.safeParse({
      status: "NOT_CONFIGURED",
      balance: null,
      openOrders: [],
      positions: [],
      fills: [],
      truncated: { openOrders: false, positions: false, fills: false },
    });
    if (!response.success) {
      res.status(503).json({ error: "Kalshi account response is invalid" });
      return;
    }
    res.json(response.data);
    return;
  }

  try {
    const account: KalshiAccountSnapshot = await readKalshiAccount();
    const response = GetPhase4AccountResponse.safeParse({
      status: "CONNECTED",
      ...account,
    });
    if (!response.success) {
      res.status(502).json({ error: "Kalshi account response is invalid" });
      return;
    }
    res.json(response.data);
  } catch (error) {
    const unavailable =
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      (error.type === "NOT_CONFIGURED" ||
        error.type === "INVALID_CREDENTIALS" ||
        error.type === "INVALID_RESPONSE" ||
        error.type === "INVALID_JSON");
    res.status(unavailable ? 503 : 502).json({
      error: unavailable
        ? "Kalshi account is unavailable"
        : "Unable to retrieve Kalshi account",
    });
  }
});

router.get("/phase4/state", requirePhase4Admin, async (_req, res) => {
  try {
    const response = GetPhase4StateResponse.safeParse(await getPhase4State());
    if (!response.success) {
      res.status(503).json({ error: "Phase 4 state is invalid" });
      return;
    }
    res.json(response.data);
  } catch {
    res.status(503).json({ error: "Phase 4 state is unavailable" });
  }
});

router.post("/phase4/shadow/mode", requireDevelopment, requirePhase4Admin, async (req, res) => {
  const mode = req.body?.mode;
  if (mode !== "PAPER_ONLY" && mode !== "SHADOW_LIVE") {
    res.status(400).json({ error: "Invalid shadow mode" });
    return;
  }
  try {
    await setShadowMode(mode);
    const response = GetPhase4StateResponse.safeParse(await getPhase4State());
    if (!response.success) {
      res.status(503).json({ error: "Phase 4 state is invalid" });
      return;
    }
    res.json(response.data);
  } catch {
    res.status(503).json({ error: "Unable to update Phase 4 shadow mode" });
  }
});

router.patch("/phase4/shadow/limits", requireDevelopment, requirePhase4Admin, async (req, res) => {
  if (process.env.NODE_ENV !== "development") {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const input = SetPhase4ShadowLimitsBody.safeParse(req.body);
  if (!input.success) {
    res.status(400).json({ error: "Invalid shadow limits" });
    return;
  }
  if (
    input.data.liveCapitalRemaining > input.data.liveCapitalLimit ||
    input.data.maxStakePerTrade > input.data.liveCapitalLimit
  ) {
    res.status(400).json({ error: "Shadow limits exceed the configured capital limit" });
    return;
  }

  try {
    await setShadowLimits(input.data);
    const response = GetPhase4StateResponse.safeParse(await getPhase4State());
    if (!response.success) {
      res.status(503).json({ error: "Phase 4 state is invalid" });
      return;
    }
    res.json(response.data);
  } catch {
    res.status(503).json({ error: "Unable to update Phase 4 shadow limits" });
  }
});

router.post("/phase4/shadow/scan", requireDevelopment, requirePhase4Admin, async (_req, res) => {
  if (process.env.NODE_ENV !== "development") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    await scanShadowOnce();
    const response = GetPhase4StateResponse.safeParse(await getPhase4State());
    if (!response.success) {
      res.status(503).json({ error: "Phase 4 state is invalid" });
      return;
    }
    res.json(response.data);
  } catch {
    res.status(503).json({ error: "Unable to run Phase 4 shadow scan" });
  }
});

export default router;