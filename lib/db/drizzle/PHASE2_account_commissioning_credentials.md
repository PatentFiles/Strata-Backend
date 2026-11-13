# Phase 2 credential migration

The review-only migration is `0012_kalshi_connection_credentials.sql`. It has not been applied to production. Apply it only through a separate staged authorization. Its rollback is in the file header: drop the trigger, function, credential table, and the added provider-connection index, in that order.

## Why a schema change is not applied now

`private.provider_connections` stores one `vault_secret_id` for the user's connected Kalshi credential. Commissioning needs separate role bindings for provisioning, verification, and restricted execution, and later phases may add roles. The application already treats roles as a list resolved by the authenticated connection. It does not assume a fixed number of key pairs, and it does not treat the existing single Vault secret as every role.

The legacy singleton account (`owner_user_id` null, subaccount 1, exchange index 2) keeps its Railway credentials on the existing isolated path. Phase 2 must not copy that account, its policy, or its stake onto a user.

## Minimal future schema

Add one server-only table, for example `private.kalshi_connection_credentials`:

- `id uuid` primary key
- `owner_user_id uuid not null`, matching the authenticated owner of the provider connection
- `provider_connection_id uuid not null` referencing `private.provider_connections`
- `role text not null`
- `vault_secret_id uuid not null`, pointing at the existing Supabase Vault secret
- `key_fingerprint text`, the same sha256 fingerprint already used by commissioning
- `created_at timestamptz not null default now()`
- unique `(provider_connection_id, role)`

The role check can start with `provisioning`, `verification`, and `restricted_execution`. Adding a role later is a new migration, not a second copy of this table. Do not insert the current `provider_connections.vault_secret_id` into all three roles. Each role is an explicit binding.

Enable row-level security. Revoke `SELECT`, `INSERT`, `UPDATE`, and `DELETE` from `public`, `anon`, and `authenticated`. Secrets remain readable only through the existing Vault function used by the server. Do not add a decrypted-secret column.

No change to `v13_production_account`, `v13_live_money_policy`, `strata_configured_stake`, or the legacy row is required for this credential table. User-scoped execution rows, when a later phase creates them, continue to use the owner and connection columns already added by migration 0009.
