CREATE TABLE IF NOT EXISTS dd_spaces (
  slug text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO dd_spaces (slug, name) VALUES ('general', 'General') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS dd_connections (
  id uuid PRIMARY KEY, name text NOT NULL, kind text NOT NULL CHECK (kind IN ('token','oauth')),
  token_hash text UNIQUE, token_prefix text, oauth_client_id text UNIQUE,
  scopes text[] NOT NULL, spaces text[], created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz, expires_at timestamptz, revoked_at timestamptz
);

-- Keep oauth_client_id for legacy grants; named authorizations have independent IDs.
ALTER TABLE dd_connections ADD COLUMN IF NOT EXISTS oauth_authorization_client_id text;
ALTER TABLE dd_connections ADD COLUMN IF NOT EXISTS oauth_user_id text;
ALTER TABLE dd_connections ADD COLUMN IF NOT EXISTS oauth_approval_key text;
CREATE UNIQUE INDEX IF NOT EXISTS dd_connections_approval_key ON dd_connections(oauth_approval_key);
ALTER TABLE dd_connections ADD COLUMN IF NOT EXISTS created_by_user_id text;
CREATE INDEX IF NOT EXISTS dd_connections_creator ON dd_connections(created_by_user_id);

CREATE TABLE IF NOT EXISTS dd_members (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
  user_id text UNIQUE, spaces text[] NOT NULL CHECK(cardinality(spaces)>0),
  invite_hash text UNIQUE, invite_expires_at timestamptz,
  disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dd_drops (
  id uuid PRIMARY KEY, space text NOT NULL REFERENCES dd_spaces(slug),
  title text NOT NULL, body text NOT NULL DEFAULT '', sender text NOT NULL,
  principal_id text NOT NULL, recipient text, tags text[] NOT NULL DEFAULT '{}',
  parent_id uuid REFERENCES dd_drops(id), thread_id uuid NOT NULL,
  pinned boolean NOT NULL DEFAULT false, archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), idempotency_key text,
  request_hash text, UNIQUE(principal_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS dd_drops_order ON dd_drops(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS dd_drops_space ON dd_drops(space, created_at DESC);
CREATE INDEX IF NOT EXISTS dd_drops_thread ON dd_drops(thread_id, created_at);
CREATE INDEX IF NOT EXISTS dd_drops_search ON dd_drops USING gin(to_tsvector('english', title || ' ' || body));

CREATE TABLE IF NOT EXISTS dd_files (
  id uuid PRIMARY KEY, space text NOT NULL REFERENCES dd_spaces(slug),
  name text NOT NULL, content_type text NOT NULL, size bigint NOT NULL,
  pathname text UNIQUE NOT NULL, principal_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  drop_id uuid REFERENCES dd_drops(id), created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz
);
CREATE INDEX IF NOT EXISTS dd_files_drop ON dd_files(drop_id);

CREATE TABLE IF NOT EXISTS dd_receipts (
  drop_id uuid NOT NULL REFERENCES dd_drops(id), principal_id text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(drop_id, principal_id)
);

CREATE TABLE IF NOT EXISTS dd_activity (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor text NOT NULL,
  action text NOT NULL, target_id text, detail text, created_at timestamptz NOT NULL DEFAULT now()
);

-- Durable HTTP notifications. Writers serialize ID allocation until commit so a
-- reconnect cursor can never skip a lower ID from a still-open transaction.
CREATE TABLE IF NOT EXISTS dd_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL CHECK(type IN ('drop.created','drop.updated','drop.acknowledged')),
  space text NOT NULL REFERENCES dd_spaces(slug), recipient text,
  drop_id uuid NOT NULL REFERENCES dd_drops(id) ON DELETE CASCADE,
  actor_id text NOT NULL, actor text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS dd_events_space_order ON dd_events(space,id);
CREATE INDEX IF NOT EXISTS dd_events_recipient_order ON dd_events(recipient,id);

CREATE TABLE IF NOT EXISTS dd_rate_limits (
  key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
);
