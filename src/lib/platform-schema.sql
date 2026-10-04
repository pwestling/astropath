-- Additive, repeatable upgrade. The tool platform: apps register versioned
-- operations that agents discover and invoke through one Astropath connection.
-- See docs/platform.md.

-- An app owns a namespace. Only the workspace owner creates one and sets its
-- origin; the app's deploy publishes releases with its publisher key.
CREATE TABLE IF NOT EXISTS ap_apps (
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  id text NOT NULL CHECK (id ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text NOT NULL,
  origin text NOT NULL,
  grant_policy text NOT NULL DEFAULT 'auto' CHECK (grant_policy IN ('auto','explicit')),
  publisher_key_hash text UNIQUE,
  publisher_key_prefix text,
  active_release text,
  disabled_at timestamptz,
  disabled_operations text[] NOT NULL DEFAULT '{}',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
-- Releases are immutable: re-publishing the same release ID needs the same digest.
CREATE TABLE IF NOT EXISTS ap_app_releases (
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  app_id text NOT NULL,
  release text NOT NULL,
  digest text NOT NULL,
  manifest jsonb NOT NULL,
  published_by text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app_id, release),
  FOREIGN KEY (tenant_id, app_id) REFERENCES ap_apps(tenant_id, id)
);
-- Every catalog revision that discovery ever returned, so a pinned revision can
-- be checked against the current one instead of silently falling forward.
CREATE TABLE IF NOT EXISTS ap_catalogs (
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  revision text NOT NULL,
  entries jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, revision)
);
-- Per-connection exceptions to an app's grant policy: exclude under auto,
-- include under explicit (include also unlocks the app's sensitive operations).
CREATE TABLE IF NOT EXISTS ap_app_grants (
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  app_id text NOT NULL,
  connection_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('include','exclude')),
  set_by text NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, app_id, connection_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES ap_apps(tenant_id, id)
);
-- One row per logical mutating invocation. The reservation commits before any
-- effect, so a retry with the same key finds it instead of acting twice.
CREATE TABLE IF NOT EXISTS ap_invocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  principal_id text NOT NULL,
  principal_name text NOT NULL DEFAULT '',
  space text NOT NULL,
  operation text NOT NULL,
  version text NOT NULL,
  catalog_revision text NOT NULL,
  app_id text NOT NULL,
  app_release text NOT NULL,
  idempotency_key text NOT NULL,
  args_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','accepted','failed','unknown')),
  effect_state text NOT NULL DEFAULT 'none' CHECK (effect_state IN ('none','committed','partial','unknown')),
  encrypted_arguments text NOT NULL,
  encrypted_result text,
  error jsonb,
  attempt integer NOT NULL DEFAULT 1,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, principal_id, space, operation, version, idempotency_key),
  FOREIGN KEY (tenant_id, space) REFERENCES ap_spaces(tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS ap_invocations_recent ON ap_invocations(tenant_id, created_at DESC);
-- The key that signs delegated tokens sent to apps. Per tenant and encrypted
-- with the tenant key, so master-key rotation does not touch it.
CREATE TABLE IF NOT EXISTS ap_signing_keys (
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  kid text NOT NULL,
  public_jwk jsonb NOT NULL,
  encrypted_private_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (tenant_id, kid)
);

DO $$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['ap_apps','ap_app_releases','ap_catalogs','ap_app_grants','ap_invocations','ap_signing_keys'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',tab);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I TO astropath_tenant USING (tenant_id=nullif(current_setting(''astropath.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''astropath.tenant_id'',true),'''')::uuid)',tab);
  EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I',tab);
  EXECUTE format('CREATE POLICY platform_access ON %I TO %I USING (true) WITH CHECK (true)',tab,current_user);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO astropath_tenant',tab);
 END LOOP;
END $$;
GRANT DELETE ON ap_app_grants TO astropath_tenant;
