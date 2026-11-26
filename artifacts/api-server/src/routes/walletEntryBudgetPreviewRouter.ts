import { Router, type RequestHandler } from 'express';
import { describeApprovedEntryBudgetFunding, previewApprovedEntryBudget, WALLET_ENTRY_BUDGET_LADDER, type OfflineBudgetPreviewInput } from '../lib/entryBudgetChoice';

export const WALLET_ENTRY_BUDGET_PATH = '/api/strata/me/wallet/entry-budget-preview';
export { WALLET_ENTRY_BUDGET_LADDER };

export type WalletEntryBudgetPreviewDeps = Readonly<{
  deployment: 'isolated-staging' | 'disabled';
  requireOwnerAal2: RequestHandler;
  /** Trusted only, scope lookup must start with the authenticated subject and no caller account ID. */
  readApprovedChoice: (subject: string, grossCents: number) => Promise<OfflineBudgetPreviewInput|null>;
}>;

/** Intentionally not mounted from production router. Does not contain a database or signer. */
export function createWalletEntryBudgetPreviewRouter(deps: WalletEntryBudgetPreviewDeps) {
  const router = Router();
  router.all(WALLET_ENTRY_BUDGET_PATH, (req,res,next) => {
    res.setHeader('Cache-Control','private, no-store');
    if (deps.deployment !== 'isolated-staging' ||
        process.env.RAILWAY_ENVIRONMENT_NAME?.toLowerCase() === 'production' ||
        process.env.STRATA_RUNTIME_ENV?.toLowerCase() === 'production') {
      return void res.status(404).end();
    }
    if (req.method !== 'GET') return void res.status(405).end();
    return next();
  }, deps.requireOwnerAal2, async (req,res) => {
    const subject: unknown = res.locals.strata?.subject;
    if (typeof subject !== 'string' || !subject) return void res.status(401).end();
    const raw = req.query.grossCents;
    const gross = typeof raw === 'string' && /^[1-9][0-9]{2,4}$/.test(raw) ? Number(raw) : 0;
    if (req.get('X-Strata-Read-Intent') !== 'preview-entry-budget' || Object.keys(req.query).length !== 1 ||
        !WALLET_ENTRY_BUDGET_LADDER.some(c => c === gross) || req.get('Transfer-Encoding') ||
        Number(req.get('Content-Length') ?? 0) !== 0) return void res.status(400).end();
    const unavailable = {ok:false,reason:'entry_budget_choice_not_available',readOnly:true,tradingAuthorized:false};
    try {
      const candidate = await deps.readApprovedChoice(subject,gross);
      if (!candidate || candidate.currentScope.ownerId !== subject || candidate.choice.grossCents !== gross) {
        return void res.status(409).json(unavailable);
      }
      const funding = describeApprovedEntryBudgetFunding(candidate);
      if (!funding) return void res.status(409).json(unavailable);
      const preview = previewApprovedEntryBudget(candidate);
      return void res.status(200).json({
        ok:true,readOnly:true,tradingAuthorized:false,grossCents:candidate.choice.grossCents,
        allInCents:candidate.choice.allInCents,funding,plan:preview.ok
          ? {requestedContracts:preview.requestedContracts,modeledGrossCents:preview.modeledGrossCents,
             modeledAllInCents:preview.modeledAllInCents}
          : null,
      });
    } catch {
      return void res.status(409).json(unavailable);
    }
  });
  return router;
}
