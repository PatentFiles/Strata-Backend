-- Isolated experimental migration. Never applied automatically or to production.
-- One conservative application-wide pool intentionally avoids invented member IDs.
CREATE TABLE IF NOT EXISTS private.strata_member_read_budget (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 tokens numeric NOT NULL CHECK(tokens>=0 AND tokens<=750),
 measured_at timestamptz NOT NULL
);
-- Existing balances only decrease; never assume a full provider bucket.
UPDATE private.strata_member_read_budget SET tokens=least(tokens,750);
ALTER TABLE private.strata_member_read_budget DROP CONSTRAINT IF EXISTS strata_member_read_budget_tokens_check;
ALTER TABLE private.strata_member_read_budget ADD CONSTRAINT strata_member_read_budget_tokens_check CHECK(tokens>=0 AND tokens<=750);
REVOKE ALL ON private.strata_member_read_budget FROM PUBLIC;
CREATE OR REPLACE FUNCTION private.strata_reserve_member_read_token(cost integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,private SET lock_timeout='250ms' AS $$
DECLARE current_row private.strata_member_read_budget%ROWTYPE; at_time timestamptz; available numeric;
BEGIN
 IF cost NOT IN (2,10,60) THEN RAISE EXCEPTION 'member_read_cost_unverified'; END IF;
 INSERT INTO private.strata_member_read_budget(singleton,tokens,measured_at)
 VALUES(true,0,clock_timestamp()) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT current_row FROM private.strata_member_read_budget WHERE singleton=true FOR UPDATE;
 -- Clock captured AFTER lock acquisition: concurrent callers cannot double spend.
 at_time:=clock_timestamp();
 available:=least(750,current_row.tokens+greatest(0,extract(epoch FROM (at_time-current_row.measured_at)))*300);
 UPDATE private.strata_member_read_budget
 SET tokens=CASE WHEN available>=cost THEN available-cost ELSE available END,
 measured_at=greatest(at_time,current_row.measured_at) WHERE singleton=true;
 RETURN available>=cost;
END $$;
REVOKE ALL ON FUNCTION private.strata_reserve_member_read_token(integer) FROM PUBLIC;
-- Grant only the existing backend database principal, using deployment-specific review.
