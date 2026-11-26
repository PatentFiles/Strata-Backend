-- Minimal synthetic representation of exact deployed identity constraints only.
CREATE TABLE public.v13_production_account(id text PRIMARY KEY);
CREATE TABLE public.forward_test_evaluations(id text PRIMARY KEY);
CREATE TABLE public.v13_production_intent(
 id text PRIMARY KEY, account_id text NOT NULL REFERENCES public.v13_production_account,
 evaluation_id text REFERENCES public.forward_test_evaluations, crossing_key text,parent_id text,kind text NOT NULL,
 CONSTRAINT v13_production_entry_source CHECK((kind='ENTRY' AND evaluation_id IS NOT NULL AND crossing_key IS NOT NULL AND parent_id IS NULL) OR(kind='EXIT' AND parent_id IS NOT NULL)));
CREATE UNIQUE INDEX v13_production_evaluation_unique ON public.v13_production_intent(account_id,evaluation_id);
CREATE UNIQUE INDEX v13_production_crossing_unique ON public.v13_production_intent(account_id,crossing_key) WHERE kind='ENTRY';
INSERT INTO public.v13_production_account VALUES('A'),('B');
INSERT INTO public.forward_test_evaluations VALUES('paper1'),('paper2'),('paper3');
INSERT INTO public.v13_production_intent VALUES('legacy','A','paper1','OLD:first',NULL,'ENTRY');
