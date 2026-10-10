import { randomBytes, timingSafeEqual } from "node:crypto";
import { getAuth } from "@clerk/express";
import { Router, type Request, type RequestHandler } from "express";
import {
  approvePairCommissioningFee, commissioningApprovalEnabled,
  commissioningApprovalView, PAIR_429_ATTESTATION_SOURCE, preparePairCommissioningApproval,
  reviewPairCommissioningFeePdf,
} from "../lib/microLivePairCommissioningApproval";

const PATH = "/api/admin/index2-pair-commissioning";
type Identity = { userId: string | null; sessionId: string | null };
type Dependencies = {
  identity: (req: Request) => Identity;
  view: typeof commissioningApprovalView;
  prepare: typeof preparePairCommissioningApproval;
  review: typeof reviewPairCommissioningFeePdf;
  approve: typeof approvePairCommissioningFee;
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c] ?? c);
function sameOrigin(req: Request) {
  const host = process.env.REPLIT_DEV_DOMAIN;
  return !!host && /^[a-z0-9.-]+$/.test(host) &&
    req.get("origin") === `https://${host}` &&
    req.get("host") === host && req.get("x-forwarded-proto") === "https" &&
    (!req.get("x-forwarded-host") || req.get("x-forwarded-host") === host);
}

export function createPairCommissioningApprovalRouter(deps: Dependencies = {
  identity: req => {
    const { userId, sessionId } = getAuth(req);
    return { userId, sessionId };
  },
  view: commissioningApprovalView,
  prepare: preparePairCommissioningApproval,
  review: reviewPairCommissioningFeePdf,
  approve: approvePairCommissioningFee,
}) {
  const router = Router();
  const nonces = new Map<string, { value: string; expires: number }>();
  const tokenFor = (session: string) => {
    const value = randomBytes(32).toString("hex");
    nonces.set(session, { value, expires: Date.now() + 600_000 });
    return value;
  };
  const consume = (session: string, token: unknown) => {
    const saved = nonces.get(session);
    nonces.delete(session);
    return !!saved && saved.expires >= Date.now() &&
      typeof token === "string" && /^[a-f0-9]{64}$/.test(token) &&
      timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(saved.value, "hex"));
  };
  const guard: RequestHandler = (req, res, next) => {
    res.set({
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache",
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
    });
    if (!commissioningApprovalEnabled()) return void res.status(404).send("Not found");
    const { userId, sessionId } = deps.identity(req);
    if (!userId || !sessionId) return void res.status(401).send("Sign in required on this host");
    if (!process.env.PHASE4_ADMIN_USER_ID || userId !== process.env.PHASE4_ADMIN_USER_ID)
      return void res.status(403).send("Forbidden");
    res.locals.ownerSessionId = sessionId;
    next();
  };
  router.use(guard);
  router.get("/", async (_req, res) => {
    try {
      const state = await deps.view();
      const token = tokenFor(res.locals.ownerSessionId as string);
      const scriptNonce = randomBytes(20).toString("base64");
      res.set("Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'none'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
      const status = escapeHtml(state.status);
      const reviewed = state.status === "reviewed" && !!state.reviewId &&
        !!state.reviewExpiresAt && Date.parse(state.reviewExpiresAt) > Date.now();
      const provenance = state.reviewSource === PAIR_429_ATTESTATION_SOURCE
        ? "Owner-attested official PDF after canonical-source HTTP 429; not server-fetched or server-verified"
        : state.reviewSource === "server_fetched" ? "Server-fetched official PDF verified" : "Not reviewed";
      const buttons = state.status === "not_prepared"
        ? '<button id="prepare">Preserve FROZEN snapshot and prepare separate $1 approval</button>'
        : state.status === "pending"
          ? '<label>Exact official Kalshi fee-schedule PDF <input type="file" id="pdf" accept="application/pdf"></label>' +
            '<p>Kalshi’s canonical PDF returned HTTP 429 to this environment. This one-document commissioning path does not fetch it or claim server verification. Unknown or conflicting Kalshi market-specific fee metadata will still block any later trading.</p>' +
            '<label><input type="checkbox" id="attest">I attest that this exact PDF came from the official Kalshi fee schedule; I understand the server could not verify its source due to HTTP 429.</label>' +
            '<button id="review">Review owner-attested fee policy (no approval)</button>'
          : reviewed
            ? `<p>Review provenance: ${escapeHtml(provenance)}. Exact PDF SHA-256: ${escapeHtml(state.pdfDigest ?? "")}. Review expires: ${escapeHtml(state.reviewExpiresAt ?? "")}</p><button id="approve">Approve only this $1 fee policy for (1,2)</button>`
            : state.status === "approved"
              ? `<p>Approved. Provenance: ${escapeHtml(provenance)}. This does not initialize, arm, or enable execution.</p>`
              : "<p>Review expired. No approval was made; no run was changed.</p>";
      res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>(1,2) $1 fee-policy approval</title></head><body><main>` +
        `<h1>(1,2) $1.00 fee-inclusive policy</h1><p>INDEX2 credential only. Historical FROZEN run remains untouched. Execution OFF; both kill switches engaged. This page cannot initialize, arm, trade, cancel, or transfer.</p>` +
        `<p>Fee basis: <a href="https://kalshi.com/docs/kalshi-fee-schedule.pdf" rel="noopener noreferrer">official Kalshi fee schedule</a>. Standard quadratic taker formula: 0.07 × multiplier × contracts × price × (1 − price). All entry, exit, and related fees must fit inside the $1.00 all-in cap. Reviewing the official PDF does not approve this policy.</p>` +
        `<p>Status: ${status}. Cap: $1.00 all-in, including fees.</p>${buttons}<p id="result" role="status"></p></main>` +
        `<script nonce="${scriptNonce}">` +
        `const path=${JSON.stringify(PATH)}, csrf=${JSON.stringify(token)}, source=${JSON.stringify(PAIR_429_ATTESTATION_SOURCE)};` +
        `async function send(action, extra={}) {const result=document.getElementById('result');` +
        `result.textContent='Checking…'; try {const response=await fetch(path+'/'+action,{method:'POST',` +
        `headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({csrf,...extra})});` +
        `const data=await response.json();result.textContent=data.reason||data.error||'Request failed';` +
        `if(response.ok) location.reload();}catch{result.textContent='Unavailable; refresh status before retrying';}}` +
        `document.getElementById('prepare')?.addEventListener('click',()=>send('prepare'));` +
        `document.getElementById('approve')?.addEventListener('click',()=>send('approve',{reviewId:${JSON.stringify(state.reviewId ?? "").replaceAll("<", "\\u003c")}}));` +
        `document.getElementById('review')?.addEventListener('click',async()=>{const f=document.getElementById('pdf').files[0];` +
        `if(!f||f.size>2000000){document.getElementById('result').textContent='Choose a PDF under 2 MB';return;}` +
        `if(!document.getElementById('attest').checked){document.getElementById('result').textContent='Owner attestation is required';return;}` +
        `const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));` +
        `send('review',{pdfBase64:btoa(binary),source,attestOfficial:true});});</script></body></html>`);
    } catch {
      res.status(503).send("Commissioning approval status unavailable");
    }
  });
  const allowedPost = (req: Request, keys: string[]) =>
    sameOrigin(req) && Object.keys(req.body ?? {}).sort().join(",") === keys.sort().join(",") &&
    consume(req.res?.locals.ownerSessionId as string, req.body?.csrf);
  router.post("/prepare", async (req, res) => {
    if (!allowedPost(req, ["csrf"])) return void res.status(403).json({ error: "Owner confirmation required" });
    try {
      const result = await deps.prepare(deps.identity(req).userId!);
      res.status(result.status === "blocked" ? 409 : 200).json(result);
    } catch { res.status(503).json({ error: "Approval preparation unavailable" }); }
  });
  router.post("/review", async (req, res) => {
    if (!allowedPost(req, ["csrf", "pdfBase64", "source", "attestOfficial"]) ||
        typeof req.body.pdfBase64 !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(req.body.pdfBase64) ||
        req.body.pdfBase64.length > 2_700_000 ||
        (req.body.source !== "server_fetched" && req.body.source !== PAIR_429_ATTESTATION_SOURCE) ||
        (req.body.source === PAIR_429_ATTESTATION_SOURCE && req.body.attestOfficial !== true) ||
        (req.body.source === "server_fetched" && req.body.attestOfficial !== false))
      return void res.status(403).json({ error: "Exact PDF review required" });
    try {
      const result = await deps.review(
        Buffer.from(req.body.pdfBase64, "base64"), deps.identity(req).userId!,
        req.body.source, req.body.attestOfficial,
      );
      res.status(result.status === "blocked" ? 409 : 200).json(result);
    } catch { res.status(503).json({ error: "Fee review unavailable" }); }
  });
  router.post("/approve", async (req, res) => {
    if (!allowedPost(req, ["csrf", "reviewId"]) ||
        typeof req.body.reviewId !== "string")
      return void res.status(403).json({ error: "Exact owner approval required" });
    try {
      const result = await deps.approve(req.body.reviewId, deps.identity(req).userId!);
      res.status(result.status === "blocked" ? 409 : 200).json(result);
    } catch { res.status(503).json({ error: "Fee approval unavailable" }); }
  });
  return router;
}