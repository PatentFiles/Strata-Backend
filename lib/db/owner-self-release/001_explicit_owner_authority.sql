-- Explicit product-policy migration candidate. No existing reviews/grants are
-- converted or renewed; no account flags, workers, fees or orders are changed.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='5000ms';
ALTER TABLE private.strata_standing_execution_reviews ADD COLUMN review_authority text NOT NULL DEFAULT 'INDEPENDENT_V1', ADD COLUMN owner_authorizer_id uuid REFERENCES auth.users(id);
ALTER TABLE private.strata_continuous_execution_grants ADD COLUMN review_authority text NOT NULL DEFAULT 'INDEPENDENT_V1', ADD COLUMN owner_authorizer_id uuid REFERENCES auth.users(id);
DO $$ DECLARE rel regclass;n integer;name text;
BEGIN
 FOREACH rel IN ARRAY ARRAY['private.strata_standing_execution_reviews'::regclass,'private.strata_continuous_execution_grants'::regclass] LOOP
  SELECT count(*),min(conname) INTO n,name FROM pg_constraint WHERE conrelid=rel AND contype='c'
   AND position('independent_reviewer_id <> owner_user_id' in pg_get_constraintdef(oid))>0;
  IF n<>1 THEN RAISE EXCEPTION 'expected_independent_identity_constraint_missing'; END IF;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',rel,name);
 END LOOP;
 SELECT count(*),min(conname) INTO n,name FROM pg_constraint WHERE conrelid='private.strata_standing_execution_reviews'::regclass AND contype='c'
  AND position('I_INDEPENDENTLY_APPROVE_STANDING_ENTRIES_AND_REDUCE_ONLY_EXITS_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1' in pg_get_constraintdef(oid))>0;
 IF n<>1 THEN RAISE EXCEPTION 'expected_independent_confirmation_constraint_missing'; END IF;
 EXECUTE format('ALTER TABLE private.strata_standing_execution_reviews DROP CONSTRAINT %I',name);
END $$;
ALTER TABLE private.strata_standing_execution_reviews ALTER COLUMN independent_reviewer_id DROP NOT NULL;
ALTER TABLE private.strata_continuous_execution_grants ALTER COLUMN independent_reviewer_id DROP NOT NULL;
ALTER TABLE private.strata_standing_execution_reviews ADD CONSTRAINT standing_explicit_authority CHECK(
 (review_authority='INDEPENDENT_V1' AND independent_reviewer_id IS NOT NULL AND independent_reviewer_id<>owner_user_id AND owner_authorizer_id IS NULL
  AND confirmation='I_INDEPENDENTLY_APPROVE_STANDING_ENTRIES_AND_REDUCE_ONLY_EXITS_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1')
 OR (review_authority='OWNER_SELF_V1' AND independent_reviewer_id IS NULL AND owner_authorizer_id IS NOT NULL AND owner_authorizer_id=owner_user_id
  AND confirmation='I_AUTHORIZE_OWNER_ONLY_STANDING_EXECUTION_FOR_THIS_EXACT_SHA_ACCOUNT_POLICY_V1'));
ALTER TABLE private.strata_continuous_execution_grants ADD CONSTRAINT grant_explicit_authority CHECK(
 (review_authority='INDEPENDENT_V1' AND independent_reviewer_id IS NOT NULL AND independent_reviewer_id<>owner_user_id AND owner_authorizer_id IS NULL)
 OR (review_authority='OWNER_SELF_V1' AND independent_reviewer_id IS NULL AND owner_authorizer_id IS NOT NULL AND owner_authorizer_id=owner_user_id));
COMMIT;
