/** Worker policy identity, deliberately separate from the immutable parameter hash. */
export const V13_LEGACY_ENTRY_POLICY = "v13-first-observed-cross-v1";
export const V13_ENTRY_POLICY_VERSION = "v13-first-qualifying-cross-v2";

/** NULL means historical/unversioned, never an implicit upgrade to v2. */
export function entryCrossAvailable(
  version: string | null | undefined,
  state: { firstCrossOccurred: boolean; crossingConsumed: boolean },
  freshCross: boolean,
): boolean {
  if (!freshCross || state.crossingConsumed) return false;
  if (version === V13_ENTRY_POLICY_VERSION) return true;
  if (version == null || version === V13_LEGACY_ENTRY_POLICY) {
    return !state.firstCrossOccurred;
  }
  return false;
}

/** Reconstruct sign only; AT must remain zero, not become an opening observation. */
export function previousBufferFromSide(side: string | null | undefined): number | null {
  return side === "UP" ? 1 : side === "DOWN" ? -1 : side === "AT" ? 0 : null;
}
