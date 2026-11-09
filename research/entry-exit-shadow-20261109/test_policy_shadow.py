import unittest
from policy_shadow import first_exit, compare

def event(t,invalid=True,hard=False,valid=True,price=5000):
    return dict(at_ms=t,momentum_invalid=invalid,hard_exit=hard,valid=valid,
                book=dict(received_ms=t,bids=[(price,3)],exit_fee_ticks=200))
P=dict(quantity=3,paper_price_ticks=5300,entry_cost_ticks=12900,
       entry_fee_ticks=200,fee_source_verified=True)
POLICIES={'baseline':{},'persistent':{'persistence_ms':1000}}
class PolicyTests(unittest.TestCase):
    def test_brief_fade_does_not_exit_persistent(self):
        es=[event(1000),event(1500,False),event(2000),event(2500),event(3000)]
        self.assertEqual(first_exit(es,entry_ms=0)['at_ms'],1000)
        self.assertEqual(first_exit(es,entry_ms=0,persistence_ms=1000)['at_ms'],3000)
    def test_hard_exit_bypasses_hold(self):
        self.assertEqual(first_exit([event(100,hard=True)],entry_ms=0,min_hold_ms=9999)['at_ms'],100)
    def test_gap_resets_clock(self):
        self.assertIsNone(first_exit([event(1000),event(5000)],entry_ms=0,persistence_ms=1000))
    def test_invalid_resets_clock(self):
        self.assertIsNone(first_exit([event(1000),event(1500,valid=False),event(2000)],entry_ms=0,persistence_ms=1000))
    def test_no_future_book(self):
        es=[event(1000)];es[0]['book']['received_ms']=1001
        r=compare(es,POLICIES,entry_ms=0,position=P,max_quote_age_ms=500)
        self.assertIsNone(r['baseline']['net_ticks'])
    def test_stale_book(self):
        es=[event(1000)];es[0]['book']['received_ms']=0
        self.assertIsNone(compare(es,{'baseline':{}},entry_ms=0,position=P,max_quote_age_ms=500)['baseline']['net_ticks'])
    def test_prefix_invariance(self):
        prefix=[event(1000),event(1500),event(2000)]
        a=first_exit(prefix,entry_ms=0,persistence_ms=1000)
        b=first_exit(prefix+[event(3000,price=9900)],entry_ms=0,persistence_ms=1000)
        self.assertEqual(a,b)
    def test_both_hold_benefit_and_harm(self):
        for later,better in ((7000,True),(2000,False)):
            es=[event(1000,price=4000),event(1500,price=later),event(2000,price=later)]
            r=compare(es,POLICIES,entry_ms=0,position=P,max_quote_age_ms=500)
            self.assertEqual(r['persistent']['net_ticks']>r['baseline']['net_ticks'],better)
    def test_unclosed_not_assumed_win(self):
        r=compare([event(1000,False)],POLICIES,entry_ms=0,position=P,max_quote_age_ms=500)
        self.assertEqual(r['baseline']['status'],'OPEN_AT_END');self.assertIsNone(r['baseline']['net_ticks'])
    def test_partial_depth_no_net(self):
        es=[event(1000)];es[0]['book']['bids']=[(5300,1)]
        self.assertIsNone(compare(es,{'baseline':{}},entry_ms=0,position=P,max_quote_age_ms=500)['baseline']['net_ticks'])
    def test_unsorted_rejected(self):
        with self.assertRaises(ValueError): first_exit([event(2000,False),event(1000)],entry_ms=0)
if __name__=='__main__':unittest.main()
