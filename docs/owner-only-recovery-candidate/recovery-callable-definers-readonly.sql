-- Read-only bounded catalog inventory, never function invocation/secret access.
-- $1 must be the independently observed actual API/worker runtime role.
-- 101 results means incomplete: paginate before qualification. Empty results
-- do not establish production safety, account visibility or source identity.
WITH runtime AS (SELECT oid FROM pg_roles WHERE rolname=$1),
reachable AS (SELECT r.oid FROM pg_roles r,runtime x WHERE r.oid=x.oid OR pg_has_role(x.oid,r.oid,'MEMBER'))
SELECT p.oid::text AS function_oid,n.nspname AS schema,p.proname AS function_name,
 pg_get_function_identity_arguments(p.oid) AS signature,
 owner.rolname AS owner_role,owner.rolsuper AS owner_superuser,
 owner.rolbypassrls AS owner_bypass_rls,p.proconfig AS function_settings,
 md5(pg_get_functiondef(p.oid)) AS definition_change_fingerprint,
 EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') AS extension_owned
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
JOIN pg_roles owner ON owner.oid=p.proowner
WHERE p.prosecdef AND p.prokind='f'
AND n.nspname IN('public','private','vault','auth')
AND EXISTS(SELECT 1 FROM reachable r WHERE has_function_privilege(r.oid,p.oid,'EXECUTE'))
ORDER BY n.nspname,p.proname,p.oid LIMIT 101;
