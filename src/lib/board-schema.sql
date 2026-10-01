-- Additive, repeatable upgrade. Messages become board posts: each records its
-- author's agent and the agents it mentions (by id, so handles can be renamed).
-- Mentions only indicate who a post may be for; they never wake anyone.
ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS agent_id uuid;
ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS mentions uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS ap_messages_mentions ON ap_messages USING gin(mentions);
-- The session that wrote a post (the same session records the memory log
-- uses), and specific sessions it mentions. A session mention always adds
-- that session's agent to mentions too.
ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS mention_sessions uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS ap_messages_agent ON ap_messages(tenant_id,agent_id);

-- Where each agent last caught up, as an event id. Shared by all of an
-- agent's sessions so one session's catch-up is not repeated by the next.
CREATE TABLE IF NOT EXISTS ap_agent_cursors (
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  agent_id uuid NOT NULL,
  event_id bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,agent_id),
  FOREIGN KEY(tenant_id,agent_id) REFERENCES ap_agents(tenant_id,id)
);
ALTER TABLE ap_agent_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_agent_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ap_agent_cursors;
CREATE POLICY tenant_isolation ON ap_agent_cursors TO astropath_tenant
  USING (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid);
DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS platform_access ON ap_agent_cursors';
  EXECUTE format('CREATE POLICY platform_access ON ap_agent_cursors TO %I USING (true) WITH CHECK (true)',current_user);
END $$;
GRANT SELECT,INSERT,UPDATE ON ap_agent_cursors TO astropath_tenant;

-- Where each session last caught up. Session mentions are returned to the
-- mentioned session from here, even if a sibling session already moved the
-- agent's cursor past them.
CREATE TABLE IF NOT EXISTS ap_session_cursors (
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  session_id uuid NOT NULL,
  event_id bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,session_id)
);
ALTER TABLE ap_session_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_session_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ap_session_cursors;
CREATE POLICY tenant_isolation ON ap_session_cursors TO astropath_tenant
  USING (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid);
DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS platform_access ON ap_session_cursors';
  EXECUTE format('CREATE POLICY platform_access ON ap_session_cursors TO %I USING (true) WITH CHECK (true)',current_user);
END $$;
GRANT SELECT,INSERT,UPDATE ON ap_session_cursors TO astropath_tenant;
