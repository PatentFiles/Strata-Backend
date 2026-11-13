/** OFFLINE PROTOTYPE ONLY. No sockets, credentials, persistence, orders, or runtime imports. */
export const WINDOW_MS = 900_000;
export const QUOTE_MAX_AGE_MS = 5_000;
const MAX_FRAME_BYTES = 16_384;
const MAX_MESSAGE_AGE_MS = 5_000;
const MAX_HEARTBEAT_AGE_MS = 15_000;
const MAX_FUTURE_SKEW_MS = 250;
const TICKER = /^KXBTC15M-[A-Za-z0-9-]{1,70}$/;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const timestamp = x => Number.isSafeInteger(x) && x >= 0;
const number = x => typeof x === 'number' && Number.isFinite(x);
const strike = x => number(x) && x > 0;
const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);

export class LifecycleStrikePrototype {
  #owner; #binding; #generation = 0; #connected = false; #synced = false;
  #sid = null; #expectedSeq = null; #highestSeq = -1; #lastNow = null; #lastSent = null;
  #heartbeatAt = null; #markets = new Map(); #reason = 'not_connected';
  #diagnostics = []; #diagnosticCount = 0;
  constructor({ownerId, credentialBinding}) {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128 ||
        typeof credentialBinding !== 'string' || !credentialBinding || credentialBinding.length > 128)
      throw new Error('invalid_binding');
    this.#owner = ownerId; this.#binding = credentialBinding;
  }
  #note(reason) {
    // A fixed three-record ring, with no raw payloads or owner identifiers.
    this.#diagnosticCount = Math.min(Number.MAX_SAFE_INTEGER, this.#diagnosticCount + 1);
    if (this.#diagnostics.at(-1)?.reason !== reason) {
      this.#diagnostics.push({reason});
      if (this.#diagnostics.length > 3) this.#diagnostics.shift();
    }
  }
  #deny(reason, invalidate = false) {
    this.#reason = reason; this.#note(reason);
    if (invalidate) { this.#synced = false; this.#markets.clear(); }
    return {ok:false, reason};
  }
  #clock(nowMs) {
    if (!timestamp(nowMs) || this.#lastNow !== null && nowMs < this.#lastNow)
      return this.#deny('clock_regression_or_invalid', true);
    this.#lastNow = nowMs;
    return {ok:true};
  }
  #context(ctx) {
    const clock = this.#clock(ctx?.nowMs); if (!clock.ok) return clock;
    if (!this.#connected || ctx.generation !== this.#generation)
      return this.#deny('connection_generation_mismatch');
    return {ok:true};
  }
  connect({ownerId, credentialBinding, authenticated, generation, sid, nowMs}) {
    const c = this.#clock(nowMs); if (!c.ok) return c;
    if (ownerId !== this.#owner || credentialBinding !== this.#binding || authenticated !== true ||
        !Number.isSafeInteger(generation) || generation <= this.#generation ||
        !Number.isSafeInteger(sid) || sid < 0) return this.#deny('unverified_connection_context');
    this.#generation = generation; this.#sid = sid; this.#connected = true;
    this.#synced = false; this.#expectedSeq = null; this.#highestSeq = -1; this.#lastSent = null;
    this.#heartbeatAt = nowMs; this.#markets.clear(); this.#reason = 'resync_required';
    return {ok:true, reason:this.#reason};
  }
  disconnect(ctx) {
    const c = this.#context(ctx); if (!c.ok) return c;
    this.#connected = false;
    return this.#deny('disconnected', true);
  }
  /** Caller must establish a trusted subscription baseline and verified exact market identity/window.
   * Boolean scopeVerified is an offline fixture contract, NOT proof suitable for production auth. */
  resync({generation, nowMs, nextSequence, scopeVerified, markets}) {
    const c = this.#context({generation, nowMs}); if (!c.ok) return c;
    if (scopeVerified !== true || !Number.isSafeInteger(nextSequence) || nextSequence < 0 || nextSequence <= this.#highestSeq ||
        !Array.isArray(markets) || markets.length < 1 || markets.length > 2)
      return this.#deny('invalid_resync', true);
    const current = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
    const next = new Map(); const starts = new Set();
    for (const m of markets) {
      if (!object(m) || !TICKER.test(m.ticker) || !timestamp(m.openMs) || !timestamp(m.closeMs) || m.openMs % WINDOW_MS !== 0 ||
          ![current, current + WINDOW_MS].includes(m.openMs) || m.closeMs !== m.openMs + WINDOW_MS ||
          !['greater', 'greater_or_equal'].includes(m.strikeType) || !Number.isSafeInteger(m.exchangeIndex) || m.exchangeIndex < 0 ||
          next.has(m.ticker) || starts.has(m.openMs) ||
          m.seedStrike != null && !strike(m.seedStrike)) return this.#deny('invalid_scope', true);
      next.set(m.ticker, {ticker:m.ticker, openMs:m.openMs, closeMs:m.closeMs,
        strikeType:m.strikeType, exchangeIndex:m.exchangeIndex,
        strike:m.seedStrike ?? null, firstStrike:m.seedStrike ?? null,
        source:m.seedStrike == null ? null : 'verified_rest_seed', invalid:false});
      starts.add(m.openMs);
    }
    this.#markets = next; this.#expectedSeq = nextSequence; this.#highestSeq = nextSequence - 1; this.#lastSent = null;
    this.#synced = true; this.#heartbeatAt = nowMs; this.#reason = 'ready';
    return {ok:true};
  }
  heartbeat(ctx) {
    const c = this.#context(ctx); if (!c.ok) return c;
    if (ctx.nowMs - this.#heartbeatAt > MAX_HEARTBEAT_AGE_MS)
      return this.#deny('connection_health_stale', true);
    this.#heartbeatAt = ctx.nowMs; return {ok:true};
  }
  ingest(raw, ctx) {
    const c = this.#context(ctx); if (!c.ok) return c;
    if (!this.#synced) return this.#deny('resync_required');
    if (ctx.nowMs - this.#heartbeatAt > MAX_HEARTBEAT_AGE_MS)
      return this.#deny('connection_health_stale', true);
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES)
      return this.#deny('oversize_or_invalid_frame', true);
    let f; try { f = JSON.parse(raw); } catch { return this.#deny('invalid_json', true); }
    if (!object(f) || f.sid !== this.#sid || !Number.isSafeInteger(f.seq) ||
        f.seq !== this.#expectedSeq || !object(f.msg)) return this.#deny('stream_discontinuity', true);
    if (!timestamp(f.sending_ts_ms) || f.sending_ts_ms > ctx.nowMs + MAX_FUTURE_SKEW_MS ||
        ctx.nowMs - f.sending_ts_ms > MAX_MESSAGE_AGE_MS ||
        this.#lastSent !== null && f.sending_ts_ms < this.#lastSent)
      return this.#deny('stale_or_regressed_event', true);
    // Sequence validation is deliberately BEFORE filtering other markets/event types.
    this.#highestSeq = f.seq; this.#expectedSeq++; this.#lastSent = f.sending_ts_ms; this.#heartbeatAt = ctx.nowMs;
    if (f.type !== 'market_lifecycle_v2') return {ok:true, ignored:true};
    const m = this.#markets.get(f.msg.market_ticker);
    if (!m) return {ok:true, ignored:true};
    if (ctx.nowMs >= m.closeMs) { this.#markets.delete(m.ticker); return this.#deny('market_window_closed'); }
    if (own(f.msg, 'exchange_index') && f.msg.exchange_index !== m.exchangeIndex)
      return this.#invalidateMarket(m, 'market_exchange_mismatch');
    if (['deactivated','determined','settled','closed','close_date_updated','price_level_structure_updated'].includes(f.msg.event_type))
      return this.#invalidateMarket(m, 'lifecycle_requires_resync');
    if (!['created','activated','metadata_updated'].includes(f.msg.event_type))
      return this.#invalidateMarket(m, 'unsupported_lifecycle_event');
    if (own(f.msg, 'open_ts') && f.msg.open_ts * 1000 !== m.openMs ||
        own(f.msg, 'close_ts') && f.msg.close_ts * 1000 !== m.closeMs)
      return this.#invalidateMarket(m, 'market_window_mismatch');
    if (m.invalid) return this.#deny('market_resync_required');
    const metadata = f.msg.event_type === 'created' ? f.msg.additional_metadata : f.msg;
    if (!object(metadata)) return this.#invalidateMarket(m, 'invalid_metadata');
    // Subtitle-only updates are irrelevant and may not refresh price freshness.
    if (!own(metadata, 'floor_strike') && !own(metadata, 'strike_type') && !own(metadata, 'cap_strike'))
      return {ok:true, ignored:true};
    if (metadata.strike_type !== m.strikeType || !strike(metadata.floor_strike) ||
        metadata.cap_strike != null) return this.#invalidateMarket(m, 'invalid_strike');
    if (m.firstStrike !== null && metadata.floor_strike !== m.firstStrike)
      return this.#invalidateMarket(m, 'strike_conflict');
    m.strike = metadata.floor_strike; m.firstStrike = metadata.floor_strike;
    m.source = 'authenticated_lifecycle'; this.#reason = 'strike_available';
    return {ok:true, ticker:m.ticker, strike:m.strike, metadataObservedAtMs:ctx.nowMs};
  }
  #invalidateMarket(m, reason) { m.invalid = true; m.strike = null; return this.#deny(reason); }
  /** Feasibility admission only, NOT an order authorization. All monetary and execution gates stay external. */
  evaluateQuote(quote, ctx) {
    const c = this.#context(ctx); if (!c.ok) return c;
    if (!this.#synced) return this.#deny('resync_required');
    if (ctx.nowMs - this.#heartbeatAt > MAX_HEARTBEAT_AGE_MS)
      return this.#deny('connection_health_stale', true);
    const m = this.#markets.get(quote?.ticker);
    if (!m || m.invalid || m.strike === null) return this.#deny('strike_unavailable');
    if (ctx.nowMs < m.openMs || ctx.nowMs >= m.closeMs || quote.openMs !== m.openMs || quote.closeMs !== m.closeMs)
      return this.#deny('quote_window_mismatch');
    if (quote.exchangeIndex !== m.exchangeIndex) return this.#deny('quote_exchange_mismatch');
    if (!timestamp(quote.observedAtMs) || quote.observedAtMs > ctx.nowMs || ctx.nowMs - quote.observedAtMs > QUOTE_MAX_AGE_MS)
      return this.#deny('quote_stale');
    if (quote.status !== 'active' || quote.depthVerified !== true || !number(quote.askDollars) ||
        quote.askDollars <= 0 || quote.askDollars >= 1) return this.#deny('quote_not_executable');
    if (quote.restStrike != null && (!strike(quote.restStrike) || quote.restStrike !== m.strike))
      return this.#invalidateMarket(m, 'rest_strike_conflict');
    return {ok:true, feasibilityOnly:true, ticker:m.ticker, strike:m.strike,
      strikeSource:m.source, quoteObservedAtMs:quote.observedAtMs, quoteAgeMs:ctx.nowMs-quote.observedAtMs};
  }
  snapshot() { return {connected:this.#connected, synced:this.#synced, generation:this.#generation,
    expectedSequence:this.#expectedSeq, marketCount:this.#markets.size, reason:this.#reason,
    diagnosticCount:this.#diagnosticCount, diagnostics:this.#diagnostics.map(x=>({...x}))}; }
}
