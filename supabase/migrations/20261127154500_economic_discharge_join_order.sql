-- A unique (account, client) discharge anchors the existing inner joins.
-- Keep the lookup in its declared order on this function only.
ALTER FUNCTION private.strata_has_economic_exit_discharge(text, text)
  SET join_collapse_limit TO 1;
