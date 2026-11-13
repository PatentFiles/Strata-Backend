import { useState } from 'react';
import { useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetMicroLiveFeeApprovalQueryKey,
  useGetMicroLiveFeeApproval,
  useReviewMicroLiveFeePdf,
  useApproveMicroLiveFeePdf,
  useRevokeMicroLiveFeeApproval,
} from '@workspace/api-client-react';

export default function MicroLiveFeeApproval() {
  const { userId } = useAuth();
  const cache = useQueryClient();
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queryKey = [...getGetMicroLiveFeeApprovalQueryKey(), userId];
  const { data, error, refetch } = useGetMicroLiveFeeApproval({
    query: { enabled: !!userId, queryKey, refetchInterval: 5000, retry: false },
  });
  const review = useReviewMicroLiveFeePdf();
  const approve = useApproveMicroLiveFeePdf();
  const revoke = useRevokeMicroLiveFeeApproval();
  const reviewIdentity = data?.status === 'review' ? `${data.reviewId}:${data.digest}` : null;

  async function upload(file: File | undefined) {
    setMessage(null);
    setAcknowledgedFor(null);
    if (!file || file.type !== 'application/pdf' || file.size > 2_000_000) {
      setMessage('Choose a PDF smaller than 2 MB.');
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the PDF'));
        reader.readAsDataURL(file);
      });
      const pdfBase64 = dataUrl.split(',')[1];
      if (!pdfBase64) throw new Error('Could not read the PDF');
      await review.mutateAsync({ data: { pdfBase64 } });
      await cache.invalidateQueries({ queryKey: getGetMicroLiveFeeApprovalQueryKey() });
      await refetch();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'PDF review failed. No approval was issued.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!reviewIdentity || acknowledgedFor !== reviewIdentity || !data?.reviewId || !data.digest) return;
    setBusy(true);
    setMessage(null);
    try {
      await approve.mutateAsync({ data: { reviewId: data.reviewId, digest: data.digest } });
      setAcknowledgedFor(null);
      await cache.invalidateQueries({ queryKey: getGetMicroLiveFeeApprovalQueryKey() });
      await refetch();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Review expired or changed. No approval was issued.');
    } finally {
      setBusy(false);
    }
  }

  async function revokeStandingApproval() {
    if (!window.confirm('Revoke the standing fee-policy approval? Future live-order fee checks will fail closed until a new review is approved.')) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await revoke.mutateAsync({ data: { confirm: true } });
      setAcknowledgedFor(null);
      await cache.invalidateQueries({ queryKey: getGetMicroLiveFeeApprovalQueryKey() });
      await refetch();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The standing fee policy could not be revoked.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[12px] border border-[#d6d0c1] bg-white p-4 sm:p-5">
      <p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#858a92]">Standing fee-policy approval</p>
      <h3 className="mt-2 text-[16px] font-extrabold text-[#303b4e]">Upload Kalshi’s current official fee-schedule PDF</h3>
      <p className="mt-2 text-[11px] leading-relaxed text-[#596271]">The uploaded PDF is reviewed locally, then the server verifies its exact bytes and formula against Kalshi’s pinned official PDF using bounded read-only GETs. Eligibility is not inferred from a missing ticker name: the PDF must explicitly map the standard rule to all markets or KXBTC15M. Unmapped special- or product-specific fees block approval. Every persisted approval read rechecks the source; a read-only monitor also checks every five minutes and revokes the exact approval if the artifact is unavailable, changed, or cannot be parsed. The 10-minute review is temporary. A verified, explicitly approved, versioned standing policy has no time-based expiry. Every order must still pass a fresh live fee/market check (verified data no more than 15 seconds old at submission) and fit the fee-inclusive $5.00 cap. Approval never enables execution or places an order.</p>
      <label className="mt-4 block text-[11px] font-bold text-[#303b4e]">
        Fee-schedule PDF
        <input data-testid="input-micro-live-fee-pdf" type="file" accept="application/pdf,.pdf" disabled={busy} onChange={(event) => void upload(event.currentTarget.files?.[0])} className="mt-2 block w-full rounded border border-[#d6d0c1] p-2 text-[11px]" />
      </label>
      {error && <p data-testid="status-micro-live-fee-approval-error" role="alert" className="mt-3 text-[11px] text-[#a34032]">Approval state unavailable. No approval is inferred.</p>}
      {data && (
        <div className="mt-4 space-y-2 rounded border border-[#d6d0c1] bg-[#f8f5ed] p-3 text-[11px] text-[#303b4e]">
          <p data-testid="status-micro-live-fee-policy"><strong>Status:</strong> {
            data.status === 'approved' ? 'Standing policy approved' :
              data.status === 'review' ? 'Temporary review awaiting approval' : 'No standing policy approved'
          }</p>
          {(data.sourceUrl || data.artifactStatus !== 'unverified') && (
            <div data-testid="status-micro-live-fee-artifact" className="rounded border border-[#d6d0c1] bg-white p-3">
              <p><strong>Canonical artifact verification:</strong> {data.artifactStatus}</p>
              {data.sourceUrl && <p className="break-all"><strong>Fixed source:</strong> <a className="underline" href={data.sourceUrl} target="_blank" rel="noreferrer">{data.sourceUrl}</a></p>}
              {data.formulaVersion && <p><strong>Formula version:</strong> {data.formulaVersion}</p>}
              {data.artifactCheckedAt && <p><strong>Last checked:</strong> {new Date(data.artifactCheckedAt).toLocaleString()}</p>}
              {data.artifactReason && <p role="status" className="text-[#a34032]"><strong>Verification detail:</strong> {data.artifactReason}</p>}
              {data.status === 'approved' && data.artifactStatus !== 'verified' && (
                <p role="alert" className="font-bold text-[#a34032]">Canonical source is not currently verified. Live authorization is fail-closed.</p>
              )}
            </div>
          )}
          {data.status !== 'none' && (
            <>
              <p><strong>Effective date shown in PDF:</strong> {data.effectiveDate}</p>
              <p><strong>PDF fee rule for KXBTC15M:</strong> {data.feeRule}</p>
              <div className="rounded border border-[#dfb86c] bg-[#fbf3df] p-3 leading-relaxed text-[#634f35]">
                <strong>Separate safety bound (not the PDF’s centicent rounding rule):</strong> For entry-loss calculations, each possible 0.01-contract fill’s combined purchase cost and fee is bounded up to the next <strong>$0.01</strong>. Kalshi’s <a className="underline" href="https://docs.kalshi.com/getting_started/fee_rounding" target="_blank" rel="noreferrer">rounding documentation</a> distinguishes $0.0001 balance precision for direct members from $0.01 for non-direct members. We assume the coarser precision, up to 100 separate fills per whole contract, and ignore any later rounding rebates. This deliberately conservative bound does not change Kalshi’s rule or enable trading.
              </div>
              <p><strong>PDF excerpt:</strong> {data.evidence}</p>
              <p className="mono break-all text-[9px]"><strong>PDF SHA-256:</strong> {data.digest}</p>
            </>
          )}
          {data.status === 'review' && (
            <p><strong>Review expires:</strong> {data.expiresAt ? new Date(data.expiresAt).toLocaleString() : '—'}</p>
          )}
          {data.status === 'approved' && (
            <>
              <p><strong>Approval:</strong> No expiry</p>
              <p><strong>Approved at:</strong> {data.approvedAt ? new Date(data.approvedAt).toLocaleString() : '—'}</p>
              <p data-testid="text-micro-live-fee-policy-version"><strong>Policy version:</strong> {data.policyVersion ?? 'Unavailable'}</p>
              <p><strong>Maximum fee-inclusive exposure:</strong> {data.maximumExposureMicros === null ? 'Unavailable' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(data.maximumExposureMicros / 1_000_000)}</p>
              <p data-testid="text-micro-live-fee-policy-approver"><strong>Approved by administrator:</strong> {data.approvedBy ?? 'Unavailable'}</p>
              <button data-testid="button-revoke-micro-live-fee-policy" type="button" disabled={busy} onClick={() => void revokeStandingApproval()} className="rounded border border-[#a34032] px-4 py-2 font-bold text-[#a34032] disabled:opacity-50">Revoke standing approval</button>
            </>
          )}
          {data.status === 'review' && (
            <>
              <label className="flex gap-2 leading-relaxed">
                <input data-testid="input-acknowledge-micro-live-fee-policy" type="checkbox" checked={acknowledgedFor === reviewIdentity} onChange={(event) => setAcknowledgedFor(event.target.checked ? reviewIdentity : null)} />
                I confirm this is Kalshi’s current official schedule, the displayed effective date and rule are correct, and I approve the displayed versioned fee policy as a standing authorization.
              </label>
              <button data-testid="button-approve-micro-live-fee-policy" type="button" disabled={acknowledgedFor !== reviewIdentity || busy} onClick={() => void confirm()} className="rounded bg-[#303b4e] px-4 py-2 font-bold text-white disabled:opacity-50">Approve standing fee policy</button>
            </>
          )}
        </div>
      )}
      {message && <p role="alert" className="mt-3 text-[11px] text-[#a34032]">{message}</p>}
    </div>
  );
}