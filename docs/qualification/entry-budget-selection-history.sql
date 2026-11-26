-- REVIEW CANDIDATE / DISPOSABLE STAGING ONLY. No setup or grant in app startup.
CREATE TABLE private.strata_entry_budget_selection_history (
 account_id text NOT NULL,
 owner_user_id text NOT NULL,
 selection_revision integer NOT NULL CHECK(selection_revision>0),
 choice_id text NOT NULL,
 choice_revision integer NOT NULL CHECK(choice_revision>0),
 selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_id,selection_revision),
 FOREIGN KEY(account_id,choice_id,choice_revision)
  REFERENCES private.strata_entry_budget_choices(account_id,choice_id,choice_revision)
);
ALTER TABLE private.strata_entry_budget_selection_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.strata_entry_budget_selection_history FROM PUBLIC, anon, authenticated;
CREATE FUNCTION private.fence_entry_budget_selection_history()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,private AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'entry budget selection history is append only'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'entry budget selection requires READ COMMITTED';
 END IF;
 -- Same account row as authority writer and simulated executor.
 PERFORM 1 FROM public.v13_production_account a
  WHERE a.id=NEW.account_id AND a.owner_user_id::text=NEW.owner_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'entry budget selection account unverified'; END IF;
 IF NEW.selected_at>clock_timestamp() OR EXISTS(
   SELECT 1 FROM private.strata_entry_budget_selection_history
    WHERE account_id=NEW.account_id AND selection_revision>=NEW.selection_revision
 ) THEN RAISE EXCEPTION 'entry budget selection revision must increase'; END IF;
 PERFORM 1 FROM private.strata_entry_budget_choices b
  WHERE b.account_id=NEW.account_id AND b.owner_user_id=NEW.owner_user_id
    AND b.choice_id=NEW.choice_id AND b.choice_revision=NEW.choice_revision AND b.revoked_at IS NULL
    AND b.approved_at<=clock_timestamp() AND b.expires_at>clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM private.strata_entry_budget_choices n WHERE
       n.account_id=b.account_id AND n.choice_id=b.choice_id AND n.choice_revision>b.choice_revision);
 IF NOT FOUND THEN RAISE EXCEPTION 'entry budget selection approval unverified'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.fence_entry_budget_selection_history() FROM PUBLIC;
CREATE TRIGGER strata_entry_budget_selection_row BEFORE INSERT OR UPDATE OR DELETE
 ON private.strata_entry_budget_selection_history FOR EACH ROW EXECUTE FUNCTION private.fence_entry_budget_selection_history();
CREATE TRIGGER strata_entry_budget_selection_truncate BEFORE TRUNCATE
 ON private.strata_entry_budget_selection_history FOR EACH STATEMENT EXECUTE FUNCTION private.fence_entry_budget_selection_history();
