/** An expiring exact-SHA technical approval is a replaceable, read-only entry
 * gate; it is NOT the sticky operator STOP, fencing, or uncertain-order hold.
 *
 * Every snapshot begins closed and opens only after independent signed
 * approval is verified AND the reconciliation snapshot is complete.
 * A refreshed technical approval can therefore take effect without a worker
 * restart, but it cannot reset a persistent operator or safety halt.
 */
export class TechnicalReleaseEntryGate {
  private verified = false;

  beginReconciliation(): void { this.verified = false; }

  completeReconciliation(approved: boolean): void {
    this.verified = approved === true;
  }

  mayEnter(entriesAuthorized: boolean | undefined, accountKill: boolean): boolean {
    return this.verified && entriesAuthorized === true && accountKill === false;
  }
}
