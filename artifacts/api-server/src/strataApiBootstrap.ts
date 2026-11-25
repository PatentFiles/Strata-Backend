import { BUILD_PROVENANCE } from "./lib/buildProvenance";
import { protectiveHistoryRuntimeMode } from "./lib/strata/protectiveHistoryRuntimeMode";

// These are separate compiled executables, not lazy branches of a shared
// trading bundle. Neither app nor any worker is imported before this decision.
const mode = protectiveHistoryRuntimeMode(process.env, BUILD_PROVENANCE);
if (mode === "REFUSE") throw Error("protective_history_diagnostic_build_mismatch");
const executable = mode === "DIAGNOSTIC" ? "./protectiveHistoryDiagnosticMain.mjs" : "./normalApiMain.mjs";
await import(new URL(executable, import.meta.url).href);
