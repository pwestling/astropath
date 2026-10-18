-- Optional Custodes sign-in, account linking and permission-adapter state.
-- Additive and idempotent: nothing here changes an existing table or column, and an
-- instance that never configures Custodes keeps these tables empty.
-- These are directory tables for authentication and administration. They are not
-- tenant-scoped and are deliberately not granted to astropath_tenant.

-- (issuer, subject) is the durable identity; email is never a key. A local user is linked to
-- at most one Custodes identity per issuer, and an identity to exactly one local user.
CREATE TABLE IF NOT EXISTS ap_custodes_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_via text NOT NULL CHECK(linked_via IN ('session','invitation')),
  linked_email text,
  linked_session_id text,
  last_login_at timestamptz,
  PRIMARY KEY(issuer, subject),
  UNIQUE(issuer, user_id)
);

-- One row per browser sign-in attempt. State, nonce and PKCE verifier stay on the server;
-- the browser only holds an unguessable flow id. A flow is consumed exactly once.
CREATE TABLE IF NOT EXISTS ap_custodes_flows (
  flow_hash text PRIMARY KEY,
  state text NOT NULL,
  nonce text NOT NULL,
  verifier text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('login','link')),
  user_id text,
  session_id text,
  invite_hash text,
  -- Better Auth's signed authorization query when sign-in interrupted an MCP/OAuth connection.
  oauth_query text CHECK(oauth_query IS NULL OR length(oauth_query)<=4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK(purpose <> 'link' OR (user_id IS NOT NULL AND session_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ap_custodes_flows_expiry ON ap_custodes_flows(expires_at);

-- Which Custodes session (sid) created which local web session, for back-channel logout.
CREATE TABLE IF NOT EXISTS ap_custodes_sessions (
  session_id text PRIMARY KEY,
  user_id text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  sid text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ap_custodes_sessions_sid ON ap_custodes_sessions(issuer, sid);
CREATE INDEX IF NOT EXISTS ap_custodes_sessions_subject ON ap_custodes_sessions(issuer, subject);

-- Replay protection for back-channel logout tokens.
CREATE TABLE IF NOT EXISTS ap_custodes_jti (
  jti text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

-- Permission adapter: one global revision, bumped by triggers so the dashboard adapter, the
-- members UI, invitation acceptance, tenant creation and manual SQL all version alike.
-- The function is SECURITY DEFINER because tenant-scoped writers (astropath_tenant) cause the
-- bump but must not be able to touch the revision table themselves.
CREATE TABLE IF NOT EXISTS ap_permission_revision (
  id integer PRIMARY KEY CHECK(id=1),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO ap_permission_revision(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION ap_bump_permission_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE ap_permission_revision SET revision=revision+1 WHERE id=1;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS ap_permissions_bump ON ap_members;
CREATE TRIGGER ap_permissions_bump AFTER INSERT OR UPDATE OR DELETE ON ap_members
  FOR EACH STATEMENT EXECUTE FUNCTION ap_bump_permission_revision();
DROP TRIGGER IF EXISTS ap_permissions_bump ON ap_tenants;
CREATE TRIGGER ap_permissions_bump AFTER INSERT OR UPDATE OR DELETE ON ap_tenants
  FOR EACH STATEMENT EXECUTE FUNCTION ap_bump_permission_revision();
DROP TRIGGER IF EXISTS ap_permissions_bump ON ap_spaces;
CREATE TRIGGER ap_permissions_bump AFTER INSERT OR UPDATE OR DELETE ON ap_spaces
  FOR EACH STATEMENT EXECUTE FUNCTION ap_bump_permission_revision();
DROP TRIGGER IF EXISTS ap_permissions_bump ON ap_custodes_identities;
CREATE TRIGGER ap_permissions_bump AFTER INSERT OR UPDATE OR DELETE ON ap_custodes_identities
  FOR EACH STATEMENT EXECUTE FUNCTION ap_bump_permission_revision();

-- Durable receipts for permission changes, keyed by Custodes' request id.
CREATE TABLE IF NOT EXISTS ap_permission_requests (
  request_id uuid PRIMARY KEY,
  actor text NOT NULL,
  fingerprint text NOT NULL,
  target jsonb NOT NULL,
  action_id text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('applied','rejected')),
  state jsonb,
  error_status integer,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Audit trail of administrative changes made through Custodes (and account links).
CREATE TABLE IF NOT EXISTS ap_custodes_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor text NOT NULL,
  tenant_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE tab text;
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='astropath_tenant') THEN
  FOREACH tab IN ARRAY ARRAY['ap_custodes_identities','ap_custodes_flows','ap_custodes_sessions','ap_custodes_jti','ap_permission_revision','ap_permission_requests','ap_custodes_audit'] LOOP
   EXECUTE format('REVOKE ALL ON %I FROM astropath_tenant',tab);
  END LOOP;
 END IF;
END $$;
