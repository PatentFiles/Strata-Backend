import { randomBytes, timingSafeEqual } from "node:crypto";
import { getAuth } from "@clerk/express";
import { db, microLivePairBoundaryTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Router, type Request, type RequestHandler, type Response } from "express";
import {
  databasePairKeyAttemptStore, PAIR_KEY_NAME, PAIR_SCOPES, PAIR_SUBACCOUNT,
  type PairKeyAttemptStore,
} from "../lib/microLivePairKeyProvisioningAttempt";
import {
  generatePairRestrictedKalshiKey, preflightPairKeyProvisioning,
  verifyFreshPairClean, verifyPairKeyMetadata, type GeneratedPairKey,
} from "../lib/generatePairRestrictedKalshiKey";
import { verifyKalshiRestrictedTradingKeyForSubaccount } from "../lib/kalshiAccountClient";
import { bindMicroLivePairRestrictedKey } from "../lib/microLivePairBoundary";

const PATH = "/api/admin/index2-key-provisioning";
type Identity = { userId: string | null; sessionId: string | null };
type Dependencies = {
  store: PairKeyAttemptStore;
  readBoundary: () => Promise<string | null>;
  preflight: () => Promise<void>;
  generate: () => Promise<GeneratedPairKey>;
  verifyMetadata: (keyId: string) => Promise<boolean>;
  verifySavedKey: () => Promise<boolean>;
  verifyCleanPair: () => Promise<number>;
  bindKey: (cleanCheckedAt: number) => Promise<{ status: string; reason: string }>;
  savedKeyMatches: (keyId: string) => boolean;
  identity: (req: Request) => Identity;
};

export const pairKeyProvisioningEnabled = () =>
  process.env.NODE_ENV === "development" &&
  process.env.REPLIT_DEPLOYMENT !== "1" &&
  process.env.KALSHI_INDEX2_KEY_PROVISIONING_ENABLED === "true";
const authorized = () => pairKeyProvisioningEnabled() &&
  process.env.KALSHI_INDEX2_KEY_GENERATION_AUTHORIZED === "true" &&
  process.env.KALSHI_API_ENVIRONMENT === "production";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>NEW INDEX-2 MICRO_LIVE CREDENTIAL</title></head><body><main>${body}</main></body></html>`;
}

function sameOrigin(req: Request): boolean {
  const canonicalHost = process.env.REPLIT_DEV_DOMAIN;
  return !!canonicalHost && /^[a-z0-9.-]+$/.test(canonicalHost) &&
    req.get("origin") === `https://${canonicalHost}` &&
    req.get("host") === canonicalHost &&
    req.get("x-forwarded-proto") === "https" &&
    (!req.get("x-forwarded-host") || req.get("x-forwarded-host") === canonicalHost);
}

