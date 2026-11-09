import unittest
from capture_shadow import normalize,audit

def row(i=0):
    return dict(market='market-a',observation_id=str(i),stream_id='stream-a',
                strategy_revision='revision-a',fee_version='fee-a',decision_ms=1000+i*100,
                source_ms=900+i*100,body_completed_ms=950+i*100,request_started_ms=900+i*100,
                sequence=i,side='yes',quantity=300,yes_bids=[[5300,150]],no_bids=[[4600,300]])
class CaptureTests(unittest.TestCase):
    def audit(self,rs):return audit(rs,expected_market='market-a',expected_side='yes',max_gap_ms=500,max_age_ms=100)
    def test_complete(self):self.assertTrue(self.audit([row(),row(1)])['trajectory_eligible'])
    def test_secret_omitted(self):
        r=row();r['authorization']='secret';self.assertNotIn('authorization',normalize(r))
    def test_body_not_headers(self):
        r=row();r['body_completed_ms']=1001
        with self.assertRaises(ValueError):normalize(r)
    def test_gap(self):self.assertFalse(self.audit([row(),row(2)])['trajectory_eligible'])
    def test_wrong_side(self):
        r=row();r['side']='no';self.assertFalse(self.audit([r])['trajectory_eligible'])
    def test_duplicate(self):self.assertFalse(self.audit([row(),row()])['trajectory_eligible'])
    def test_fractional_preserved(self):self.assertEqual(normalize(row())['yes_bids'][0][1],150)
    def test_empty_not_eligible(self):self.assertFalse(self.audit([])['trajectory_eligible'])
    def test_stale(self):
        r=row();r['body_completed_ms']=899;r['request_started_ms']=898
        self.assertFalse(self.audit([r])['trajectory_eligible'])
if __name__=='__main__':unittest.main()
