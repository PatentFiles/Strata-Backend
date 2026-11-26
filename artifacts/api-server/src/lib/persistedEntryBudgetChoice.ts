import { ENTRY_BUDGET_CHOICE_VERSION, entryBudgetTermsDigest, WALLET_ENTRY_BUDGET_LADDER, type OfflineBudgetPreviewInput } from './entryBudgetChoice';

export type BudgetChoiceQuery = (sql:string,args:unknown[])=>Promise<{ rows:Record<string,unknown>[] }>;
type Scope = OfflineBudgetPreviewInput['currentScope'];
type TrustedObservation = Omit<OfflineBudgetPreviewInput,'requestedChoice'|'choice'|'trustedBudgetApproval'>;

/**
 * On a final simulation fence, pass a READ COMMITTED transaction-bound query, and invoke this
 * statement AFTER locking the account. Never use pool.query for that sequence. READ COMMITTED
 * and the approval writer's common account lock are prerequisites, not provided by this helper.
 */
export const READ_CURRENT_BUDGET_CHOICE_SQL = String.raw`
SELECT b.choice_id,b.choice_revision,b.gross_cents,b.all_in_cents,b.approval_digest,
  floor(extract(epoch from b.approved_at)*1000)::bigint AS approved_ms,
  floor(extract(epoch from b.expires_at)*1000)::bigint AS expiry_ms
FROM private.strata_entry_budget_choices b
JOIN public.v13_production_account a ON a.id=b.account_id AND a.owner_user_id::text=b.owner_user_id
  AND a.key_fingerprint=b.credential_fingerprint
JOIN public.v13_live_money_policy p ON p.id=a.policy_id AND p.policy_hash=b.policy_hash
  AND p.version=b.policy_revision AND p.state='APPROVED'
JOIN public.strata_configured_stake s ON s.execution_account_id=a.id AND s.revision=b.stake_revision
WHERE current_setting('transaction_isolation')='read committed'
AND b.gross_cents <= LEAST(p.max_entry_stake_cents,s.configured_stake_cents)
AND b.all_in_cents <= LEAST(p.capital_limit_cents,p.max_entry_all_in_cents)
AND b.owner_user_id=$1 AND b.account_id=$2 AND b.credential_fingerprint=$3
AND b.release_sha=$4 AND b.policy_hash=$5 AND b.policy_revision=$6 AND b.stake_revision=$7
AND b.fee_approval_id=$8 AND b.fee_approval_digest=$9 AND b.gross_cents=$10
AND b.approved_at <= statement_timestamp() AND b.expires_at > statement_timestamp() AND b.revoked_at IS NULL
AND NOT EXISTS (SELECT 1 FROM private.strata_entry_budget_choices newer WHERE
  newer.account_id=b.account_id AND newer.choice_id=b.choice_id AND newer.choice_revision>b.choice_revision)
LIMIT 2
`;

function integer(v:unknown):number|null {
  if(typeof v !== 'number' && (typeof v !== 'string'|| !/^[0-9]{1,16}$/.test(v)))return null;
  const n=Number(v);
  return Number.isSafeInteger(n)&&n>0?n:null;
}

export async function readCurrentPersistedBudgetChoice(
  q:BudgetChoiceQuery, scope:Scope, grossCents:number,
):Promise<Pick<OfflineBudgetPreviewInput,'choice'|'trustedBudgetApproval'>|null> {
  if(!WALLET_ENTRY_BUDGET_LADDER.some(n=>n===grossCents))return null;
  const {rows}=await q(READ_CURRENT_BUDGET_CHOICE_SQL,[
    scope.ownerId,scope.accountId,scope.credentialFingerprint,scope.releaseSha,scope.policyHash,
    scope.policyRevision,scope.stakeRevision,scope.feeApprovalId,scope.feeApprovalDigest,grossCents,
  ]);
  if(rows.length!==1)return null;
  const r=rows[0]!, choiceRevision=integer(r.choice_revision), allInCents=integer(r.all_in_cents),
    approvedAtMs=integer(r.approved_ms), expiresAtMs=integer(r.expiry_ms);
  const choiceId='gross-'+String(grossCents);
  if(choiceRevision===null || allInCents===null || allInCents<grossCents || approvedAtMs===null ||
    expiresAtMs===null || expiresAtMs<=approvedAtMs || integer(r.gross_cents)!==grossCents ||
    r.choice_id!==choiceId || typeof r.approval_digest!=='string')return null;
  const boundScope=Object.freeze({...scope});
  const choice=Object.freeze({version:ENTRY_BUDGET_CHOICE_VERSION,choiceId,choiceRevision,
    scope:boundScope,grossCents,allInCents,approvalDigest:r.approval_digest});
  if(entryBudgetTermsDigest(choice)!==choice.approvalDigest)return null;
  return Object.freeze({choice,trustedBudgetApproval:Object.freeze({
    approvalDigest:choice.approvalDigest,scope:boundScope,approvedAtMs,expiresAtMs,revokedAtMs:null,
  })});
}

/** Bind to Wallets GET only after authenticated subject and staging route guard. No write port. */
export function createPersistedBudgetChoiceReader(deps:Readonly<{
  query:BudgetChoiceQuery;
  loadTrustedObservation:(authenticatedSubject:string)=>Promise<TrustedObservation|null>;
}>) {
  return async (subject:string,grossCents:number):Promise<OfflineBudgetPreviewInput|null>=>{
    const observed=await deps.loadTrustedObservation(subject);
    if(!observed||observed.currentScope.ownerId!==subject)return null;
    const record=await readCurrentPersistedBudgetChoice(deps.query,observed.currentScope,grossCents);
    if(!record)return null;
    return {...observed,...record,requestedChoice:{choiceId:record.choice.choiceId,choiceRevision:record.choice.choiceRevision}};
  };
}
