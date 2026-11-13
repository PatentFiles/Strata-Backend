# Owned worker discovery runtime fix

This candidate changes runtime worker.ts. Earlier qualification receipts for tree
333cad4374f362df97b7a8684827f697f2207f48 do not qualify this new source tree.
The older test-only documents describe their original frozen candidate only.

Owned discovery previously returned already-attempted qualifying evaluations.
prepareEntry performs provider market/book work before the locked duplicate
lookup; non-PREPARED intents then cannot dispatch again. The candidate removes
those known duplicate evaluations/crossings before the bounded discovery limit,
using two account-bound predicates matching existing unique indexes. PREPARED
intents remain discoverable. No schema change is needed.

The unchanged locked duplicate lookup and PREPARED-only dispatch claim still
resolve races. This optimization cannot eliminate every redundant read: an
intent can change after discovery, or multiple rows can share a crossing in one
tick. It does not supply authority, skip reconciliation or protection, change
source timestamps or relax the original five-second policy.

The new native tests execute actual worker discovery SQL with temporary tables,
but stub reconciliation, preparation and dispatch. They cover query inclusion,
exclusion, account isolation, index-key matching and LIMIT placement; they are
not proof of actual dispatch, financial gates or race safety. Separate existing
real-executor and native financial coverage must remain intact.

Before this runtime candidate is called qualified, run the native tests against
unchanged baseline worker.ts to reproduce the expected regression, then against
the candidate. Run normal build and applicable/full safety checks on the exact
candidate tree and retain independent review. Do not carry forward the old
full-suite PASS as if it already covered this runtime edit.

This known wasted-work path is not established as the historical 22:15 stale
signal's root cause. The ts-only timestamp compatibility fix is already in main,
but the original 22:57 failing provider row was not obtained. The default-off
same-session recovery feature remains off unless separately qualified and
explicitly activated. This patch does not change any feature flag or runtime
account, submit orders, publish source or authorize deployment.
