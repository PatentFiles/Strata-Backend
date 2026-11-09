/** No process/filesystem access here: caller supplies effects for testable cleanup. */
export function cleanupOwnedAnalyticsPostgres({ startup, hasPid, status, stop, remove }) {
  if (startup !== "not_attempted") {
    let state = status();
    if (state === 0 || hasPid()) {
      if (stop() !== 0) throw new Error("analytics_owned_postgres_stop_failed");
      state = status();
    } else if (startup === "uncertain") {
      // Missing PID/status=3 alone cannot exclude a late-starting child after a
      // failed or timed-out startup. Keep its directory instead of claiming clean.
      throw new Error("analytics_owned_postgres_startup_uncertain");
    }
    if (state !== 3 || hasPid()) throw new Error("analytics_owned_postgres_stop_unconfirmed");
  }
  remove();
}
