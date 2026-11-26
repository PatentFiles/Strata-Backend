import type {OfflineBudgetPreviewInput} from "./entryBudgetChoice";
import {readCurrentPersistedBudgetChoice,type BudgetChoiceQuery} from "./persistedEntryBudgetChoice";
/** Staging-only reader. Invoke after locking the existing account in READ
 * COMMITTED on this specific client. No writer or live factory is installed. */
export async function readLockedSimulationBudgetSelection(
 q:BudgetChoiceQuery,scope:OfflineBudgetPreviewInput["currentScope"],
):Promise<(Pick<OfflineBudgetPreviewInput,"requestedChoice"|"choice"|"trustedBudgetApproval">&{selectionRevision:number})|null>{
 const {rows}=await q(`SELECT h.selection_revision,h.choice_id,h.choice_revision,b.gross_cents
 FROM private.strata_entry_budget_selection_history h
 JOIN private.strata_entry_budget_choices b ON b.account_id=h.account_id AND b.choice_id=h.choice_id
 AND b.choice_revision=h.choice_revision AND b.owner_user_id=h.owner_user_id
 WHERE h.account_id=$1 AND h.owner_user_id=$2 AND current_setting('transaction_isolation')='read committed'
 ORDER BY h.selection_revision DESC LIMIT 1`,[scope.accountId,scope.ownerId]);
 const r=rows[0];if(!r)return null;
 const revision=Number(r.selection_revision),gross=Number(r.gross_cents);
 if(!Number.isSafeInteger(revision)||revision<1||!Number.isSafeInteger(gross))return null;
 const available=await readCurrentPersistedBudgetChoice(q,scope,gross);
 if(!available||available.choice.choiceId!==r.choice_id||available.choice.choiceRevision!==r.choice_revision)return null;
 return Object.freeze({...available,selectionRevision:revision,
  requestedChoice:Object.freeze({choiceId:available.choice.choiceId,choiceRevision:available.choice.choiceRevision})});
}
