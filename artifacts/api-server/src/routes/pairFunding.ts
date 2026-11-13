import { randomBytes, timingSafeEqual } from "node:crypto";
import { getAuth } from "@clerk/express";
import { Router, type Request, type RequestHandler } from "express";
import {
  databaseFundingAttemptStore, reconcileOneShotFunding, submitOneShotFunding,
  type FundingAttemptStore,
} from "../lib/microLivePairFunding";

const PATH = "/api/admin/index2-pair-funding";
type Identity = { userId: string | null; sessionId: string | null };
type Dependencies = {
  store: FundingAttemptStore;
  submit: () => Promise<{ state: string; reason: string }>;
  reconcile: () => Promise<{ state: string; reason: string }>;
  identity: (req: Request) => Identity;
};

export const pairFundingEnabled = () =>
  process.env.NODE_ENV === "development" &&
  process.env.REPLIT_DEPLOYMENT !== "1" &&
  process.env.KALSHI_API_ENVIRONMENT === "production" &&
  process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED === "true";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c] ?? c);
const page = (body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>One-shot $25 pair funding</title></head><body><main>${body}</main></body></html>`;

function sameOrigin(req: Request): boolean {
  const host = process.env.REPLIT_DEV_DOMAIN;
  return !!host && /^[a-z0-9.-]+$/.test(host) &&
    req.get("origin") === `https://${host}` &&
    req.get("host") === host &&
    req.get("x-forwarded-proto") === "https" &&
    (!req.get("x-forwarded-host") || req.get("x-forwarded-host") === host);
}

export function createPairFundingRouter(deps: Dependencies = {
  store: databaseFundingAttemptStore,
  submit: submitOneShotFunding,
  reconcile: reconcileOneShotFunding,
  identity: req => {
    const { userId, sessionId } = getAuth(req);
    return { userId, sessionId };
  },
}) {
  const router = Router();
  const nonces = new Map<string, { token: string; expires: number }>();
  const tokenFor = (session: string) => {
    const token = randomBytes(32).toString("hex");
    nonces.set(session, { token, expires: Date.now() + 600_000 });
    return token;
  };
  const consume = (session: string, value: unknown) => {
    const saved = nonces.get(session);
    nonces.delete(session);
    return !!saved && saved.expires >= Date.now() &&
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value) &&
      timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(saved.token, "hex"));
  };
  const guard: RequestHandler = (req, res, next) => {
    res.set({
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache",
      "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    if (!pairFundingEnabled()) return void res.status(404).send("Not found");
    const { userId, sessionId } = deps.identity(req);
    if (!userId || !sessionId) {
      return void res.status(401).type("html").send(page(
        '<h1>Sign in required</h1><p>Sign in on this host before opening the funding page.</p><a href="/sign-in">Sign in</a>',
      ));
    }
    if (!process.env.PHASE4_ADMIN_USER_ID || userId !== process.env.PHASE4_ADMIN_USER_ID) {
      return void res.status(403).send("Forbidden");
    }
    res.locals.ownerSessionId = sessionId;
    next();
  };
  router.use(guard);

  router.get("/", async (_req, res) => {
    try {
      const attempt = await deps.store.get();
      const nonce = tokenFor(res.locals.ownerSessionId as string);
      const identity = "<h1>One-shot $25.00 pair funding</h1>" +
        "<p>From primary (0,2) to dedicated subaccount (1,2), exchange index 2. " +
        "Execution stays OFF; both kill switches stay engaged; the run stays FROZEN.</p>";
      if (attempt) {
        return void res.type("html").send(page(identity +
          `<p>Funding attempt: ${escapeHtml(attempt.state)}. A second transfer is permanently blocked.</p>` +
          `<form method="post" action="${PATH}/reconcile"><input type="hidden" name="csrf" value="${nonce}">` +
          '<button type="submit">Reconcile existing attempt (GET-only; never transfer again)</button></form>'));
      }
      res.type("html").send(page(identity +
        "<p>This button authorizes exactly one $25.00 transfer. The server performs fresh read-only checks " +
        "before durably recording the attempt and sending a single request. An unclear result is not retried.</p>" +
        `<form method="post" action="${PATH}/transfer"><input type="hidden" name="csrf" value="${nonce}">` +
        '<input type="hidden" name="amount_cents" value="2500">' +
        '<input type="hidden" name="source_subaccount" value="0">' +
        '<input type="hidden" name="destination_subaccount" value="1">' +
        '<input type="hidden" name="exchange_index" value="2">' +
        '<button type="submit">Authorize one $25.00 transfer from (0,2) to (1,2)</button></form>'));
    } catch {
      res.status(503).send("Funding state unavailable; no transfer authorized");
    }
  });

  const guardedPost = (req: Request): boolean =>
    sameOrigin(req) && consume(resolvedSession(req), req.body?.csrf);
  function resolvedSession(req: Request) {
    return req.res?.locals.ownerSessionId as string;
  }
  router.post("/transfer", async (req, res) => {
    if (!guardedPost(req) ||
        Object.keys(req.body ?? {}).sort().join(",") !==
          "amount_cents,csrf,destination_subaccount,exchange_index,source_subaccount" ||
        req.body.amount_cents !== "2500" ||
        req.body.source_subaccount !== "0" ||
        req.body.destination_subaccount !== "1" ||
        req.body.exchange_index !== "2") {
      return void res.status(403).send("Exact owner authorization required");
    }
    try {
      const result = await deps.submit();
      res.status(result.state === "funded" ? 200 :
        result.state === "blocked" ? 409 : 202).type("html").send(page(
        `<h1>${escapeHtml(result.state)}</h1><p>${escapeHtml(result.reason)}</p>` +
        `<p><a href="${PATH}/">Return to funding status</a>. Never repeat the transfer.</p>`,
      ));
    } catch {
      res.status(503).send("Transfer outcome may be uncertain. Never resubmit; use GET-only reconciliation.");
    }
  });
  router.post("/reconcile", async (req, res) => {
    if (!guardedPost(req) || Object.keys(req.body ?? {}).join(",") !== "csrf") {
      return void res.status(403).send("Forbidden");
    }
    try {
      const result = await deps.reconcile();
      res.status(result.state === "funded" ? 200 : 409).type("html").send(page(
        `<h1>${escapeHtml(result.state)}</h1><p>${escapeHtml(result.reason)}</p>` +
        `<p><a href="${PATH}/">Return to funding status</a></p>`,
      ));
    } catch {
      res.status(503).send("GET-only reconciliation unavailable; never resubmit");
    }
  });
  return router;
}