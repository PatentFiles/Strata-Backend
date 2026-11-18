/** Read-only owned-account gate facts from one coherent statement snapshot.
 * Caller already holds its account FOR UPDATE. No lock is added or moved;
 * the separate approved-policy FOR SHARE still follows every gate invocation.
 * No result survives this invocation. Master is observed within this statement,
 * up to one RTT earlier than the former sequential read, never cached.
 */
export const OWNED_GATE_READ_SQL = `
 WITH uncertain AS MATERIALIZED (
   SELECT EXISTS(SELECT 1 FROM v13_production_intent WHERE account_id=$1
     AND state IN ('DISPATCHED','UNKNOWN') AND ($2::text IS NULL OR id<>$2)) AS has_uncertain_order
 ), owned AS MATERIALIZED (
   SELECT has_uncertain_order, CASE WHEN $3::boolean OR NOT has_uncertain_order
     THEN (SELECT owner_user_id::text FROM v13_production_account WHERE id=$1)
     ELSE NULL END AS owner_user_id FROM uncertain
 ), master AS MATERIALIZED (
   SELECT owned.*, CASE WHEN ($3::boolean OR NOT has_uncertain_order) AND owner_user_id=$4::text
     THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('manual_kill_switch',manual_kill_switch,
       'live_execution_enabled',live_execution_enabled)),'[]'::jsonb) FROM live_execution_config)
     ELSE '[]'::jsonb END AS master_rows FROM owned
 ) SELECT master.*, CASE WHEN jsonb_array_length(master_rows)=1
     AND master_rows->0->'manual_kill_switch'='false'::jsonb
     AND master_rows->0->'live_execution_enabled'='true'::jsonb
   THEN (SELECT coalesce(jsonb_agg(jsonb_build_object('policy_hash',p.policy_hash)),'[]'::jsonb)
     FROM v13_live_money_policy p JOIN v13_production_account a
       ON a.policy_id=p.id AND a.id=p.execution_account_id
     WHERE a.id=$1 AND a.owner_user_id::text=$4::text AND p.state='APPROVED')
   ELSE '[]'::jsonb END AS policy_rows FROM master`;
