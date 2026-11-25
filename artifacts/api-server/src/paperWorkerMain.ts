import { V13_ENTRY_POLICY_VERSION } from "@workspace/v13-strategy";
import { forwardTestStartupDecision } from "./lib/forwardTestStartupGate";

async function main() {
  const startup = forwardTestStartupDecision(process.env, V13_ENTRY_POLICY_VERSION);
  if (!startup.ready) throw new Error(startup.reason);
  // Do not accidentally reuse the API's database login. The paper service
  // must receive its own restricted role; no execution secrets belong here.
  if (process.env.DATABASE_URL) throw new Error("paper_inherited_api_database_url");
  const paperDatabaseUrl = process.env.STRATA_PAPER_DATABASE_URL;
  if (!paperDatabaseUrl) throw new Error("paper_database_url_required");
  process.env.DATABASE_URL = paperDatabaseUrl;

  const { pool } = await import("@workspace/db");
  try {
    // A distinct URL is not proof of isolation. Fail before taking the lease
    // if a deployment mistakenly points paper at an API or privileged role.
    const privilege = await pool.query<{restricted:boolean}>(`
      SELECT
        NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
        AND r.rolcanlogin
        AND coalesce(pg_has_role(current_user,to_regrole('strata_paper_runtime'),'USAGE'),false)
        AND NOT EXISTS(
          SELECT 1 FROM (VALUES
            ('public','v13_production_account'), ('public','v13_production_intent'),
            ('public','v13_production_position'), ('public','v13_production_event'),
            ('public','strata_direct_entry_source'), ('private','kalshi_connection_credentials'),
            ('private','kalshi_account_worker_lease'), ('vault','decrypted_secrets')
          ) AS protected(schema_name, relation_name)
          JOIN pg_namespace n ON n.nspname=protected.schema_name
          JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=protected.relation_name
          WHERE has_table_privilege(current_user,c.oid,
                                    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        ) AS restricted
      FROM pg_roles r WHERE r.rolname=current_user
    `);
    if(privilege.rows.length!==1||privilege.rows[0]?.restricted!==true)
      throw new Error("paper_database_role_not_isolated");
    const { startServerForwardTestWorker } = await import("./lib/forwardTestWorker");
    const worker = startServerForwardTestWorker();
    if (!worker.running) throw new Error("paper_scheduler_not_started");
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void worker.stop().catch(() => {
        console.error("Paper worker shutdown failed");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await worker.done;
      if (!stopping) throw new Error("paper_scheduler_exited_unexpectedly");
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  // Only fixed startup reason labels may be logged; database errors can
  // include connection details and are not rendered by this entry point.
  const message = error instanceof Error ? error.message : "";
  const reason = /^[a-z][a-z_]{0,79}$/.test(message) ? message : "paper_worker_runtime_failure";
  console.error(`Paper worker refused or stopped: ${reason}`);
  process.exitCode = 1;
});
