"""Fail-closed research coverage gate. Never infers completeness from last row.
The manifest must come from an independently checked collector/lifecycle ledger.
It is a declared coverage contract, not cryptographic proof of exchange activity.
"""
from capture_shadow import audit

def qualify(records, manifest):
    records=list(records)
    required={'market','side','first_sequence','last_sequence','expected_records',
              'start_ms','end_ms','entry_evidence_verified','fee_evidence_verified',
              'terminal_evidence_verified','dropped_records','max_gap_ms','max_age_ms'}
    if set(manifest)!=required:raise ValueError('manifest_fields_mismatch')
    for key in ('first_sequence','last_sequence','expected_records','start_ms','end_ms',
                'dropped_records','max_gap_ms','max_age_ms'):
        if type(manifest[key])is not int or manifest[key]<0:raise ValueError('invalid_'+key)
    if manifest['last_sequence']<manifest['first_sequence'] or manifest['end_ms']<manifest['start_ms']:
        raise ValueError('manifest_range')
    for key in ('entry_evidence_verified','fee_evidence_verified','terminal_evidence_verified'):
        if type(manifest[key])is not bool:raise ValueError('invalid_'+key)
    report=audit(records,expected_market=manifest['market'],expected_side=manifest['side'],
                 max_gap_ms=manifest['max_gap_ms'],max_age_ms=manifest['max_age_ms'])
    reasons=[]
    if not report['trajectory_eligible']:reasons.append('invalid_or_empty_observations')
    if len(records)!=manifest['expected_records'] or manifest['expected_records'] != manifest['last_sequence']-manifest['first_sequence']+1:
        reasons.append('count_mismatch')
    if records and (records[0].get('sequence')!=manifest['first_sequence'] or
                    records[-1].get('sequence')!=manifest['last_sequence']):reasons.append('sequence_boundary_mismatch')
    if records and (records[0].get('decision_ms')!=manifest['start_ms'] or
                    records[-1].get('decision_ms')!=manifest['end_ms']):reasons.append('horizon_boundary_mismatch')
    if manifest['dropped_records']!=0:reasons.append('collector_drops')
    for key in ('entry_evidence_verified','fee_evidence_verified','terminal_evidence_verified'):
        if not manifest[key]:reasons.append(key+'_missing')
    return dict(coverage_contract_satisfied=not reasons,reasons=reasons,observations=report,
                executable_profitability_proven=False,execution_authority=False)
