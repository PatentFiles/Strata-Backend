export type PublicMetadataPrefetchConfig = Readonly<
  | {enabled: true; source: "explicit_true"}
  | {enabled: false; source: "unset" | "explicit_false" | "invalid"}
>;

/** Scheduling-only rollout switch; never entry or execution authority.
 * Only exact "true" opts in. Unset/exact "false" retain the legacy path.
 * Typos and ambiguous values are explicitly invalid but remain OFF: an
 * advisory optimization must not disable mandatory recovery/protection.
 * Parsing is pure: no clocks, provider reads, environment writes or coercion.
 */
export function readPublicMetadataPrefetchConfig(value: unknown): PublicMetadataPrefetchConfig {
  if (value === undefined) return Object.freeze({enabled:false,source:"unset"});
  if (value === "false") return Object.freeze({enabled:false,source:"explicit_false"});
  if (value === "true") return Object.freeze({enabled:true,source:"explicit_true"});
  return Object.freeze({enabled:false,source:"invalid"});
}
