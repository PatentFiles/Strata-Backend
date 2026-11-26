-- READ ONLY. Zero counts are necessary, not a substitute for preventing new
-- ARM/START admissions during the coordinated maintenance window.
BEGIN READ ONLY;
SELECT
 (SELECT count(*) FROM private.kalshi_account_worker_lease WHERE state='owned' OR arm_requested) AS active_or_armed_workers,
 (SELECT count(*) FROM public.v13_production_intent WHERE NOT terminal OR state IN ('PREPARED','DISPATCHED','UNKNOWN') OR reserved_micros<>0) AS unresolved_intents,
 (SELECT count(*) FROM public.v13_production_position WHERE quantity_hundredths<>0 OR basis_micros<>0) AS exposed_positions,
 (SELECT count(*) FROM public.v13_production_account WHERE reserved_micros<>0) AS reserved_accounts,
 (SELECT count(*) FROM private.strata_emergency_exit_reservations WHERE state IN ('PREPARED','DISPATCHED','UNKNOWN')) AS unresolved_exits;
ROLLBACK;
