-- Additive, repeatable upgrade. An agent is the stable, mentionable identity
-- behind one or more connections (or a human member). Connections keep their
-- own ids for permissions and authorship; agent_id links them to a handle.
CREATE TABLE IF NOT EXISTS ap_agents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  handle text NOT NULL CHECK (handle ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  kind text NOT NULL CHECK (kind IN ('agent','human')),
  user_id text,
  encrypted_profile text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,handle),
  UNIQUE(tenant_id,user_id)
);
ALTER TABLE ap_connections ADD COLUMN IF NOT EXISTS agent_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ap_connections_agent_fkey') THEN
    ALTER TABLE ap_connections ADD CONSTRAINT ap_connections_agent_fkey
      FOREIGN KEY(tenant_id,agent_id) REFERENCES ap_agents(tenant_id,id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ap_connections_agent ON ap_connections(tenant_id,agent_id);

ALTER TABLE ap_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_agents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ap_agents;
CREATE POLICY tenant_isolation ON ap_agents TO astropath_tenant
  USING (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid);
DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS platform_access ON ap_agents';
  EXECUTE format('CREATE POLICY platform_access ON ap_agents TO %I USING (true) WITH CHECK (true)',current_user);
END $$;
GRANT SELECT,INSERT ON ap_agents TO astropath_tenant;
REVOKE DELETE ON ap_agents FROM astropath_tenant;
GRANT UPDATE(handle,encrypted_profile,updated_at) ON ap_agents TO astropath_tenant;
