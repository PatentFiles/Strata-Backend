/** Read-only presentation rules; never change query cadence or backend authority. */
export function observationIsCurrent(input: {
  authenticated: boolean; hasData: boolean; isError: boolean;
  updatedAt: number; now: number;
}): boolean {
  return input.authenticated && input.hasData && !input.isError &&
    Number.isFinite(input.updatedAt) && input.updatedAt > 0 &&
    input.updatedAt <= input.now && input.now - input.updatedAt <= 15_000;
}

export function observedFlag(value: boolean | undefined, current: boolean): string {
  if (value === undefined) return "unavailable";
  if (!current) return "unverified (stale data)";
  return value ? "enabled" : "disabled";
}
