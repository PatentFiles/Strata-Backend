-- READ-ONLY evidence collection; $1 is the verified deployed runtime DB role.
-- NOT a certificate: SECURITY DEFINER/extension/cloud-admin/external access paths,
-- trigger body digests and deployment role binding still require qualification.
WITH runtime AS (SELECT oid,rolname FROM pg_roles WHERE rolname=$1),
reachable AS (SELECT r.* FROM pg_roles r,runtime x WHERE r.oid=x.oid OR pg_has_role(x.oid,r.oid,'MEMBER')),
required(nspname,relname) AS (VALUES
 ('auth','sessions'),('auth','users'),
 ('public','v13_production_event'),('public','v13_production_observation'),
 ('private','kalshi_account_operation_attempts'),('private','strata_owner_control_heads'),
 ('private','strata_owner_recovery_consent_challenge'),('private','strata_owner_recovery_consent_receipt'),
 ('private','strata_owner_machine_authority'),('private','strata_owner_recovery_release_receipt'),
 ('vault','secrets'),('public','v13_production_account'),('public','v13_production_intent'),('public','v13_production_position'),
 ('public','v13_live_money_policy'),('public','live_execution_config'),('public','financial_accounts'),
 ('private','provider_connections'),('private','kalshi_connection_credentials'),('private','kalshi_account_worker_lease'),
 ('private','strata_emergency_exit_reservations'),('private','owner_recovery_barrier_scope')),
objects AS (SELECT c.oid,c.relowner,c.relname,n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN required r ON (r.nspname,r.relname)=(n.nspname,c.relname) WHERE c.relkind IN ('r','p')),
findings AS (
 SELECT 'role_missing'::text AS kind,$1::text AS object WHERE NOT EXISTS(SELECT 1 FROM runtime)
 UNION ALL SELECT 'required_object_missing',r.nspname||'.'||r.relname FROM required r WHERE NOT EXISTS(SELECT 1 FROM objects o WHERE (o.nspname,o.relname)=(r.nspname,r.relname))
 UNION ALL SELECT 'reachable_privileged_role',rolname FROM reachable WHERE rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls
 UNION ALL SELECT 'reachable_table_owner',nspname||'.'||relname FROM objects WHERE relowner IN(SELECT oid FROM reachable)
 UNION ALL SELECT 'truncate_privilege',o.nspname||'.'||o.relname FROM objects o,reachable x WHERE has_table_privilege(x.oid,o.oid,'TRUNCATE')
 UNION ALL SELECT 'schema_create',n.nspname FROM pg_namespace n,reachable x WHERE n.nspname IN('public','private','vault','auth') AND has_schema_privilege(x.oid,n.oid,'CREATE')
 UNION ALL SELECT 'replication_role_set',x.rolname FROM reachable x WHERE has_parameter_privilege(x.oid,'session_replication_role','SET')
 UNION ALL SELECT 'runtime_can_issue_machine_authority',o.nspname||'.'||o.relname FROM objects o,reachable x WHERE o.relname='strata_owner_machine_authority' AND has_table_privilege(x.oid,o.oid,'INSERT')
 UNION ALL SELECT 'scope_mutation_privilege',o.nspname||'.'||o.relname FROM objects o,reachable x WHERE o.relname='owner_recovery_barrier_scope' AND (has_table_privilege(x.oid,o.oid,'INSERT') OR has_table_privilege(x.oid,o.oid,'UPDATE') OR has_table_privilege(x.oid,o.oid,'DELETE'))
)
SELECT kind,object FROM findings ORDER BY kind,object LIMIT 100;
