"""Pure synthetic-policy comparison. No live strategy changes or trade actions.
Input records must be chronological, already derived without future data, and
bound to one market/held side/entry. Receipt time is when evidence was available.
Hard exits are mandatory input events and can never be deferred by a candidate.
"""
from exit_shadow import evaluate

def first_exit(events, *, entry_ms, persistence_ms=0, min_hold_ms=0, max_gap_ms=1000):
    for value in (entry_ms,persistence_ms,min_hold_ms,max_gap_ms):
        if type(value) is not int or value < 0: raise ValueError('invalid_time')
    since = None
    previous = None
    for e in events:
        t=e['at_ms']
        if type(t) is not int or t<entry_ms or (previous is not None and t<=previous):
            raise ValueError('noncausal_order')
        for key in ('hard_exit','momentum_invalid','valid'):
            if type(e[key]) is not bool: raise ValueError('invalid_flag')
        if e['hard_exit']:
            return dict(at_ms=t,reason='HARD_EXIT',event=e)
        if previous is not None and t-previous>max_gap_ms: since=None
        previous=t
        if not e['valid']:
            since=None
            continue
        if not e['momentum_invalid']:
            since=None
            continue
        if since is None: since=t
        if t-since>=persistence_ms and t-entry_ms>=min_hold_ms:
            return dict(at_ms=t,reason='MOMENTUM_INVALID',event=e)
    return None

def compare(events, policies, *, entry_ms, position, max_quote_age_ms):
    """Position has quantity, paper_price_ticks, entry cost and verified fee inputs.
    Quote fee amount is bound to selected hypothetical exit; caller certifies it.
    A future quote is not substituted even when it is closer to decision time.
    """
    events=list(events)
    result={}
    for name,parameters in policies.items():
        selected=first_exit(events,entry_ms=entry_ms,**parameters)
        if selected is None:
            result[name]={'status':'OPEN_AT_END','net_ticks':None}; continue
        e=selected['event']; t=selected['at_ms']; book=e.get('book')
        row={'status':'EXIT_DECISION_ONLY','at_ms':t,'reason':selected['reason'],
             'net_ticks':None,'realized_net_ticks':None}
        if book is not None and 0<=t-book['received_ms']<=max_quote_age_ms:
            report=evaluate(**position,exit_fee_ticks=book['exit_fee_ticks'],
                            bids=book['bids'],decision_ms=t,received_ms=book['received_ms'],
                            max_age_ms=max_quote_age_ms)
            row.update(status='VISIBLE_DEPTH_HYPOTHESIS',report=report,
                       net_ticks=report['hypothetical_full_exit_net_ticks'])
        result[name]=row
    return result
