CREATE TABLE IF NOT EXISTS ap_tenants (
  id uuid PRIMARY KEY, name text NOT NULL, wrapped_key text NOT NULL,
  disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ap_platform_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL, tenant_id uuid NOT NULL REFERENCES ap_tenants(id),
  action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

-- The migration runner provisions the initial tenant/key before this block.
DO $$
DECLARE tab text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ap_spaces' AND column_name='tenant_id') THEN
  FOREACH tab IN ARRAY ARRAY['ap_spaces','ap_connections','ap_members','ap_messages','ap_files','ap_receipts','ap_activity','ap_events'] LOOP
   EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id uuid NOT NULL DEFAULT current_setting(''astropath.tenant_id'')::uuid REFERENCES ap_tenants(id)',tab);
   EXECUTE format('CREATE INDEX %I ON %I(tenant_id)',tab || '_tenant',tab);
  END LOOP;
  ALTER TABLE ap_messages DROP CONSTRAINT ap_messages_space_fkey;
  ALTER TABLE ap_files DROP CONSTRAINT ap_files_space_fkey;
  ALTER TABLE ap_events DROP CONSTRAINT ap_events_space_fkey;
  ALTER TABLE ap_spaces DROP CONSTRAINT ap_spaces_pkey;
  ALTER TABLE ap_spaces ADD PRIMARY KEY(tenant_id,slug);
  ALTER TABLE ap_messages ADD UNIQUE(tenant_id,id);
  ALTER TABLE ap_messages ADD FOREIGN KEY(tenant_id,space) REFERENCES ap_spaces(tenant_id,slug);
  ALTER TABLE ap_messages DROP CONSTRAINT ap_messages_parent_id_fkey;
  ALTER TABLE ap_messages ADD FOREIGN KEY(tenant_id,parent_id) REFERENCES ap_messages(tenant_id,id);
  ALTER TABLE ap_messages ADD FOREIGN KEY(tenant_id,thread_id) REFERENCES ap_messages(tenant_id,id) DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE ap_messages DROP CONSTRAINT ap_messages_principal_id_idempotency_key_key;
  ALTER TABLE ap_messages ADD UNIQUE(tenant_id,principal_id,idempotency_key);
  ALTER TABLE ap_files ADD FOREIGN KEY(tenant_id,space) REFERENCES ap_spaces(tenant_id,slug);
  ALTER TABLE ap_files DROP CONSTRAINT ap_files_message_id_fkey;
  ALTER TABLE ap_files ADD FOREIGN KEY(tenant_id,message_id) REFERENCES ap_messages(tenant_id,id);
  ALTER TABLE ap_receipts DROP CONSTRAINT ap_receipts_message_id_fkey;
  ALTER TABLE ap_receipts ADD FOREIGN KEY(tenant_id,message_id) REFERENCES ap_messages(tenant_id,id);
  ALTER TABLE ap_events ADD FOREIGN KEY(tenant_id,space) REFERENCES ap_spaces(tenant_id,slug);
  ALTER TABLE ap_events DROP CONSTRAINT ap_events_message_id_fkey;
  ALTER TABLE ap_events ADD FOREIGN KEY(tenant_id,message_id) REFERENCES ap_messages(tenant_id,id) ON DELETE CASCADE;
  ALTER TABLE ap_members DROP CONSTRAINT ap_members_email_key;
  ALTER TABLE ap_members DROP CONSTRAINT ap_members_user_id_key;
  ALTER TABLE ap_members ADD UNIQUE(tenant_id,email);
  ALTER TABLE ap_members ADD UNIQUE(tenant_id,user_id);
  ALTER TABLE ap_members ADD COLUMN role text NOT NULL DEFAULT 'member' CHECK(role IN ('owner','member'));
  ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS encrypted_content text;
  ALTER TABLE ap_files ADD COLUMN IF NOT EXISTS encrypted_metadata text;
  ALTER TABLE ap_files ADD COLUMN IF NOT EXISTS encrypted boolean NOT NULL DEFAULT false;
  ALTER TABLE ap_activity ADD COLUMN IF NOT EXISTS encrypted_detail text;
  -- Credentials without an accountable creator cannot survive the tenant migration.
  UPDATE ap_connections SET revoked_at=COALESCE(revoked_at,now()) WHERE created_by_user_id IS NULL;
 END IF;
END $$;
DROP INDEX IF EXISTS ap_messages_search;

CREATE TABLE IF NOT EXISTS ap_skills (
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  space text NOT NULL, slug text NOT NULL, deprecated_at timestamptz,
  deprecation_reason text, PRIMARY KEY(tenant_id,space,slug),
  FOREIGN KEY(tenant_id,space) REFERENCES ap_spaces(tenant_id,slug)
);
CREATE TABLE IF NOT EXISTS ap_skill_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  space text NOT NULL, slug text NOT NULL, revision integer NOT NULL CHECK(revision>0),
  content_hash text NOT NULL, encrypted_content text NOT NULL, principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,space,slug,revision), UNIQUE(tenant_id,space,slug,content_hash),
  FOREIGN KEY(tenant_id,space,slug) REFERENCES ap_skills(tenant_id,space,slug)
);
CREATE OR REPLACE FUNCTION ap_immutable_skill_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Skill revisions are immutable'; END $$;
DROP TRIGGER IF EXISTS ap_skill_immutable ON ap_skill_revisions;
CREATE TRIGGER ap_skill_immutable BEFORE UPDATE OR DELETE ON ap_skill_revisions
FOR EACH ROW EXECUTE FUNCTION ap_immutable_skill_revision();

-- Queries always switch away from the migration/auth role, including when that
-- role owns the tables or is a superuser. SET LOCAL and tenant context die at COMMIT.
DO $$
DECLARE tab text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='astropath_tenant') THEN
  CREATE ROLE astropath_tenant NOLOGIN NOSUPERUSER NOBYPASSRLS;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='astropath_tenant' AND (rolsuper OR rolbypassrls)) THEN
  RAISE EXCEPTION 'astropath_tenant must not bypass row security';
 END IF;
 IF NOT pg_has_role(current_user,'astropath_tenant','MEMBER') THEN
  EXECUTE format('GRANT astropath_tenant TO %I',current_user);
 END IF;
 FOREACH tab IN ARRAY ARRAY['ap_spaces','ap_connections','ap_members','ap_messages','ap_files','ap_receipts','ap_activity','ap_events','ap_skills','ap_skill_revisions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',tab);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I TO astropath_tenant USING (tenant_id=nullif(current_setting(''astropath.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''astropath.tenant_id'',true),'''')::uuid)',tab);
  -- The privileged role is reserved for auth/directory/migrations, not content stores.
  EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I',tab);
  EXECUTE format('CREATE POLICY platform_access ON %I TO %I USING (true) WITH CHECK (true)',tab,current_user);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO astropath_tenant',tab);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO astropath_tenant;
GRANT USAGE,SELECT ON SEQUENCE ap_events_id_seq,ap_activity_id_seq TO astropath_tenant;
REVOKE UPDATE,DELETE ON ap_skill_revisions FROM astropath_tenant;
