import { useState } from 'react';
import { useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetMicroLiveFeeApprovalQueryKey,
  getGetMicroLiveStateQueryKey,
  useArmMicroLiveBoundedRun,
  useGetMicroLiveFeeApproval,
  usePrepareNextMicroLiveBoundedRun,
  useResumeMicroLiveBoundedExit,
} from '@workspace/api-client-react';
import type { MicroLiveBoundedRunState } from '@workspace/api-client-react';

export default function MicroLiveBoundedRun({ run }: { run: MicroLiveBoundedRunState }) {
  const { userId } = useAuth();
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [prepareReason, setPrepareReason] = useState(
    'Prepare the next bounded development run after confirming the prior run is frozen and unused.',
  );
  const fee = useGetMicroLiveFeeApproval({
    query: {
      enabled: Boolean(userId),
      queryKey: [...getGetMicroLiveFeeApprovalQueryKey(), userId],
      refetchInterval: 5000,
      retry: false,
    },
  });
  const arm = useArmMicroLiveBoundedRun();
  const prepareNext = usePrepareNextMicroLiveBoundedRun();
  const resume = useResumeMicroLiveBoundedExit();
  const busy = arm.isPending || resume.isPending || prepareNext.isPending;
  const armableSlot = run.phase === 'UNARMED' && !run.runId;
  const preparedSlot = run.phase === 'UNARMED' && Boolean(run.runId);
  const possibleNewRun = run.phase === 'FROZEN' && Boolean(run.runId) &&
    Boolean(run.armedAt && run.freezeReason) &&
    !run.entryAttempted && !run.exitAttempted;
  const possibleExit = run.phase === 'FROZEN' && Boolean(run.runId) &&
    (run.entryAttempted || run.exitAttempted) && !possibleNewRun;

  async function submit(action: 'arm' | 'resume' | 'prepare-next') {
    if (!confirmed || busy) return;
    setMessage(null);
    try {
      const result = action === 'arm'
        ? await arm.mutateAsync({ data: { confirm: true } })
        : action === 'resume'
          ? await resume.mutateAsync({ data: { confirm: true } })
          : await prepareNext.mutateAsync({
            data: { confirm: true, priorRunId: run.runId!, reason: prepareReason.trim() },
          });
      setMessage(result.reason);
      setConfirmed(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The server blocked this action. No order was requested.');
    } finally {
      await queryClient.invalidateQueries({ queryKey: getGetMicroLiveStateQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getGetMicroLiveFeeApprovalQueryKey() });
    }
  }

  return (
    <div className="mt-4 rounded-[12px] border border-[#d6d0c1] bg-white p-4 sm:p-5" data-testid="micro-live-bounded-run">
      <h3 className="text-[16px] font-extrabold text-[#303b4e]">One-use development run</h3>
      <p className="mt-2 text-[11px] leading-relaxed text-[#596271]">
        Arming does not submit an order. The server must verify its own active fee approval and every prerequisite.
        Only a new post-arming SCOUT may be considered. One entry, at most one exit, and the displayed per-run modeled all-in limit apply.
        This does not isolate the shared account or cap whole-account losses.
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-[11px] text-[#303b4e]">
        <div><dt className="font-bold">Run phase</dt><dd>{run.phase ?? 'Unavailable — blocked'}</dd></div>
        <div><dt className="font-bold">Elapsed-time expiry</dt><dd>{run.entryDeadlineAt ? 'Historical only — not enforced' : 'None; phase and safety conditions govern'}</dd></div>
        <div><dt className="font-bold">Entry / exit attempted</dt><dd>{run.entryAttempted ? 'Yes' : 'No'} / {run.exitAttempted ? 'Yes' : 'No'}</dd></div>
        <div><dt className="font-bold">Freeze reason</dt><dd>{run.freezeReason ?? '—'}</dd></div>
        <div><dt className="font-bold">Fee approval in this API</dt><dd>{fee.isError ? 'Unavailable' : fee.data?.status ?? 'Checking…'}</dd></div>
        <div><dt className="font-bold">Approval expires</dt><dd>{fee.data?.expiresAt ? new Date(fee.data.expiresAt).toLocaleString() : '—'}</dd></div>
      </dl>
      {(armableSlot || possibleExit || possibleNewRun) && (
        <>
          <label className="mt-4 flex items-start gap-2 text-[11px] leading-relaxed text-[#303b4e]">
            <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />
            I understand this action changes development execution readiness only after server-side validation; it does not place an order.
          </label>
          {armableSlot && (
            <button type="button" disabled={!confirmed || fee.data?.status !== 'approved' || busy}
              onClick={() => void submit('arm')}
              className="mt-3 rounded bg-[#303b4e] px-4 py-2 text-[11px] font-bold text-white disabled:opacity-50"
              data-testid="button-arm-bounded-run">
              {arm.isPending ? 'Checking and arming…' : 'Check and arm one run'}
            </button>
          )}
          {possibleExit && (
            <button type="button" disabled={!confirmed || busy}
              onClick={() => void submit('resume')}
              className="mt-3 rounded bg-[#303b4e] px-4 py-2 text-[11px] font-bold text-white disabled:opacity-50"
              data-testid="button-resume-bounded-exit">
              {resume.isPending ? 'Reconciling…' : 'Check exit-only recovery'}
            </button>
          )}
          {possibleNewRun && (
            <div className="mt-3 rounded border border-[#dfded3] bg-[#f8f5ed] p-3">
              <p className="text-[11px] leading-relaxed text-[#596271]">
                This audited transition archives a frozen, unused $1-cap run unchanged and prepares a separate
                $5 all-in-cap development slot. No elapsed-time expiry is required. It leaves the new slot UNARMED.
                It does not approve fees or place an order; any claimed attempt, reservation, or ledger evidence blocks the transition.
              </p>
              <label className="mt-3 block text-[10px] font-bold text-[#303b4e]" htmlFor="prepare-next-run-reason">
                Audit reason
              </label>
              <textarea id="prepare-next-run-reason" value={prepareReason}
                onChange={event => setPrepareReason(event.target.value)} disabled={busy}
                maxLength={512} minLength={16} rows={3}
                className="mt-1 w-full rounded border border-[#d6d0c1] bg-white p-2 text-[11px] text-[#303b4e]"
                data-testid="input-prepare-next-run-reason" />
              <button type="button" disabled={!confirmed || busy || prepareReason.trim().length < 16}
                onClick={() => void submit('prepare-next')}
                className="mt-3 rounded bg-[#303b4e] px-4 py-2 text-[11px] font-bold text-white disabled:opacity-50"
                data-testid="button-prepare-next-bounded-run">
                {prepareNext.isPending ? 'Archiving and preparing…' : 'Prepare next run — do not arm'}
              </button>
            </div>
          )}
        </>
      )}
      {preparedSlot && (
        <p className="mt-3 text-[11px] leading-relaxed text-[#765014]">
          This $5 slot remains UNARMED and cannot yet be armed through the live path.
          Mocked exit and restart-recovery checks passed, but real-exchange reduce-only exit behavior
          and handling of a partial exit remain unproven. Preparation did not approve fees or submit an order.
        </p>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-[#596271]">
        Current run cap: ${(run.capMicros / 1_000_000).toFixed(2)} all-in. Archived run identity, approval, cap,
        attempt claims, and order history are never repurposed. Approval expiry closes entry eligibility, but elapsed time alone does not.
        Frozen phases, reconciliation, lease ownership, account identity, and all execution gates still apply. A filled position may be managed only after complete reconciliation
        and fresh, unchanged exchange fee terms within its original reserved exit debit. Emergency stop always blocks submissions.
      </p>
      {message && <p className="mt-3 text-[11px] text-[#765014]" role="status">{message}</p>}
    </div>
  );
}