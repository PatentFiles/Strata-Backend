/** Reviewed provenance of an exact Kalshi-owned HTTPS document response.
 * Independent browser GET observed HTTP 200 and 281129 PDF bytes from
 * https://kalshi.com/docs/kalshi-fee-schedule.pdf at 18:03:30.210Z Oct 19.
 * Its SHA-256 matched the original immutable July 7 2026 PDF fixture.
 * This is a fixed <=24h lease, NOT an evergreen source guarantee.
 * Only change these fields after a new independently verified provider read.
 */
export const INDEPENDENT_OFFICIAL_FEE_SNAPSHOT=Object.freeze({
 url:"https://kalshi.com/docs/kalshi-fee-schedule.pdf",
 sha256:"c326a69f596a11e8f8be2620402d39a8d4823920c21cc97c93a114d862699601",
 byteLength:281129,
 checkedAt:"2026-10-19T18:03:30.210Z",
 expiresAt:"2026-10-20T18:03:30.210Z",
});
export function officialFeeSnapshotLeaseValid(now:number):boolean{
 const a=Date.parse(INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.checkedAt);
 const b=Date.parse(INDEPENDENT_OFFICIAL_FEE_SNAPSHOT.expiresAt);
 return Number.isSafeInteger(now)&&now>=a&&now<b&&b>a&&b-a<=86400000;
}
