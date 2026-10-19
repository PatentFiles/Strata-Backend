-- Renewal of independently signed KXBTC15M fee model reviews.
-- Preserve every existing signed review and require a new authenticated
-- review record after expiry or revocation. This migration issues NO reviews,
-- fee grants, consent, trading authority, or execution orders.
BEGIN;
ALTER TABLE private.strata_api_fee_rate_reviews
  DROP CONSTRAINT IF EXISTS strata_api_fee_rate_reviews_owner_user_id_reviewer_user_id__key;
CREATE UNIQUE INDEX IF NOT EXISTS strata_api_fee_review_signed_event
 ON private.strata_api_fee_rate_reviews
 (owner_user_id, reviewer_user_id, rate_decision_digest, signed_at);
COMMIT;
