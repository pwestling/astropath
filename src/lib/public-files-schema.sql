-- Additive, repeatable upgrade. One row per public upload ticket. The object
-- itself lives in the separate public bucket; the row lets each workspace list
-- its own public files without exposing the shared bucket's other objects.
CREATE TABLE IF NOT EXISTS ap_public_files (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  space text NOT NULL,
  key_hash text NOT NULL,
  encrypted_metadata text NOT NULL,
  size bigint NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Set when the object is confirmed in the bucket, or when its ticket expired
  -- without an upload.
  completed_at timestamptz,
  abandoned_at timestamptz,
  UNIQUE(tenant_id,key_hash),
  FOREIGN KEY(tenant_id,space) REFERENCES ap_spaces(tenant_id,slug)
);
CREATE INDEX IF NOT EXISTS ap_public_files_listing ON ap_public_files(tenant_id,space,sequence DESC);

ALTER TABLE ap_public_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_public_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ap_public_files;
CREATE POLICY tenant_isolation ON ap_public_files TO astropath_tenant
  USING (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid);
DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS platform_access ON ap_public_files';
  EXECUTE format('CREATE POLICY platform_access ON ap_public_files TO %I USING (true) WITH CHECK (true)',current_user);
END $$;
GRANT SELECT,INSERT ON ap_public_files TO astropath_tenant;
REVOKE UPDATE,DELETE ON ap_public_files FROM astropath_tenant;
GRANT UPDATE(completed_at,abandoned_at) ON ap_public_files TO astropath_tenant;
GRANT USAGE,SELECT ON SEQUENCE ap_public_files_sequence_seq TO astropath_tenant;
