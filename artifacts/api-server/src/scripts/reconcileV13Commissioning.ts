/**
 * Manual development-only tool; never registered in worker startup or build scripts.
 * --dry-run is read-only; --apply-development-commissioning explicitly authorizes writes.
 */
import { pathToFileURL } from "node:url";
import { parseRepairArguments } from "../lib/v13CommissioningTransition";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    const request = parseRepairArguments(process.argv.slice(2));
    const { repairDevelopmentCommissioning } = await import("../lib/v13CommissioningRepair");
    const { pool } = await import("@workspace/db");
    try { console.log(JSON.stringify(await repairDevelopmentCommissioning(request), null, 2)); }
    finally { await pool.end(); }
  })().catch(error => {
    const reason = error instanceof Error && /^[a-z_]{1,100}$/.test(error.message)
      ? error.message : "commissioning_repair_refused";
    console.error(JSON.stringify({ status: "blocked", reason, executionAuthority: "NONE" }));
    process.exitCode = 1;
  });
}
