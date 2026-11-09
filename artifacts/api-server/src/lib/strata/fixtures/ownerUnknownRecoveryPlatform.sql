-- TEST ONLY. Missing upstream Supabase platform contracts, NOT a production
-- schema export. Every application/trading object comes from the unmodified
-- checked-in migration manifest. These are the only hand-written tables.
-- No auth session, Vault decrypt function, provider transport or real secret.
CREATE SCHEMA auth;
CREATE SCHEMA vault;
CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private, vault, auth FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
 $$ SELECT NULLIF(current_setting('request.jwt.claim.role',true),'') $$;
CREATE TABLE vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.financial_accounts (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id), provider text NOT NULL,
 UNIQUE(id,user_id)
);
CREATE TABLE private.provider_connections (
 id uuid PRIMARY KEY, financial_account_id uuid NOT NULL REFERENCES public.financial_accounts(id),
 vault_secret_id uuid REFERENCES vault.secrets(id)
);
CREATE TABLE private.role_assignments (email text NOT NULL, role text NOT NULL);
ALTER TABLE public.financial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.role_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.financial_accounts, private.provider_connections,
 private.role_assignments FROM PUBLIC, anon, authenticated, service_role;
