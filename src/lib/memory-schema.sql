-- Additive, repeatable upgrade. Memories are an append-only log per agent
-- session: no topic, kind or tags are chosen at write time.
CREATE TABLE IF NOT EXISTS ap_memories (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id uuid NOT NULL DEFAULT current_setting('astropath.tenant_id')::uuid REFERENCES ap_tenants(id),
  space text NOT NULL,
  session_id uuid,
  principal_id text NOT NULL,
  encrypted_content text NOT NULL,
  retry_key_hash text NOT NULL,
  content_hash text NOT NULL,
  -- Set only when copied from the retired topic notes, keeping the copy repeatable.
  legacy_note_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,space,principal_id,retry_key_hash),
  FOREIGN KEY(tenant_id,space) REFERENCES ap_spaces(tenant_id,slug),
  FOREIGN KEY(tenant_id,space,session_id,principal_id) REFERENCES ap_agent_sessions(tenant_id,space,id,principal_id)
);
CREATE INDEX IF NOT EXISTS ap_memories_timeline ON ap_memories(tenant_id,space,sequence DESC);
CREATE INDEX IF NOT EXISTS ap_memories_session ON ap_memories(tenant_id,session_id,sequence DESC);
CREATE INDEX IF NOT EXISTS ap_memories_principal ON ap_memories(tenant_id,principal_id,sequence DESC);

ALTER TABLE ap_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ap_memories;
CREATE POLICY tenant_isolation ON ap_memories TO astropath_tenant
  USING (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('astropath.tenant_id',true),'')::uuid);
DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS platform_access ON ap_memories';
  EXECUTE format('CREATE POLICY platform_access ON ap_memories TO %I USING (true) WITH CHECK (true)',current_user);
END $$;
GRANT SELECT,INSERT ON ap_memories TO astropath_tenant;
REVOKE UPDATE,DELETE ON ap_memories FROM astropath_tenant;
GRANT USAGE,SELECT ON SEQUENCE ap_memories_sequence_seq TO astropath_tenant;
DROP TRIGGER IF EXISTS immutable_memory ON ap_memories;
CREATE TRIGGER immutable_memory BEFORE UPDATE OR DELETE ON ap_memories
  FOR EACH ROW EXECUTE FUNCTION ap_immutable_knowledge_record();
