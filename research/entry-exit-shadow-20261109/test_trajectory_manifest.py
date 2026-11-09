import unittest
from trajectory_manifest import qualify
from test_capture_shadow import row

def manifest():
    return dict(market='market-a',side='yes',first_sequence=0,last_sequence=1,
                expected_records=2,start_ms=1000,end_ms=1100,entry_evidence_verified=True,
                fee_evidence_verified=True,terminal_evidence_verified=True,dropped_records=0,
                max_gap_ms=500,max_age_ms=100)
class ManifestTests(unittest.TestCase):
    def test_valid_contract_not_execution(self):
        r=qualify([row(),row(1)],manifest());self.assertTrue(r['coverage_contract_satisfied'])
        self.assertFalse(r['executable_profitability_proven']);self.assertFalse(r['execution_authority'])
    def test_missing_tail(self):self.assertFalse(qualify([row()],manifest())['coverage_contract_satisfied'])
    def test_missing_head(self):self.assertFalse(qualify([row(1)],manifest())['coverage_contract_satisfied'])
    def test_missing_terminal(self):
        m=manifest();m['terminal_evidence_verified']=False
        self.assertFalse(qualify([row(),row(1)],m)['coverage_contract_satisfied'])
    def test_dropped(self):
        m=manifest();m['dropped_records']=1
        self.assertFalse(qualify([row(),row(1)],m)['coverage_contract_satisfied'])
    def test_missing_entry_or_fee(self):
        for key in ('entry_evidence_verified','fee_evidence_verified'):
            m=manifest();m[key]=False
            self.assertFalse(qualify([row(),row(1)],m)['coverage_contract_satisfied'])
    def test_mismatched_horizon(self):
        m=manifest();m['end_ms']=1200
        self.assertFalse(qualify([row(),row(1)],m)['coverage_contract_satisfied'])
    def test_bool_cannot_be_count(self):
        m=manifest();m['expected_records']=True
        with self.assertRaises(ValueError):qualify([row(),row(1)],m)
if __name__=='__main__':unittest.main()
