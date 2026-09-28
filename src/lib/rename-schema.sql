-- One-time conversion from Deaddrop. Run with schema.sql in one transaction,
-- with application writers stopped. A repeat run is a no-op.
DO $$
DECLARE
  old_name text;
  new_name text;
  item record;
BEGIN
  IF to_regclass('dd_spaces') IS NULL THEN
    RETURN;
  END IF;

  FOREACH old_name IN ARRAY ARRAY[
    'dd_spaces', 'dd_connections', 'dd_members', 'dd_drops', 'dd_files',
    'dd_receipts', 'dd_activity', 'dd_events', 'dd_rate_limits'
  ] LOOP
    new_name := replace(replace(old_name, 'dd_', 'ap_'), 'drops', 'messages');
    IF to_regclass(new_name) IS NOT NULL THEN
      RAISE EXCEPTION 'Both legacy and Astropath tables exist (% and %); resolve before migrating', old_name, new_name;
    END IF;
    IF to_regclass(old_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME TO %I', old_name, new_name);
    END IF;
  END LOOP;

  FOREACH new_name IN ARRAY ARRAY['ap_files', 'ap_receipts', 'ap_events'] LOOP
    IF to_regclass(new_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN drop_id TO message_id', new_name);
    END IF;
  END LOOP;

  -- Keep IDs, foreign keys, files and receipts. Old credentials are deliberately
  -- revoked so users can recreate the same connection names with the new scopes.
  UPDATE ap_connections SET revoked_at=COALESCE(revoked_at, now()),
    scopes=ARRAY(SELECT replace(scope, 'deaddrop:', 'astropath:') FROM unnest(scopes) AS scope);

  IF to_regclass('ap_events') IS NOT NULL THEN
    ALTER TABLE ap_events DROP CONSTRAINT dd_events_type_check;
    UPDATE ap_events SET type=replace(type, 'drop.', 'message.');
    ALTER TABLE ap_events ADD CONSTRAINT ap_events_type_check
      CHECK(type IN ('message.created','message.updated','message.acknowledged'));
  END IF;

  -- Renaming primary/unique constraints also renames their backing indexes.
  FOR item IN
    SELECT t.relname AS table_name, c.conname AS name
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname=current_schema() AND t.relname=ANY(ARRAY[
      'ap_spaces','ap_connections','ap_members','ap_messages','ap_files',
      'ap_receipts','ap_activity','ap_events','ap_rate_limits'
    ]) AND starts_with(c.conname, 'dd_')
  LOOP
    new_name := replace(replace(replace(item.name, 'dd_', 'ap_'), 'drops', 'messages'), 'drop', 'message');
    EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', item.table_name, item.name, new_name);
  END LOOP;

  FOR item IN
    SELECT c.relname AS name, c.relkind AS kind FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind IN ('i','S') AND starts_with(c.relname, 'dd_')
  LOOP
    new_name := replace(replace(replace(item.name, 'dd_', 'ap_'), 'drops', 'messages'), 'drop', 'message');
    IF item.kind='S' THEN
      EXECUTE format('ALTER SEQUENCE %I RENAME TO %I', item.name, new_name);
    ELSE
      EXECUTE format('ALTER INDEX %I RENAME TO %I', item.name, new_name);
    END IF;
  END LOOP;
END $$;
