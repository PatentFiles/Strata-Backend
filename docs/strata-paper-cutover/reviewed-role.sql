-- Review and test against a staging clone first. Never run at process startup.
-- Connect the paper service through a dedicated login with only this group.
-- No password, LOGIN role, membership grant, or live privilege is created here.
BEGIN;
CREATE ROLE strata_paper_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO strata_paper_runtime;
GRANT SELECT, INSERT, UPDATE ON public.forward_test_engine, public.forward_test_windows,
  public.forward_test_positions TO strata_paper_runtime;
GRANT SELECT, INSERT, DELETE ON public.forward_test_btc_points TO strata_paper_runtime;
GRANT SELECT, INSERT ON public.forward_test_evaluations, public.forward_test_book_snapshots,
  public.v13_strategy_parameter_set, public.v13_strategy_shadow_evaluation TO strata_paper_runtime;

-- Existing production tables enforce RLS without paper-role policies.
-- Define these in native rehearsal too. Object grants alone are insufficient.
ALTER TABLE public.forward_test_engine ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forward_test_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forward_test_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forward_test_btc_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forward_test_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forward_test_book_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v13_strategy_parameter_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v13_strategy_shadow_evaluation ENABLE ROW LEVEL SECURITY;

CREATE POLICY strata_paper_runtime_engine ON public.forward_test_engine TO strata_paper_runtime
  USING (id='v1.3-paper') WITH CHECK (id='v1.3-paper');
CREATE POLICY strata_paper_runtime_window ON public.forward_test_windows TO strata_paper_runtime
  USING (ticker ~ '^KXBTC15M-[A-Z0-9-]+$') WITH CHECK (ticker ~ '^KXBTC15M-[A-Z0-9-]+$');
CREATE POLICY strata_paper_runtime_positions ON public.forward_test_positions TO strata_paper_runtime
  USING (engine_id='v1.3-paper') WITH CHECK (engine_id='v1.3-paper');
CREATE POLICY strata_paper_runtime_points ON public.forward_test_btc_points TO strata_paper_runtime
  USING (engine_id='v1.3-paper') WITH CHECK (engine_id='v1.3-paper');
CREATE POLICY strata_paper_runtime_evaluation ON public.forward_test_evaluations TO strata_paper_runtime
  USING (evaluation_source='paper' AND live_position_id IS NULL AND source_paper_evaluation_id IS NULL)
  WITH CHECK (evaluation_source='paper' AND live_position_id IS NULL AND source_paper_evaluation_id IS NULL);
CREATE POLICY strata_paper_runtime_book ON public.forward_test_book_snapshots TO strata_paper_runtime
  USING (engine_id='v1.3-paper') WITH CHECK (engine_id='v1.3-paper');
CREATE POLICY strata_paper_runtime_parameters ON public.v13_strategy_parameter_set TO strata_paper_runtime
  USING (execution_authority IS FALSE) WITH CHECK (execution_authority IS FALSE);
CREATE POLICY strata_paper_runtime_research ON public.v13_strategy_shadow_evaluation TO strata_paper_runtime
  USING (execution_authority IS FALSE) WITH CHECK (execution_authority IS FALSE);
COMMIT;
