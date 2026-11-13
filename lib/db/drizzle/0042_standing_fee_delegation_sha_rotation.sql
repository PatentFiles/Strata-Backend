-- Issue #165 / #154: a reviewed fee model and delegated observation lease are
-- deliberately scoped to the deployed backend SHA. The original unique
-- (owner_user_id,grant_id) constraint prevented a new owner consent after a
-- deployment, even when a new independently signed model existed for that SHA.
--
-- Preserve all historic approvals, revocations, and approved policy/grant IDs.
-- Keep at most ONE non-revoked delegation per owner, original grant, and SHA.
-- No owner consent is issued here; each new SHA requires fresh authenticated
-- technical review, owner consent and real Kalshi fee observations.
--
-- A new index is established BEFORE removing the obsolete unique constraint.
-- PostgreSQL transactional DDL rolls both changes back if either fails.
CREATE UNIQUE INDEX owner_fee_delegation_active_sha_unique
  ON private.strata_api_fee_standing_delegations
  (owner_user_id,grant_id,release_commit_sha)
  WHERE revoked_at IS NULL;

ALTER TABLE private.strata_api_fee_standing_delegations
  DROP CONSTRAINT owner_fee_delegation_scope_unique;
