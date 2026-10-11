import { Router, type IRouter, type RequestHandler } from "express";
import { sanitizePublic } from "../lib/v13-production/sanitize";
import { emptyUserExecutionView, type ControlAction, type UserExecutionView } from "../lib/strata/userExecutionScope";
import type { PolicyDraft, SharedPreset } from "../lib/strata/sharedPresets";
import type { KalshiUserRead } from "../lib/strata/kalshiUserRead";
import { emptyKalshiUserRead } from "../lib/strata/kalshiUserRead";

export interface UserScopePort {
  migrationReady(): Promise<boolean>;
  settings(userId: string): Promise<UserExecutionView>;
  wallet(userId: string): Promise<KalshiUserRead>;
  control(userId: string, action: ControlAction): Promise<{ ok: boolean; reason?: string; view: UserExecutionView }>;
  stake(userId: string, cents: number, revision: number | null): Promise<{ ok: boolean; reason?: string; view: UserExecutionView }>;
  presets(userId: string): Promise<SharedPreset[]>;
  savePreset(userId: string, body: unknown): Promise<{ ok: boolean; reason?: string; preset?: SharedPreset }>;
  updatePreset(userId: string, presetId: string, body: unknown): Promise<{ ok: boolean; reason?: string; preset?: SharedPreset }>;
  deletePreset(userId: string, presetId: string): Promise<{ ok: boolean; reason?: string }>;
  applyPreset(userId: string, presetId: string): Promise<{ ok: boolean; reason?: string; draft?: PolicyDraft; view: UserExecutionView }>;
}

/** Fail closed. Does not read the legacy account and does not mutate Kalshi or the database. */
export function closedUserScopePort(): UserScopePort {
  const refused = async (userId: string) => ({ ok: false, reason: "user_scope_not_migrated", view: emptyUserExecutionView(userId) });
  return {
    migrationReady: async () => false,
    settings: async (userId) => emptyUserExecutionView(userId),
    wallet: async () => emptyKalshiUserRead(),
    control: async (userId) => refused(userId),
    stake: async (userId) => refused(userId),
    presets: async () => [],
    savePreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    updatePreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    deletePreset: async () => ({ ok: false, reason: "user_scope_not_migrated" }),
    applyPreset: async (userId) => refused(userId),
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
    if (!await migrated(res)) return;
    const action = req.body?.action;
    if (action !== "ARM" && action !== "DISARM" && action !== "START" && action !== "STOP" && action !== "KILL") {
      return void res.status(400).json({ error: "control_action_invalid" });
    }
    const result = await port.control(userId, action);
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
    const result = await port.stake(userId, cents, typeof revision === "number" ? revision : null);
    res.status(result.ok ? 200 : 409).json(sanitizePublic(result));
  });
  router.get("/presets", async (_req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    if (!await migrated(res)) return;
    res.json(sanitizePublic({ presets: await port.presets(userId) }));
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
  router.post("/legacy/claim", async (req, res) => {
    const userId = subject(res);
    if (!userId) return void res.status(401).json({ error: "Unauthorized" });
    ignoreForeignOwner(req.body);
    res.status(409).json({ executable: false, reason: "legacy_claim_not_executed", ownerAssigned: false });
  });
  return router;
}
