"""Offline reporting only. No imports from production, IO, network or order actions.
Money uses integer price ticks (1 tick = $0.0001); quantities whole contracts.
Caller must bind ticker, held side, timestamps and fee provenance before comparison.
"""
def evaluate(*, quantity, paper_price_ticks, entry_cost_ticks, entry_fee_ticks,
             exit_fee_ticks, fee_source_verified, bids, decision_ms, received_ms,
             max_age_ms, slippage_ticks=0):
    def integer(x, lo=0):
        if type(x) is not int or x < lo:
            raise ValueError('invalid_integer')
    for x in (quantity,): integer(x, 1)
    for x in (paper_price_ticks, entry_cost_ticks, decision_ms, received_ms,
              max_age_ms, slippage_ticks): integer(x)
    if paper_price_ticks > 10000 or slippage_ticks > 10000:
        raise ValueError('invalid_price')
    if type(fee_source_verified) is not bool: raise ValueError('invalid_fee_status')
    for x in (entry_fee_ticks, exit_fee_ticks):
        if x is not None: integer(x)
    levels = []
    for price, qty in bids:
        integer(price); integer(qty, 1)
        if price > 10000: raise ValueError('invalid_price')
        levels.append((price, qty))
    if len({p for p, _ in levels}) != len(levels):
        raise ValueError('duplicate_level')
    levels.sort(reverse=True)
    remaining = quantity
    gross = 0
    stressed_gross = 0
    price_limited_quantity = 0
    for price, qty in levels:
        if price >= paper_price_ticks:
            price_limited_quantity += qty
        take = min(remaining, qty)
        gross += take * price
        stressed_gross += take * max(0, price-slippage_ticks)
        remaining -= take
    filled = quantity - remaining
    lag = received_ms - decision_ms
    timing = 'POST_DECISION_SENSITIVITY' if lag > 0 else (
        'STALE_SENSITIVITY' if -lag > max_age_ms else 'PRE_DECISION_LOCAL_RECEIPT')
    fees_known = fee_source_verified and entry_fee_ticks is not None and exit_fee_ticks is not None
    # These are hypothetical full-position comparisons, never realized P&L.
    net = gross-entry_cost_ticks-entry_fee_ticks-exit_fee_ticks if not remaining and fees_known else None
    return dict(mode='OFFLINE_SHADOW_ONLY', trading_authority=False,
                realized_net_ticks=None, certified_executable_net_ticks=None,
                timing=timing, receipt_lag_ms=lag, modeled_filled=filled,
                modeled_unfilled=remaining, paper_price_supported_quantity=min(quantity,price_limited_quantity),
                displayed_depth_gross_ticks=gross, depth_vwap_ticks=gross/filled if filled else None,
                hypothetical_full_exit_net_ticks=net,
                hypothetical_stressed_net_ticks=(stressed_gross-entry_cost_ticks-entry_fee_ticks-exit_fee_ticks
                                                if net is not None else None),
                paper_gross_pnl_ticks=quantity*paper_price_ticks-entry_cost_ticks,
                paper_minus_depth_proceeds_ticks=quantity*paper_price_ticks-gross if not remaining else None)
