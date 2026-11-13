import { useRef, useState } from 'react';
import { AlertTriangle, LockKeyhole, X } from 'lucide-react';
import {
  useResolveStaleMicroLiveAccounting,
  type MicroLiveState,
} from '@workspace/api-client-react';

const EXPECTED_REASON = 'startup_exchange_reconciliation_failed' as const;
const RESOLUTION_REASON =
  'The original startup audit failed because the trading PEM was unparseable. Credentials were corrected, complete primary-account history verification subsequently passed, and this procedure must freshly confirm an empty bot ledger and unchanged frozen gates before resolution.';

export function canResolveStaleAccounting(state: MicroLiveState): boolean {
  return state.configurationExists &&
    state.accountingUnresolved &&
    state.accountingUnresolvedReason === EXPECTED_REASON &&
    state.killSwitch === 'ON' && !state.enabled &&
    state.databaseFlags?.microLiveProductionEnabled === false &&
    state.databaseFlags.liveExecutionEnabled === false &&
    !state.environmentFlags.microLiveProductionEnabled &&
    !state.environmentFlags.liveExecutionEnabled;
}

type Outcome = { status: string; reason: string; decisionId?: string };

function rejectedOutcome(error: unknown): Outcome {
  if (error && typeof error === 'object' && 'data' in error &&
      error.data && typeof error.data === 'object' &&
      'status' in error.data && 'reason' in error.data &&
      typeof error.data.status === 'string' && typeof error.data.reason === 'string') {
    return { status: error.data.status, reason: error.data.reason };
  }
  return {
    status: 'request not confirmed',
    reason: error instanceof Error ? error.message : 'Request failed; check the server state before doing anything else.',
  };
}

export default function StaleAccountingResolution({
  state,
  onRefresh,
}: {
  state: MicroLiveState;
  onRefresh: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const submitted = useRef(false);
  const resolution = useResolveStaleMicroLiveAccounting();
  const eligible = canResolveStaleAccounting(state);

  async function submit() {
    if (submitted.current || !eligible) return;
    submitted.current = true;
    setAttempted(true);
    setOutcome(null);
    try {
      const result = await resolution.mutateAsync({
        data: {
          expectedUnresolvedReason: EXPECTED_REASON,
          resolutionReason: RESOLUTION_REASON,
        },
      });
      setOutcome(result);
    } catch (error) {
      setOutcome(rejectedOutcome(error));
    } finally {
      setConfirming(false);
      await onRefresh();
    }
  }

  return (
    <div className="rounded-[12px] border border-[#d6d0c1] bg-[#f8f5ed] p-4 sm:p-5" data-testid="card-stale-accounting-resolution">
      <div className="flex items-center gap-2">
        <LockKeyhole size={14} className="text-[#765014]" />
        <h3 className="mono text-[10px] font-bold uppercase tracking-[.13em] text-[#765014]">Development-only accounting review</h3>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-[#596271]">
        Recorded accounting reason: <span className="font-semibold break-all text-[#303b4e]" data-testid="text-accounting-unresolved-reason">{state.accountingUnresolvedReason ?? 'none'}</span>
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-[#596271]">
        This is not an execution control. The server must recheck complete primary-account history and an empty bot ledger.
      </p>
      <button
        type="button"
        data-testid="button-resolve-stale-accounting"
        disabled={!eligible || attempted || resolution.isPending}
        onClick={() => setConfirming(true)}
        className="mt-3 w-full rounded-[8px] border border-[#bda762] bg-[#eee6c4] px-4 py-3 text-[12px] font-bold text-[#554919] hover:bg-[#e9dcaa] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
      >
        Resolve stale accounting flag
      </button>
      {!eligible && !attempted && (
        <p className="mt-2 text-[10px] text-[#765014]" data-testid="status-accounting-resolution-ineligible">
          Available only when this exact startup flag is unresolved and all execution gates are frozen.
        </p>
      )}
      {outcome && (
        <p
          role="status"
          data-testid="status-accounting-resolution-result"
          className={`mt-3 rounded-[8px] p-3 text-[11px] leading-relaxed ${outcome.status === 'resolved' ? 'bg-[#e5efae] text-[#40520c]' : 'bg-[#fae2dc] text-[#8e3127]'}`}
        >
          <strong>{outcome.status === 'resolved' ? 'Resolved' : outcome.status === 'blocked' ? 'Blocked' : 'Not confirmed'}:</strong>{' '}
          {outcome.reason}{outcome.decisionId ? ` · Audit decision ${outcome.decisionId}` : ''}
          {outcome.status !== 'resolved' && ' No automatic retry was made.'}
        </p>
      )}
      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#222a3d]/70 p-4" role="presentation">
          <div role="dialog" aria-modal="true" aria-labelledby="accounting-resolution-title" className="w-full max-w-[430px] rounded-[18px] border border-[#d6d0c1] bg-[#f8f5ed] p-5 shadow-[0_22px_60px_rgba(22,29,43,.28)] sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <AlertTriangle size={20} className="text-[#765014]" />
              <button type="button" data-testid="button-close-accounting-resolution" aria-label="Close accounting confirmation" onClick={() => setConfirming(false)} disabled={resolution.isPending} className="text-[#858a92] disabled:opacity-50"><X size={18} /></button>
            </div>
            <h3 id="accounting-resolution-title" className="mt-4 text-[20px] font-extrabold text-[#222a3d]">Clear the stale accounting flag?</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-[#596271]">
              This sends one admin request. The server will freshly verify complete primary-account history, no local bot activity or reservations, and unchanged frozen gates. If every check passes, it records your decision and clears only the accounting flag and reason. It does not enable trading.
            </p>
            <p className="mt-3 text-[11px] leading-relaxed text-[#596271]" data-testid="text-accounting-resolution-stated-reason">
              <strong>Recorded reason:</strong> {RESOLUTION_REASON}
            </p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" data-testid="button-cancel-accounting-resolution" disabled={resolution.isPending} onClick={() => setConfirming(false)} className="rounded-[8px] border border-[#d6d0c1] px-4 py-3 text-[12px] font-bold text-[#303b4e] disabled:opacity-50">Keep current state</button>
              <button type="button" data-testid="button-confirm-accounting-resolution" disabled={!eligible || attempted || resolution.isPending} onClick={() => void submit()} className="rounded-[8px] bg-[#34460b] px-4 py-3 text-[12px] font-bold text-white disabled:opacity-50">{resolution.isPending ? 'Checking and recording…' : 'Confirm accounting review'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}