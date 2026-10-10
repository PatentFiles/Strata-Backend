import { randomBytes, timingSafeEqual } from "node:crypto";
import { getAuth } from "@clerk/express";
import { Router, type Request, type RequestHandler, type Response } from "express";
import {
  databaseAttemptStore, KEY_NAME, SCOPES, SUBACCOUNT,
  type AttemptStore,
} from "../lib/keyProvisioningAttempt";
import {
  generateRestrictedKalshiKey, type GeneratedKey,
} from "../lib/generateRestrictedKalshiKey";
import { verifyProvisioningRecovery } from "../lib/verifyProvisioningRecovery";

type Identity = { userId: string | null; sessionId: string | null };
type Dependencies = {
  store: AttemptStore;
  generate: () => Promise<GeneratedKey>;
  verifyRecovery: () => Promise<boolean>;
  identity: (req: Request) => Identity;
};
const enabled = () => process.env.NODE_ENV === "development" &&
  process.env.REPLIT_DEPLOYMENT !== "1" &&
  process.env.KALSHI_KEY_PROVISIONING_ENABLED === "true";
export { enabled as keyProvisioningEnabled };
const generationAuthorized = () =>
  enabled() && process.env.KALSHI_KEY_GENERATION_AUTHORIZED === "true";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}
function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Owner key handoff</title></head><body><main>${body}</main></body></html>`;
}

function sameOrigin(req: Request): boolean {
  const origin = req.get("origin");
  const host = req.get("host");
  const forwardedHost = req.get("x-forwarded-host");
  const canonicalHost = process.env.REPLIT_DEV_DOMAIN;
  // The dev hostname is supplied by Replit, not a request header. The observed
  // development proxy preserves Host and sets x-forwarded-proto to https. A
  // forwarded Host, if present, must agree; it cannot override an arbitrary
  // Host. Sec-Fetch-Site is advisory here: the exact Origin check is required.
  return !!canonicalHost && /^[a-z0-9.-]+$/.test(canonicalHost) &&
    origin === `https://${canonicalHost}` &&
    req.get("x-forwarded-proto") === "https" &&
    host === canonicalHost &&
    (!forwardedHost || forwardedHost === canonicalHost);
}

