-- Operator diagnostic only. No user-table scans, row contents, or mutations.
-- Run once when the database is responsive; do not retry during an outage.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '3s';
SET LOCAL lock_timeout = '250ms';
SELECT now() AS sampled_at, n.nspname AS schema_name, c.relname,
       c.reltuples::bigint AS estimated_rows,
       c.relpages::bigint * current_setting('block_size')::bigint AS estimated_heap_bytes,
       s.n_live_tup, s.n_dead_tup, s.n_tup_ins, s.n_tup_upd, s.n_tup_del,
       s.last_autovacuum, s.last_autoanalyze
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind = 'r' AND n.nspname IN ('public', 'private')
ORDER BY c.relpages DESC, n.nspname, c.relname
LIMIT 30;
-- Index/TOAST estimates are separate: heap estimates alone are not total storage.
SELECT n.nspname AS schema_name, c.relname, c.relkind,
       c.relpages::bigint * current_setting('block_size')::bigint AS estimated_bytes
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('i', 't')
  AND n.nspname IN ('public', 'private', 'pg_toast')
ORDER BY c.relpages DESC, n.nspname, c.relname
LIMIT 30;
SELECT stats_reset FROM pg_stat_database WHERE datname = current_database();
COMMIT;
