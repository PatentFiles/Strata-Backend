-- Complete the trusted API-only RLS boundary for the additive bot selection.
-- RLS without these policies silently blocks a non-BYPASSRLS backend role,
-- even when SQL GRANT is present. Never grant browser/paper capabilities.
BEGIN;
SET LOCAL lock_timeout='1500ms';
SET LOCAL statement_timeout='12000ms';
DO $bot_rls$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='strata_api_runtime') THEN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='private' AND tablename='strata_owner_bot_selection'
     AND policyname='strata_owner_bot_selection_api') THEN
   EXECUTE 'CREATE POLICY strata_owner_bot_selection_api ON private.strata_owner_bot_selection FOR ALL TO strata_api_runtime USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='private' AND tablename='strata_owner_bot_selection_history'
     AND policyname='strata_owner_bot_selection_history_api') THEN
   EXECUTE 'CREATE POLICY strata_owner_bot_selection_history_api ON private.strata_owner_bot_selection_history FOR ALL TO strata_api_runtime USING (true) WITH CHECK (true)';
  END IF;
 END IF;
END $bot_rls$;
COMMIT;
