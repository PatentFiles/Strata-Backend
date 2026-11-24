-- Additive release candidate derived from merged PR #357 fixture.
-- No startup execution, live cutover, producer grants or trading authorization.
BEGIN;
CREATE TABLE public.strata_direct_entry_source (
 id text PRIMARY KEY,
 account_id text NOT NULL REFERENCES public.v13_production_account(id),
 market_ticker text NOT NULL,
 crossing_key text NOT NULL,
 observed_at timestamptz NOT NULL,
 oldest_source_at timestamptz NOT NULL,
 closes_at timestamptz NOT NULL,
 evidence_bytes text NOT NULL,
 evidence_sha256 text NOT NULL,
 CHECK(crossing_key=market_ticker||':first'),
 CHECK(oldest_source_at<=observed_at AND observed_at<closes_at),
 CHECK(evidence_sha256=encode(sha256(convert_to(evidence_bytes,'UTF8')),'hex')),
 UNIQUE(account_id,crossing_key),
 UNIQUE(id,account_id,crossing_key)
);
ALTER TABLE public.strata_direct_entry_source ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.strata_direct_entry_source FROM PUBLIC;
DO $ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.strata_direct_entry_source FROM anon; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.strata_direct_entry_source FROM authenticated; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN REVOKE ALL ON public.strata_direct_entry_source FROM service_role; END IF;
END $;
CREATE FUNCTION public.strata_direct_source_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'direct_source_immutable';
END $$;
CREATE TRIGGER strata_direct_source_immutable BEFORE UPDATE OR DELETE ON public.strata_direct_entry_source
 FOR EACH ROW EXECUTE FUNCTION public.strata_direct_source_immutable();
ALTER TABLE public.v13_production_intent ADD COLUMN direct_source_id text;
ALTER TABLE public.v13_production_intent ADD CONSTRAINT v13_production_direct_source_fk
 FOREIGN KEY(direct_source_id,account_id,crossing_key)
 REFERENCES public.strata_direct_entry_source(id,account_id,crossing_key);
-- evaluation_id FK and account+crossing unique index remain unchanged.
ALTER TABLE public.v13_production_intent DROP CONSTRAINT v13_production_entry_source;
ALTER TABLE public.v13_production_intent ADD CONSTRAINT v13_production_entry_source CHECK (
 (kind='ENTRY' AND num_nonnulls(evaluation_id,direct_source_id)=1
 AND crossing_key IS NOT NULL AND parent_id IS NULL)
 OR (kind='EXIT' AND parent_id IS NOT NULL AND direct_source_id IS NULL));
CREATE UNIQUE INDEX v13_production_direct_source_unique ON public.v13_production_intent(account_id,direct_source_id)
 WHERE kind='ENTRY';
CREATE FUNCTION public.strata_intent_source_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF ROW(OLD.kind,OLD.account_id,OLD.evaluation_id,OLD.direct_source_id,OLD.crossing_key)
 IS DISTINCT FROM ROW(NEW.kind,NEW.account_id,NEW.evaluation_id,NEW.direct_source_id,NEW.crossing_key)
 THEN RAISE EXCEPTION 'intent_source_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER strata_intent_source_immutable BEFORE UPDATE ON public.v13_production_intent
 FOR EACH ROW EXECUTE FUNCTION public.strata_intent_source_immutable();
COMMIT;
