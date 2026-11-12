# Operator checklist: approval-only candidate, NOT authorized for production

This document is preparation, not instruction to perform a production change now.
Any failed or missing acceptance item stops the cutover. No step permits bypassing
independent review, signed reconciliation, risk, kill, fee or trading authorization.

1. Freeze reviewed artifacts. Verify backend base48783da92ffc979dae6df4e01638399e9d6841a3;
   identify current deployed source separately. Verify frontend pinned base
   23a3d630dfe3a0b3bf588b4b37fa1b1bd2e3a49a and publish provenance separately.
   The UI patch is incremental to earlier stopped-approval candidate, not a
   standalone patch to arbitrary deployed frontend. Do not guess the review SHA.
2. Have independent reviewer sign off exact resulting release and migration,
   not only patch hashes. Resolve runtime identity and full role/privilege test.
   Existing metadata-only session endpoint is documented but has NOT been invoked
   in this work; prior access denial must not be routed around.
3. Identify every credential-bearing writer and deployment: approval insertions,
   all5revokers, qualification, account provisioning, SQL/functions/jobs/CI and
   external tools. Record exact old/new versions and owners. Unknown writer blocks.
4. Obtain explicit operator authorization for the actual maintenance/deployment
   actions and any security-sensitive change. Confirm separately authorized current
   financial safety evidence. Do not interrupt active protective duties.
5. Exclude new relevant requests, stop/retire old writer processes through the
   approved maintenance procedure and prove in-flight work is finished/rolled back.
   A UI banner, account kill or ordinary rolling restart is insufficient. Source
   contains no demonstrated complete admission/drain barrier.
6. While proven quiescent, approved operator applies the exact reviewed atomic SQL
   with intended owner. Preserve receipts, history, revocations and audit. Existing
   accounts receive epoch1; it is not represented as a human revocation event.
7. Approved operator deploys compatible backend and frontend as one coordinated
   cutover. No old writer may resume; prohibit mixed-version traffic. Verify exact
   resulting release hashes, migration/trigger presence and role behavior using
   specifically permitted bounded checks. No approval is auto-submitted.
8. Reopen compatible request traffic only when all above evidence is recorded.
   Get new qualification where required. The approval-only route may record exact
   owner code consent but must leave account/worker killed and disabled. Inspect
   exact receipt/QID/pin/generation readback; uncertain write requires GET readback,
   not blind resubmission.
9. Independent technical approval, durable fee/standing consent, actual financial
   release and owner START remain separate prerequisites. Do not announce live
   readiness solely because code-consent receipt exists. User executes financial
   enablement/START where required; this checklist never authorizes it.
10. Rollback: keep relevant writers quiesced. Preserve generation/tombstones/audit;
    use reviewed compatible rollback or forward fix. Never drop guards, reset heads
    or resurrect old processes to make a failed rollback appear successful.

Current evidence:91 main PostgreSQL tests;13 actual policy-workflow tests; local
role-model test;29 UI tests;11 route/sanitizer/invariant checks; backend/frontend
TypeScript and frontend build. These are isolated results, not production proof.
Remaining: actual runtime identity, external writer exclusion, deployed artifact
provenance, reviewer acceptance and operational cutover proof. No successful live
START has been claimed or performed.
