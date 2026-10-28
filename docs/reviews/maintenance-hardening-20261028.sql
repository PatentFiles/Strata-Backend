-- Controlled stopped/flat maintenance; no consent, grant, trading flag or risk changes.
-- Preserve SECURITY INVOKER and the existing immutable-scope/revocation predicate.
ALTER FUNCTION private.strata_continuous_grant_guard() SET search_path = '';
