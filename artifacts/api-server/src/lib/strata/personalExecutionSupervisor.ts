/**
 * Production HTTP control uses this session. It does not open Vault, does not
 * call Kalshi, and does not report a worker as running. A test supplies its
 * own session around scheduleOwnedAccountWorker and a mock transport.
 */
export interface PersonalSessionControl {
  isScheduled(userId: string, accountId: string): boolean;
  start(input: {
    userId: string;
    accountId: string;
    action: "START" | "ARM";
  }): Promise<{ ok: boolean; reason: string; workerStarted: boolean }>;
  stop(input: { userId: string; accountId: string }): Promise<{ workerStopped: boolean }>;
}

export function productionPersonalSession(): PersonalSessionControl {
  return {
    isScheduled() {
      return false;
    },
    async start() {
      return { ok: false, reason: "personal_submission_not_authorized", workerStarted: false };
    },
    async stop() {
      return { workerStopped: true };
    },
  };
}
