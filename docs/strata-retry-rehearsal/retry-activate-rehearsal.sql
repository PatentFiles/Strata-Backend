-- ORDERS-OFF ACTIVATION REHEARSAL ONLY. Never load as a rolling migration.
BEGIN;
LOCK TABLE public.strata_direct_entry_source,public.v13_production_intent IN ACCESS EXCLUSIVE MODE;
INSERT INTO public.strata_direct_entry_current(account_id,crossing_key,source_id)
 SELECT account_id,crossing_key,id FROM public.strata_direct_entry_source;
-- One immutable intent per account/market is unchanged. The *observation*
-- uniqueness moves to the account-lock/pointer protocol. Old source writer
-- uses this discarded ON CONFLICT arbiter; no mixed binaries or old fallback.
ALTER TABLE public.strata_direct_entry_source DROP CONSTRAINT strata_direct_entry_source_account_id_crossing_key_key;
CREATE TRIGGER strata_direct_entry_observation_fenced BEFORE INSERT ON public.strata_direct_entry_source
 FOR EACH ROW EXECUTE FUNCTION public.strata_fence_direct_entry_observation();
CREATE TRIGGER strata_direct_entry_current_after_observation AFTER INSERT ON public.strata_direct_entry_source
 FOR EACH ROW EXECUTE FUNCTION public.strata_set_direct_entry_current();
CREATE TRIGGER strata_direct_intent_not_retired BEFORE INSERT ON public.v13_production_intent
 FOR EACH ROW EXECUTE FUNCTION public.strata_fence_retired_direct_intent();
COMMIT;
