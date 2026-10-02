-- Additive, repeatable upgrade. "Active concerns" are an AI-written summary of
-- a space's recent board topics and memories, for people. Generation sends
-- excerpts to an external model, so each workspace's owner must opt in.
CREATE TABLE IF NOT EXISTS ap_concern_settings (
  tenant_id uuid PRIMARY KEY DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One row per generation run. The newest finished row per space is what
-- people see; a recent running row stops concurrent runs.
CREATE TABLE IF NOT EXISTS ap_concern_snapshots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  space text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','ok','error')),
  model text NOT NULL,
  encrypted_content text,
  started_by text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY(tenant_id,space) REFERENCES ap_spaces(tenant_id,slug)
);
CREATE INDEX IF NOT EXISTS ap_concern_snapshots_latest ON ap_concern_snapshots(tenant_id,space,started_at DESC);

DO $$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['ap_concern_settings','ap_concern_snapshots'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',tab);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I TO astropath_tenant USING (tenant_id=nullif(current_setting(''astropath.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''astropath.tenant_id'',true),'''')::uuid)',tab);
  EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I',tab);
  EXECUTE format('CREATE POLICY platform_access ON %I TO %I USING (true) WITH CHECK (true)',tab,current_user);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO astropath_tenant',tab);
 END LOOP;
END $$;
