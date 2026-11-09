/** Optional dashboard reads only. Never import this into a trading/producer gate.
 * This sheds new scans, not in-flight queries, and does not reclaim disk space.
 */
export const PAPER_ANALYTICS_PAUSE_MESSAGE = "Paper analytics paused for database maintenance";
export function paperAnalyticsPaused(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STRATA_PAPER_ANALYTICS_PAUSED === "true";
}
export function assertPaperAnalyticsAvailable(): void {
  if (paperAnalyticsPaused()) throw new Error(PAPER_ANALYTICS_PAUSE_MESSAGE);
}
