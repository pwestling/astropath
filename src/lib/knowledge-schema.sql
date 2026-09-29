-- Additive, repeatable upgrade. Topic ancestry is fixed; only humans archive.
CREATE TABLE IF NOT EXISTS ap_topics (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  space text NOT NULL,
  parent_id uuid,
  name_hash text NOT NULL,
  encrypted_name text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by text,
  UNIQUE(tenant_id,space,id),
  UNIQUE NULLS NOT DISTINCT(tenant_id,space,parent_id,name_hash),
  FOREIGN KEY(tenant_id,space) REFERENCES ap_spaces(tenant_id,slug),
  FOREIGN KEY(tenant_id,space,parent_id) REFERENCES ap_topics(tenant_id,space,id)
);
CREATE INDEX IF NOT EXISTS ap_topics_parent ON ap_topics(tenant_id,space,parent_id);

CREATE TABLE IF NOT EXISTS ap_agent_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  space text NOT NULL,
  principal_id text NOT NULL,
  session_key_hash text NOT NULL,
  encrypted_content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,space,id,principal_id),
  UNIQUE(tenant_id,space,principal_id,session_key_hash),
  FOREIGN KEY(tenant_id,space) REFERENCES ap_spaces(tenant_id,slug)
);
CREATE TABLE IF NOT EXISTS ap_topic_notes (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  space text NOT NULL,
  topic_id uuid NOT NULL,
  session_id uuid,
  principal_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('note','progress','milestone','decision','question','handoff')),
  encrypted_content text NOT NULL,
  retry_key_hash text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,space,principal_id,retry_key_hash),
  FOREIGN KEY(tenant_id,space,topic_id) REFERENCES ap_topics(tenant_id,space,id),
  FOREIGN KEY(tenant_id,space,session_id,principal_id) REFERENCES ap_agent_sessions(tenant_id,space,id,principal_id)
);
CREATE INDEX IF NOT EXISTS ap_topic_notes_timeline ON ap_topic_notes(tenant_id,space,topic_id,sequence DESC);

CREATE OR REPLACE FUNCTION ap_immutable_knowledge_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Session identities and topic notes are immutable'; END $$;
DO $$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['ap_topics','ap_agent_sessions','ap_topic_notes'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',tab);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I TO astropath_tenant USING (tenant_id=nullif(current_setting(''astropath.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''astropath.tenant_id'',true),'''')::uuid)',tab);
  EXECUTE format('DROP POLICY IF EXISTS platform_access ON %I',tab);
  EXECUTE format('CREATE POLICY platform_access ON %I TO %I USING (true) WITH CHECK (true)',tab,current_user);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO astropath_tenant',tab);
  EXECUTE format('REVOKE UPDATE,DELETE ON %I FROM astropath_tenant',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['ap_agent_sessions','ap_topic_notes'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS immutable_knowledge_record ON %I',tab);
  EXECUTE format('CREATE TRIGGER immutable_knowledge_record BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ap_immutable_knowledge_record()',tab);
 END LOOP;
END $$;
GRANT UPDATE(archived_at,archived_by) ON ap_topics TO astropath_tenant;
GRANT USAGE,SELECT ON SEQUENCE ap_topic_notes_sequence_seq TO astropath_tenant;
