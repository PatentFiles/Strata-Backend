-- Minimal disposable schema prefix; actual direct-source constraints are from exact-0046.sql.
CREATE TABLE public.v13_production_account(id text PRIMARY KEY, reserved_micros bigint NOT NULL DEFAULT 0, blocked_reason text);
CREATE TABLE public.v13_production_intent(id text PRIMARY KEY,account_id text NOT NULL REFERENCES public.v13_production_account,kind text NOT NULL DEFAULT 'ENTRY',evaluation_id text,crossing_key text,parent_id text,state text NOT NULL DEFAULT 'PREPARED',CONSTRAINT v13_production_entry_source CHECK (evaluation_id IS NOT NULL));
CREATE UNIQUE INDEX v13_production_crossing_unique ON public.v13_production_intent(account_id,crossing_key) WHERE kind='ENTRY';
INSERT INTO public.v13_production_account(id) VALUES ('s'),('p'),('r'),('b'),('u'),('cap');
