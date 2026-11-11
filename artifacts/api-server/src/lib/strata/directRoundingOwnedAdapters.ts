import {createDirectRoundingRegistry,createDirectRoundingCredentialResolver} from './directRoundingRegistry';
import {createDirectRoundingTransport} from './directRoundingTransport';
import type {DirectRoundingOwnedDependencies} from './directAccountRoundingComposer';
/** Inactive factory, not registered by supervisor or HTTP routes. Caller must
 * supply a server-owned database client configured with bounded query timeout
 * and least-privilege reads. No client-supplied DB, owner, clock or fetch. Missing
 * reviewed authority returns null; this function never creates an approval. */
export function createDirectRoundingOwnedAdapters(db:{query:(sql:string,values:unknown[])=>Promise<{rows:Record<string,unknown>[]}>},ownerUserId:string):DirectRoundingOwnedDependencies{
 return {now:Date.now,readCurrentAuthority:createDirectRoundingRegistry(db,ownerUserId),resolveAccountCredential:createDirectRoundingCredentialResolver(db,ownerUserId),productionSignedGet:createDirectRoundingTransport()};
}
