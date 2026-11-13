"""Offline allowlisted evidence envelope. No acquisition, persistence or authority.
Only serialized public-market observations belong here. Account/fill reconciliation
is intentionally outside this record. Availability means BODY COMPLETE, not headers.
"""
def normalize(record):
    def integer(k,minimum=0):
        x=record.get(k)
        if type(x) is not int or x<minimum:raise ValueError('invalid_'+k)
        return x
    def label(k):
        x=record.get(k)
        if not isinstance(x,str) or not x or len(x)>128:raise ValueError('invalid_'+k)
        return x
    out={k:label(k) for k in ('market','observation_id','stream_id','strategy_revision','fee_version')}
    for k in ('decision_ms','source_ms','body_completed_ms','request_started_ms','sequence'):
        out[k]=integer(k)
    if not out['request_started_ms']<=out['body_completed_ms']<=out['decision_ms']:
        raise ValueError('book_unavailable_at_decision')
    if out['source_ms']>out['decision_ms']:raise ValueError('future_source')
    if record.get('side') not in ('yes','no'):raise ValueError('invalid_side')
    out['side']=record['side']
    out['quantity']=integer('quantity',1)
    for key in ('yes_bids','no_bids'):
        rows=record.get(key)
        if not isinstance(rows,list) or len(rows)>1000:raise ValueError('invalid_depth')
        seen=set(); levels=[]
        for row in rows:
            if not isinstance(row,list) or len(row)!=2:raise ValueError('invalid_depth')
            p,q=row
            if type(p)is not int or not 0<=p<=10000 or type(q)is not int or q<=0 or p in seen:
                raise ValueError('invalid_depth')
            seen.add(p);levels.append([p,q])
        out[key]=sorted(levels,reverse=True)
    # Quantities in 1/100 contracts. Do not coerce fractional depth to whole fills.
    out['quantity_unit']='hundredths_contract'
    out['price_unit']='ten_thousandths_dollar'
    out['authority']='SHADOW_ONLY';out['actual_fill_verified']=False
    return out

def audit(records, *, expected_market, expected_side, max_gap_ms, max_age_ms):
    accepted=[];errors=[];prior=None;ids=set()
    for index,record in enumerate(records):
        try:
            row=normalize(record)
            if row['market']!=expected_market or row['side']!=expected_side:raise ValueError('identity_mismatch')
            if row['observation_id'] in ids:raise ValueError('duplicate_observation')
            ids.add(row['observation_id'])
            if row['decision_ms']-row['body_completed_ms']>max_age_ms:raise ValueError('stale_book')
            if prior:
                if row['stream_id']!=prior['stream_id']:raise ValueError('stream_changed')
                if row['sequence']!=prior['sequence']+1:raise ValueError('sequence_gap')
                if not 0<row['decision_ms']-prior['decision_ms']<=max_gap_ms:raise ValueError('time_gap')
            accepted.append(row);prior=row
        except (ValueError,TypeError) as error:
            errors.append({'index':index,'reason':str(error)})
    return {'accepted':len(accepted),'rejected':len(errors),'errors':errors,
            'trajectory_eligible':bool(accepted) and not errors,
            'realized_net':None,'execution_authority':False}
