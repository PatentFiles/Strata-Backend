import type {BuildMetadata} from '../../../../scripts/build-metadata.mjs';
declare const __STRATA_BUILD__:Readonly<BuildMetadata>;
/** Unknown means unknown; never infer an immutable build from runtime env. */
export const BUILD_PROVENANCE=typeof __STRATA_BUILD__==='undefined'?null:__STRATA_BUILD__;
