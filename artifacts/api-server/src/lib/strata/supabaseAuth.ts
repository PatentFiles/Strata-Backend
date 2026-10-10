import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface SupabaseIdentity {
  subject: string;
  issuer: string;
  audience: string;
  aal: "aal2";
}

/** Operator roles from public.profiles. STANDARD is never a production controller. */
export const PRODUCTION_CONTROL_ROLES = new Set(["DEVELOPER", "ADMIN"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function supabaseIssuer(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
}

export function remoteJwks(supabaseUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`${supabaseIssuer(supabaseUrl)}/.well-known/jwks.json`));
}

/**
 * Verifies a Supabase access token. Signature, issuer, audience, expiration and
 * subject are all required. AAL1 is rejected because launch sessions are AAL2.
 */
export async function verifySupabaseAccessToken(
  token: string,
  options: { supabaseUrl: string; keys: JWTVerifyGetKey },
): Promise<SupabaseIdentity> {
  const issuer = supabaseIssuer(options.supabaseUrl);
  const { payload } = await jwtVerify(token, options.keys, {
    issuer,
    audience: "authenticated",
  });
  if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) {
    throw new Error("invalid subject");
  }
  if (payload.aal !== "aal2") throw new Error("aal");
  return { subject: payload.sub, issuer, audience: "authenticated", aal: "aal2" };
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export interface StrataAccessDeps {
  verifyToken: (token: string) => Promise<SupabaseIdentity>;
  roleOf: (subject: string) => Promise<string | null>;
}

export function createStrataAccess(deps: StrataAccessDeps): {
  requireUser: RequestHandler;
  requireDeveloper: RequestHandler;
} {
  const requireUser: RequestHandler = async (req, res, next) => {
    const token = bearer(req.header("authorization"));
    if (!token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    let identity: SupabaseIdentity;
    try {
      identity = await deps.verifyToken(token);
    } catch {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    let role: string | null;
    try {
      role = await deps.roleOf(identity.subject);
    } catch {
      res.status(503).json({ error: "Profile role is unavailable" });
      return;
    }
    res.locals.strata = { subject: identity.subject, role };
    next();
  };

  const requireDeveloper: RequestHandler = (req, res, next) => {
    return requireUser(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      if (res.headersSent) return;
      const role = (res.locals.strata as { role?: string | null } | undefined)?.role ?? null;
      if (!role || !PRODUCTION_CONTROL_ROLES.has(role)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    });
  };

  return { requireUser, requireDeveloper };
}
