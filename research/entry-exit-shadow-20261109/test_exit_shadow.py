import unittest
from exit_shadow import evaluate
class ShadowTests(unittest.TestCase):
    def run_case(self, **kw):
        args=dict(quantity=3,paper_price_ticks=5300,entry_cost_ticks=12900,
                  entry_fee_ticks=200,exit_fee_ticks=200,fee_source_verified=True,
                  bids=[(3600,3)],decision_ms=10000,received_ms=11000,max_age_ms=500,
                  slippage_ticks=100)
        args.update(kw); return evaluate(**args)
    def test_delayed_quote_not_realized(self):
        r=self.run_case(); self.assertEqual(r['timing'],'POST_DECISION_SENSITIVITY')
        self.assertIsNone(r['realized_net_ticks']);self.assertIsNone(r['certified_executable_net_ticks'])
        self.assertEqual(r['paper_gross_pnl_ticks'],3000)
        self.assertEqual(r['hypothetical_full_exit_net_ticks'],-2500)
        self.assertEqual(r['paper_minus_depth_proceeds_ticks'],5100)
        self.assertEqual(r['hypothetical_stressed_net_ticks'],-2800)
    def test_walk_depth(self):
        r=self.run_case(bids=[(3400,2),(3600,1)])
        self.assertEqual(r['displayed_depth_gross_ticks'],10400)
    def test_partial_does_not_claim_full_pnl(self):
        r=self.run_case(bids=[(3600,1)])
        self.assertEqual(r['modeled_unfilled'],2)
        self.assertIsNone(r['hypothetical_full_exit_net_ticks'])
        self.assertIsNone(r['paper_minus_depth_proceeds_ticks'])
    def test_missing_fees(self):
        self.assertIsNone(self.run_case(exit_fee_ticks=None)['hypothetical_full_exit_net_ticks'])
    def test_unverified_fee(self):
        self.assertIsNone(self.run_case(fee_source_verified=False)['hypothetical_full_exit_net_ticks'])
    def test_stale(self):
        self.assertEqual(self.run_case(received_ms=9000)['timing'],'STALE_SENSITIVITY')
    def test_current_still_not_a_fill(self):
        r=self.run_case(received_ms=9900)
        self.assertEqual(r['timing'],'PRE_DECISION_LOCAL_RECEIPT')
        self.assertIsNone(r['certified_executable_net_ticks'])
    def test_duplicate_rejected(self):
        with self.assertRaises(ValueError):self.run_case(bids=[(3600,2),(3600,1)])
    def test_invalid_input(self):
        for kw in ({'quantity':True},{'bids':[(10001,3)]},{'bids':[(3000,-1)]},{'slippage_ticks':-1}):
            with self.assertRaises(ValueError):self.run_case(**kw)
    def test_zero_depth(self):
        r=self.run_case(bids=[]);self.assertIsNone(r['depth_vwap_ticks'])
        self.assertIsNone(r['hypothetical_full_exit_net_ticks'])
    def test_original_limit_support(self):
        r=self.run_case(bids=[(5400,1),(5300,1),(5200,5)])
        self.assertEqual(r['paper_price_supported_quantity'],2)
if __name__=='__main__':unittest.main()
