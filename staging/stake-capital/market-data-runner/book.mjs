// Prices in $0.0001 units, quantities in hundredths of a contract.
// No rounding or clamping of venue data. Malformed or crossed books fail closed.
const ONE_DOLLAR = 10_000;
function fixed(value, places, signed = false) {
  if (typeof value !== 'string' || value.length > 22) throw Error('fixed_point');
  const m = new RegExp(`^(${signed ? '-?' : ''})(0|[1-9][0-9]{0,11})(?:\\.([0-9]{1,${places}}))?$`).exec(value);
  if (!m || m[0] !== value) throw Error('fixed_point');
  const n = Number(m[2]) * 10 ** places + Number((m[3] ?? '').padEnd(places, '0'));
  if (!Number.isSafeInteger(n)) throw Error('fixed_point');
  return m[1] ? -n : n;
}
function price(x) {
  const p = fixed(x, 4);
  if (p <= 0 || p >= ONE_DOLLAR) throw Error('price_range');
  return p;
}
function side(levels) {
  if (!Array.isArray(levels) || levels.length > ONE_DOLLAR - 1) throw Error('levels');
  const out = new Map();
  for (const level of levels) {
    if (!Array.isArray(level) || level.length !== 2) throw Error('level');
    const p = price(level[0]), q = fixed(level[1], 2);
    if (q <= 0 || out.has(p)) throw Error('level');
    out.set(p, q);
  }
  return out;
}
function maxPrice(levels) {
  let max = 0;
  for (const p of levels.keys()) max = Math.max(max, p);
  return max;
}
function view(own, opposite) {
  const entryAskLevels = [...opposite].map(([p, q]) => [ONE_DOLLAR - p, q]).sort((a, b) => a[0] - b[0]);
  const exitBidLevels = [...own].sort((a, b) => b[0] - a[0]);
  return {entryAskLevels, exitBidLevels};
}
export function bookAfterDelta(snapshot, delta) {
  const yes = side(snapshot.yes_dollars_fp), no = side(snapshot.no_dollars_fp);
  if (maxPrice(yes) + maxPrice(no) > ONE_DOLLAR) throw Error('crossed_snapshot');
  if (delta.side !== 'yes' && delta.side !== 'no') throw Error('delta_side');
  const levels = delta.side === 'yes' ? yes : no, p = price(delta.price_dollars);
  const change = fixed(delta.delta_fp, 2, true), updated = (levels.get(p) ?? 0) + change;
  if (!change || !Number.isSafeInteger(updated) || updated < 0) throw Error('delta_quantity');
  if (!updated) levels.delete(p); else levels.set(p, updated);
  if (maxPrice(yes) + maxPrice(no) > ONE_DOLLAR) throw Error('crossed_update');
  return {priceUnit:'usd_1e-4', quantityUnit:'contracts_1e-2',
    yes:view(yes,no), no:view(no,yes)};
}