export function createPairKeyProvisioningRouter(deps: Dependencies = {
  store: databasePairKeyAttemptStore,
  readBoundary: async () => {
    const [row] = await db.select({
      state: microLivePairBoundaryTable.state,
      exchangeIndex: microLivePairBoundaryTable.exchangeIndex,
    }).from(microLivePairBoundaryTable)
      .where(eq(microLivePairBoundaryTable.subaccountNumber, PAIR_SUBACCOUNT))
      .limit(1);
    return row?.exchangeIndex === 2 ? row.state : null;
  },
  preflight: preflightPairKeyProvisioning,
  generate: generatePairRestrictedKalshiKey,
  verifyMetadata: verifyPairKeyMetadata,
  verifySavedKey: () => verifyKalshiRestrictedTradingKeyForSubaccount(PAIR_SUBACCOUNT, "index2"),
  verifyCleanPair: async () => {
    await verifyFreshPairClean();
    return Date.now();
  },
  bindKey: cleanCheckedAt => bindMicroLivePairRestrictedKey(
    { subaccountNumber: PAIR_SUBACCOUNT, cleanCheckedAt }, {}, "index2",
  ),
  savedKeyMatches: keyId => !!keyId &&
    process.env.KALSHI_INDEX2_API_KEY_ID?.trim() === keyId,
  identity: req => {
    const { userId, sessionId } = getAuth(req);
    return { userId, sessionId };
  },
}) {
  const router = Router();
  const nonces = new Map<string, { token: string; expires: number }>();
  const tokenFor = (sessionId: string) => {
    const token = randomBytes(32).toString("hex");
    nonces.set(sessionId, { token, expires: Date.now() + 10 * 60_000 });
    return token;
  };
  const consume = (sessionId: string, value: unknown) => {
    const saved = nonces.get(sessionId);
    nonces.delete(sessionId);
    return !!saved && saved.expires >= Date.now() &&
      typeof value === "string" && /^[a-f0-9]{64}$/.test(value) &&
      timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(saved.token, "hex"));
  };
  const csrfOnly = (req: Request) => Object.keys(req.body ?? {}).join(",") === "csrf";
  const guard: RequestHandler = (req, res, next) => {
    res.set({
      "X-Provisioning-Route": "new-index2",
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (!pairKeyProvisioningEnabled()) return void res.status(404).send("Not found");
    const { userId, sessionId } = deps.identity(req);
    if (!userId || !sessionId) {
      if (req.method === "GET" && req.path === "/") {
        res.status(401).type("html").send(page(
          "<h1>Sign in required</h1>" +
          "<p>Sign in on this same development hostname in Safari, then open the NEW index-2 owner page from the signed-in dashboard.</p>" +
          '<p><a href="/sign-in">Sign in on this host</a></p>',
        ));
      } else {
        res.status(401).send("Unauthorized");
      }
      return;
    }
    if (!process.env.PHASE4_ADMIN_USER_ID ||
        userId !== process.env.PHASE4_ADMIN_USER_ID) {
      return void res.status(403).send("Forbidden");
    }
    res.locals.ownerSessionId = sessionId;
    next();
  };
  router.use(guard);

  router.get("/", async (_req, res): Promise<void> => {
    try {
      const [attempt, boundary] = await Promise.all([
        deps.store.get(), deps.readBoundary(),
      ]);
      const identity =
        "<h1>NEW INDEX-2 MICRO_LIVE CREDENTIAL</h1>" +
        "<p>Pair: subaccount 1, exchange index 2.</p>" +
        `<p>Current boundary: ${escapeHtml(boundary ?? "UNAVAILABLE")}.</p>` +
        `<p>Intended scopes: ${PAIR_SCOPES.join(" + ")}; no general write.</p>` +
        "<p>New development secrets: KALSHI_INDEX2_API_KEY_ID and KALSHI_INDEX2_PRIVATE_KEY. Do not overwrite historical secrets.</p>";
      if (boundary === "KEY_BOUND_VERIFIED") {
        res.type("html").send(page(identity +
          "<p>Existing credential is bound and verified. Funding and execution remain separate and blocked.</p>"));
        return;
      }
      if (boundary !== "CREATED_CLEAN") {
        res.status(409).type("html").send(page(
          identity + "<p>Generation blocked: the clean boundary is unavailable.</p>",
        ));
        return;
      }
      if (attempt) {
        const session = res.locals.ownerSessionId as string;
        const nonce = tokenFor(session);
        res.set("Referrer-Policy", "same-origin");
        const canConfirm = !!attempt.keyId && !!attempt.metadataVerifiedAt &&
          !attempt.confirmedAt && attempt.state === "metadata_verified";
        const canResumeBinding = !!attempt.keyId && !!attempt.metadataVerifiedAt &&
          !!attempt.confirmedAt && attempt.state === "handoff_confirmed";
        res.status(canConfirm || canResumeBinding ? 200 : 409).type("html").send(page(
          identity + `<h2>Dedicated key attempt already recorded</h2><p>State: ${escapeHtml(attempt.state)}. A second key POST is permanently blocked; no private key can be redisplayed.</p>` +
          (canConfirm || canResumeBinding ?
            `<p>${canConfirm ? "Confirm that you saved both new secrets." : "Resume verification of the confirmed handoff."} Fresh GET-only checks must pass before binding; this does not authorize funding or execution.</p>` +
            `<form method="post" action="${PATH}/confirm"><input type="hidden" name="csrf" value="${nonce}"><button type="submit">${canConfirm ? "I saved both secrets — verify and bind existing key" : "Retry verification and binding of existing key"}</button></form>` : "") +
          (attempt.keyId && !attempt.metadataVerifiedAt ?
            `<form method="post" action="${PATH}/verify"><input type="hidden" name="csrf" value="${nonce}"><button type="submit">Verify recorded key metadata using GET only</button></form>` : ""),
        ));
        return;
      }
      const nonce = tokenFor(res.locals.ownerSessionId as string);
      res.set("Referrer-Policy", "same-origin");
      res.type("html").send(page(
        identity +
        "<p>This is a new one-shot attempt for (1,2), not the historical index-0 key. " +
        "The key restricts subaccount 1, not exchange index; pair identity is enforced separately.</p>" +
        `<p>Name: ${PAIR_KEY_NAME}; subaccount: ${PAIR_SUBACCOUNT}; scopes: ${PAIR_SCOPES.join(", ")}.</p>` +
        (authorized() ? "" :
          "<p>Generation authorization is OFF. This form cannot record an attempt or contact Kalshi.</p>") +
        `<form method="post" action="${PATH}/generate"><input type="hidden" name="csrf" value="${nonce}"><button type="submit"${authorized() ? "" : " disabled"}>Generate index-2 key once</button></form>`,
      ));
    } catch {
      res.status(503).send("Dedicated provisioning state unavailable");
    }
  });

  router.post("/generate", async (req, res): Promise<void> => {
    const sessionId = res.locals.ownerSessionId as string;
    if (!sameOrigin(req) || !consume(sessionId, req.body?.csrf) || !csrfOnly(req)) {
      res.status(403).send("Forbidden");
      return;
    }
    if (!authorized()) {
      res.status(403).send("Generation authorization disabled; no attempt recorded");
      return;
    }
    let attemptId: string | null = null;
    try {
      await deps.preflight();
      if (!authorized()) throw new Error("Authorization changed");
      attemptId = await deps.store.prepare();
      if (!attemptId || !(await deps.store.markAttempted(attemptId))) {
        res.status(409).send("Dedicated provisioning already attempted or boundary changed");
        return;
      }
    } catch {
      res.status(503).send("Preflight or durable reservation failed; no key POST was sent");
      return;
    }
    // The attempted transition is committed. Never invoke generate again.
    let generated: GeneratedPairKey;
    try {
      generated = await deps.generate();
    } catch {
      try { await deps.store.markUncertain(attemptId); } catch { /* latch remains attempted */ }
      res.status(503).send("Key outcome uncertain; never retry generation");
      return;
    }
    try {
      const keyId = generated.id.toString("utf8");
      let recorded = false;
      try { recorded = await deps.store.markResponse(attemptId, keyId); } catch { /* no retry */ }
      let metadataVerified = false;
      if (recorded) {
        try {
          metadataVerified = await deps.verifyMetadata(keyId);
          if (metadataVerified) {
            metadataVerified = await deps.store.markMetadataVerified(attemptId);
          }
        } catch { /* owner still receives the sole private-key handoff */ }
      }
      const token = tokenFor(sessionId);
      // Keep form POST's Origin on the exact development host; no secret is
      // placed in the URL or referrer, and cross-origin requests remain denied.
      res.set("Referrer-Policy", "same-origin");
      res.type("html").send(page(
        "<h1>Copy once into Replit Secrets</h1>" +
        "<p>This response cannot be retrieved again. Do not save it in a log or database.</p>" +
        `<p>Set the new development secret KALSHI_INDEX2_API_KEY_ID to:</p><pre>${escapeHtml(keyId)}</pre>` +
        `<p>Set the new development secret KALSHI_INDEX2_PRIVATE_KEY to:</p><pre>${escapeHtml(generated.pem.toString("utf8"))}</pre>` +
        "<p>Do not replace the historical restricted-key secrets. These new credentials are not yet bound or authorized for trading.</p>" +
        (metadataVerified ? "<p>Independent unrestricted metadata GET verified the new key ID, name, N, and exact scopes.</p>" :
          "<p>Independent metadata verification is pending or unavailable. Binding stays blocked until it succeeds.</p>") +
        `<form method="post" action="${PATH}/confirm"><input type="hidden" name="csrf" value="${token}"><button type="submit">I saved both secrets</button></form>`,
      ));
    } finally {
      generated.id.fill(0);
      generated.pem.fill(0);
    }
  });

  router.post("/confirm", async (req, res): Promise<void> => {
    const sessionId = res.locals.ownerSessionId as string;
    if (!sameOrigin(req) || !consume(sessionId, req.body?.csrf) || !csrfOnly(req)) {
      res.status(403).send("Forbidden");
      return;
    }
    try {
      const [attempt, boundary] = await Promise.all([
        deps.store.get(), deps.readBoundary(),
      ]);
      if (boundary !== "CREATED_CLEAN" || !attempt?.keyId ||
          !attempt.metadataVerifiedAt || !deps.savedKeyMatches(attempt.keyId) ||
          !(attempt.state === "metadata_verified" && !attempt.confirmedAt ||
            attempt.state === "handoff_confirmed" && !!attempt.confirmedAt)) {
        res.status(409).send("Existing key handoff or clean boundary unavailable; no binding");
        return;
      }
      if (!(await deps.verifyMetadata(attempt.keyId)) ||
          !(await deps.verifySavedKey())) {
        res.status(409).send("Existing key failed independent metadata or signed GET verification; no binding");
        return;
      }
      const cleanCheckedAt = await deps.verifyCleanPair();
      if (!Number.isFinite(cleanCheckedAt) || Date.now() - cleanCheckedAt < 0 ||
          Date.now() - cleanCheckedAt > 30_000) {
        res.status(409).send("Clean pair evidence expired; no binding");
        return;
      }
      if (!attempt.confirmedAt && !(await deps.store.markConfirmed(attempt.attemptId))) {
        res.status(409).send("Durable owner acknowledgement unavailable; no binding");
        return;
      }
      const result = await deps.bindKey(cleanCheckedAt);
      if (result.status !== "captured" || result.reason !== "pair_restricted_key_bound_verified") {
        res.status(409).send("Handoff acknowledged, but pair binding was blocked; funding remains blocked");
        return;
      }
      res.type("html").send(page(
        "<h1>Existing key handoff confirmed</h1><p>Fresh independent GETs verified the saved key and clean pair. " +
        "Pair boundary: KEY_BOUND_VERIFIED. No key was displayed or generated again. " +
        "Funding and execution are not authorized.</p>",
      ));
    } catch {
      res.status(503).send("Handoff verification unavailable; no key generated and funding remains blocked");
    }
  });

  router.post("/verify", async (req, res): Promise<void> => {
    const sessionId = res.locals.ownerSessionId as string;
    if (!sameOrigin(req) || !consume(sessionId, req.body?.csrf) || !csrfOnly(req)) {
      res.status(403).send("Forbidden");
      return;
    }
    try {
      const attempt = await deps.store.get();
      if (!attempt?.keyId || !(await deps.verifyMetadata(attempt.keyId)) ||
          (!attempt.metadataVerifiedAt &&
            !(await deps.store.markMetadataVerified(attempt.attemptId)))) {
        res.status(409).send("Independent GET did not verify the new key");
        return;
      }
      res.type("html").send(page("<h1>Key metadata verified</h1><p>No private key was displayed. Restricted-key signing and pair binding remain separate.</p>"));
    } catch {
      res.status(503).send("Independent verification unavailable");
    }
  });
  return router;
}