export function createKeyProvisioningRouter(deps: Dependencies = {
  store: databaseAttemptStore,
  generate: generateRestrictedKalshiKey,
  verifyRecovery: verifyProvisioningRecovery,
  identity: req => {
    const { userId, sessionId } = getAuth(req);
    return { userId, sessionId };
  },
}) {
  const router = Router();
  const nonces = new Map<string, { token: string; expires: number }>();
  const recoveryNonces = new Map<string, { token: string; expires: number }>();
  let handoff: {
    id: Buffer; pem: Buffer; sessionId: string; confirmationToken: string; attemptId: string;
  } | null = null;
  let expiry: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (expiry) clearTimeout(expiry);
    expiry = null;
    if (handoff) {
      handoff.id.fill(0);
      handoff.pem.fill(0);
      handoff = null;
    }
  };
  const tokenFor = (sessionId: string) => {
    const token = randomBytes(32).toString("hex");
    nonces.set(sessionId, { token, expires: Date.now() + 10 * 60_000 });
    return token;
  };
  const consume = (sessionId: string, candidate: unknown) => {
    const entry = nonces.get(sessionId);
    nonces.delete(sessionId);
    const sessionBound = !!entry && entry.expires >= Date.now();
    if (!sessionBound ||
        typeof candidate !== "string" || !/^[a-f0-9]{64}$/.test(candidate)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(entry!.token, "hex"));
  };
  const recoveryTokenFor = (sessionId: string) => {
    const token = randomBytes(32).toString("hex");
    recoveryNonces.set(sessionId, { token, expires: Date.now() + 10 * 60_000 });
    return token;
  };
  const consumeRecovery = (sessionId: string, candidate: unknown) => {
    const entry = recoveryNonces.get(sessionId);
    recoveryNonces.delete(sessionId);
    if (!entry || entry.expires < Date.now() ||
        typeof candidate !== "string" || !/^[a-f0-9]{64}$/.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(entry.token, "hex"));
  };
  const onlyCsrfBody = (req: Request) =>
    Object.keys(req.body ?? {}).join(",") === "csrf";
  const isOwner = (userId: string | null) =>
    !!process.env.PHASE4_ADMIN_USER_ID && userId === process.env.PHASE4_ADMIN_USER_ID;
  const setSafeHeaders = (res: Response) => {
    res.set({
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
  };
  const guard: RequestHandler = (req, res, next) => {
    setSafeHeaders(res);
    if (!enabled()) {
      res.status(404).send("Not found");
      return;
    }
    const { userId, sessionId } = deps.identity(req);
    if (!userId || !sessionId) {
      res.status(401).send("Unauthorized");
      return;
    }
    if (!isOwner(userId)) {
      res.status(403).send("Forbidden");
      return;
    }
    res.locals.ownerSessionId = sessionId;
    next();
  };
  router.use(guard);

  router.get("/recovery", async (_req, res): Promise<void> => {
    res.set("X-Provisioning-Route", "recovery");
    try {
      if (process.env.KALSHI_KEY_GENERATION_AUTHORIZED !== "false" ||
          !(await deps.store.recoveryEligible())) {
        res.status(409).send("Recovery unavailable");
        return;
      }
      const token = recoveryTokenFor(res.locals.ownerSessionId as string);
      res.set("Referrer-Policy", "same-origin");
      res.type("html").send(page(
        "<h1>Confirm independently verified credential</h1>" +
        "<p>The original in-memory handoff was lost after an API restart. " +
        "This action does not recreate it or generate a key. It only records " +
        "a distinct recovery confirmation after fresh GET-only verification.</p>" +
        `<p>Key: ${KEY_NAME}; subaccount: ${SUBACCOUNT}; scopes: ${SCOPES.join(", ")}.</p>` +
        '<form method="post" action="/api/admin/key-provisioning/recover">' +
        `<input type="hidden" name="csrf" value="${token}">` +
        '<button type="submit">Confirm recovered handoff</button></form>',
      ));
    } catch {
      res.status(503).send("Recovery state unavailable");
    }
  });

  router.post("/recover", async (req, res): Promise<void> => {
    if (!sameOrigin(req) ||
        !consumeRecovery(res.locals.ownerSessionId as string, req.body?.csrf) ||
        !onlyCsrfBody(req)) {
      res.status(403).send("Forbidden");
      return;
    }
    if (process.env.KALSHI_KEY_GENERATION_AUTHORIZED !== "false") {
      res.status(409).send("Recovery unavailable");
      return;
    }
    try {
      if (!(await deps.store.recoveryEligible()) ||
          !(await deps.verifyRecovery()) ||
          process.env.KALSHI_KEY_GENERATION_AUTHORIZED !== "false" ||
          !(await deps.store.markRecovered())) {
        res.status(409).send("Recovery verification failed; no state changed");
        return;
      }
      res.type("html").send(page(
        "<h1>Recovered handoff verified</h1><p>The one-time credential was " +
        "independently verified after the original handoff was lost. No key was generated.</p>",
      ));
    } catch {
      res.status(503).send("Recovery could not be recorded; check state before retrying");
    }
  });

  router.get("/", async (req, res): Promise<void> => {
    res.set("X-Provisioning-Route", "root");
    try {
      const state = await deps.store.state();
      if (state === "response_received" &&
          process.env.KALSHI_KEY_GENERATION_AUTHORIZED === "false" &&
          await deps.store.recoveryEligible()) {
        // An old bookmarked owner page must not strand a recoverable handoff
        // behind the one-shot generation guard. This does not confirm recovery.
        res.redirect(303, "/api/admin/key-provisioning/recovery");
        return;
      }
      if (state) {
        res.status(409).type("html").send(page(
          "<h1>Provisioning already recorded</h1><p>This one-shot key cannot be generated again. No private key can be re-displayed.</p>",
        ));
        return;
      }
      const nonce = tokenFor(res.locals.ownerSessionId as string);
      // A no-referrer policy serializes Origin as "null" for navigation-mode
      // form POSTs. Same-origin keeps the real Origin on this exact-host form
      // without sending a referrer to cross-origin destinations.
      res.set("Referrer-Policy", "same-origin");
      res.type("html").send(page(
        `<h1>One-time owner key provisioning</h1><p>One POST only. A lost response cannot be retried. This key is restricted to subaccount 1.</p>` +
        (generationAuthorized() ? "" :
          "<p>Generation authorization is OFF. Submitting this form cannot create an attempt or contact Kalshi.</p>") +
        `<p>Key: ${KEY_NAME}; scopes: ${SCOPES.join(", ")}.</p>` +
        `<form method="post" action="/api/admin/key-provisioning/generate">` +
        `<input type="hidden" name="csrf" value="${nonce}">` +
        `<button type="submit">Generate once</button></form>`,
      ));
    } catch {
      res.status(503).send("Provisioning state unavailable");
    }
  });

  router.post("/generate", async (req, res): Promise<void> => {
    if (!sameOrigin(req) ||
        !consume(res.locals.ownerSessionId as string, req.body?.csrf) ||
        !onlyCsrfBody(req)) {
      res.status(403).send("Forbidden");
      return;
    }
    // Interface visibility never grants permission to reserve an attempt.
    // Check before prepare(), and again in the network client itself.
    if (!generationAuthorized()) {
      res.status(403).send("Generation authorization disabled; no attempt recorded");
      return;
    }
    let attemptId: string | null = null;
    try {
      attemptId = await deps.store.prepare();
      if (!attemptId || !(await deps.store.markAttempted(attemptId))) {
        res.status(409).send("Provisioning already attempted");
        return;
      }
    } catch {
      res.status(503).send("Could not durably reserve one attempt; no API call was made");
      return;
    }
    // No code path from this point may call generate twice for this durable attempt.
    try {
      const generated = await deps.generate();
      const confirmationToken = tokenFor(res.locals.ownerSessionId as string);
      handoff = {
        ...generated, sessionId: res.locals.ownerSessionId as string,
        confirmationToken, attemptId,
      };
      expiry = setTimeout(clear, 10 * 60_000);
      expiry.unref();
      try {
        await deps.store.markOutcome(attemptId, "response_received");
      } catch {
        // Keep the one-time response available in this request. The durable
        // attempted latch is already committed; failure here cannot permit retry.
      }
      res.type("html").send(page(
        `<h1>Copy once into Replit Secrets</h1>` +
        `<p>Create KALSHI_MICRO_LIVE_API_KEY_ID with this key ID:</p>` +
        `<pre>${escapeHtml(generated.id.toString("utf8"))}</pre>` +
        `<p>Create KALSHI_MICRO_LIVE_PRIVATE_KEY with this private key:</p>` +
        `<pre>${escapeHtml(generated.pem.toString("utf8"))}</pre>` +
        `<p>This page cannot be retrieved again. Copy both values before confirming.</p>` +
        `<form method="post" action="/api/admin/key-provisioning/confirm">` +
        `<input type="hidden" name="csrf" value="${confirmationToken}">` +
        `<button type="submit">I saved both secrets</button></form>`,
      ));
    } catch {
      try {
        await deps.store.markOutcome(attemptId, "uncertain");
      } catch {
        // Failed outcome writes never remove the durable attempted latch.
      }
      res.status(503).send("Generation result uncertain; do not retry");
    }
  });

  router.post("/confirm", async (req, res): Promise<void> => {
    const sessionId = res.locals.ownerSessionId as string;
    if (!sameOrigin(req) || !consume(sessionId, req.body?.csrf) ||
        !onlyCsrfBody(req) ||
        !handoff || handoff.sessionId !== sessionId ||
        req.body.csrf !== handoff.confirmationToken) {
      res.status(403).send("Forbidden");
      return;
    }
    const id = handoff.attemptId;
    clear();
    try {
      await deps.store.markOutcome(id, "handoff_confirmed");
    } catch {
      // The sensitive in-memory response is cleared even if the status update fails.
    }
    res.type("html").send(page(
      "<h1>Handoff closed</h1><p>The server will not display or generate this key again. The browser and clipboard must be cleared separately.</p>",
    ));
  });
  return router;
}