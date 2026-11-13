# Deployed process evidence audit

Source inspected locally on 2026-11-13; no production request performed.

## Existing real sources
- `.railway/railway.ts` builds the API with frozen pnpm lockfile and starts its package start script.
- `artifacts/api-server/package.json` starts `node --enable-source-maps ./dist/index.mjs`.
- `lib/v13-strategy/build-release.mjs` captures Git HEAD, tree, dirty state at build time; unavailable Git yields unavailable/dirty.
- API `build.mjs` embeds this as `__BTC_RELEASE__`. This is a source identity hint, not provider-authenticated deployment identity.
- `deployedGitSha.ts` reads a validated-format RAILWAY_GIT_COMMIT_SHA. Format validation is not provenance authentication.
- Build externalizes native/dynamic packages and uses esbuild-plugin-pino workers. An index.mjs hash alone is NOT a complete executed-code measurement. A configured external list does not prove those packages were actually used.

## Implemented diagnostic
`assess-build-closure.cjs` consumes bounded esbuild output metadata and lists actual declared non-Node external imports and unresolved output imports. It never asserts complete runtime closure, loaded bytes, deployment identity or authority. Five local tests pass. Not installed into build or published; no actual build metadata was available in inspected source.

## Genuine remaining chain
1. Exact protected build should emit esbuild metadata and digest the emitted output bundle, lockfile, actual installed external dependencies, native dependencies, workers, Node runtime and startup/loader configuration. Metafile alone cannot see arbitrary dynamic require.
2. A trusted deployment-side collector must bind the immutable artifact/container digest to provider project/environment/service/deployment and release, through authenticated provider evidence, not environment strings alone.
3. A measured launch/loader must establish the bytes actually used by main process and workers, with immutable content or execution-time verification; hashing a file after import is not loaded-byte proof.
4. Server-issued, short-lived challenge/response binds that provenance and actual constrained runtime DB session measurements to the owner/account/recovery generation. The real key provider and externally adopted trust pins must exist before signer activation.
5. Same-transaction recovery qualification rechecks scope/freshness and its own expected fence changes before commit.

No accessible historical source inspected here establishes (2) or (3). No production access retry, key creation, evidence issuance, deployment or account action occurred. Do not set coverage true or wire a permissive callback to conceal these gaps. No independent human reviewer is intrinsically required by this chain; trusted machine measurements still are.

## Execution-time source measurement implemented
`measured-esm-load.mjs` is a real Node load-hook implementation: exact ESM source returned by the prior loader is copied and hashed before Node receives it. Only pinned sources pass; changed/unlisted ESM dependencies, unavailable CJS/native source and audit failures stop that load. Source observations contain hashes, not source bodies or credentials. It is not installed into the application's production startup.

Native Node subprocess tests exercise actual ESM dependency loading, tamper/unlisted/CJS refusal, and an inherited-loader worker. A separate negative-control test deliberately starts a worker with `execArgv:[]`: it executes outside this hook. That demonstrates why this hook alone MUST NOT be promoted to complete writer/runtime qualification. Similarly, `createRequire`, eval/VM and native/subprocess paths require distinct containment and measurement. The observations explicitly mark runtime closure and deployed identity false. The loader/bootstrap, manifest origin and audit sink require trusted configuration; candidate code cannot make itself trusted simply by emitting these records.

This closes a concrete local implementation gap (hash the execution source, not an after-the-fact file) but does not claim an authenticated Railway process witness. Existing application uses `createRequire` and workers; activating this standalone hook as if it supplied complete application coverage would be incorrect.
