/** Worker termination is independent of account execution authorization.
 * Cash recovery can release a lease while account KILL stays on.
 * Missing, owned/expired, armed and contradictory leases are not safe terminals.
 */
export function terminalDisarmedLease(w:Record<string,unknown>|null|undefined):boolean {
 return !!w&&w.arm_requested===false&&
 ((w.state==='released'&&w.account_kill===false)||(w.state==='killed'&&w.account_kill===true));
}
