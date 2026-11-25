import { BUILD_PROVENANCE } from "./lib/buildProvenance";
import { protectiveHistoryRuntimeMode } from "./lib/strata/protectiveHistoryRuntimeMode";
import {
  configuredDiagnosticOrigins, createProtectiveHistoryDiagnosticFetch, diagnosticJwksUrl,
} from "./lib/strata/protectiveHistoryDiagnosticPolicy";

async function main() {
  const build = BUILD_PROVENANCE;
  if (!build || protectiveHistoryRuntimeMode(process.env, build) !== "DIAGNOSTIC")
    throw Error("protective_history_diagnostic_build_mismatch");
  const port = Number(process.env.PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw Error("protective_history_diagnostic_port_invalid");
  const authUrl = process.env.SUPABASE_URL;
  if (!authUrl) throw Error("protective_history_diagnostic_auth_unavailable");
  const jwks = diagnosticJwksUrl(authUrl);
  const enabled = () => protectiveHistoryRuntimeMode(process.env, build) === "DIAGNOSTIC";
  globalThis.fetch = createProtectiveHistoryDiagnosticFetch(jwks, globalThis.fetch);

  // Load only these narrow ports after installing the read-only process fence.
  const { pool } = await import("@workspace/db");
  const { createStrataAccess, remoteJwks, verifySupabaseAccessToken } = await import("./lib/strata/supabaseAuth");
  const { protectiveHistoryPreviewHandler } = await import("./routes/ownerProtectiveHistoryPreviewRoute");
  const { ownerProtectiveHistoryPreview } = await import("./lib/strata/ownerProtectiveHistoryPreview");
  const { createProtectiveHistoryDiagnosticApp } = await import("./protectiveHistoryDiagnosticApp");
  const keys = remoteJwks(authUrl);
  const owner = createStrataAccess({
    verifyToken: token => verifySupabaseAccessToken(token, { supabaseUrl: authUrl, keys }),
    roleOf: async subject => {
      const r = await pool.query<{ role: string }>("SELECT role FROM public.profiles WHERE id=$1::uuid LIMIT 2", [subject]);
      if (r.rows.length > 1) throw Error("protective_history_diagnostic_profile_not_unique");
      return r.rows[0]?.role ?? null;
    },
  });
  const app = createProtectiveHistoryDiagnosticApp({
    origins: configuredDiagnosticOrigins(process.env.STRATA_WEB_ORIGIN),
    buildSha: build.revision!,
    enabled,
    requireOwner: owner.requireUser,
    preview: protectiveHistoryPreviewHandler(enabled, actor => ownerProtectiveHistoryPreview(actor, build)),
  });
  // No scheduler, workers, quiesce, order hooks, sweeps or analytics drain.
  const server = app.listen(port, "0.0.0.0");
  server.once("error", () => {
    console.error("protective_history_diagnostic_listen_failed");
    process.exitCode = 1;
    void pool.end().catch(() => {});
  });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(() => { void pool.end().catch(() => { process.exitCode = 1; }); });
    server.closeIdleConnections();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
await main().catch((error: unknown) => {
  const label = error instanceof Error && /^protective_history_diagnostic_[a-z_]{1,48}$/.test(error.message)
    ? error.message : "protective_history_diagnostic_startup_failed";
  console.error(label);
  process.exitCode = 1;
});
