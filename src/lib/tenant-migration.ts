import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Queryable } from "./db";
import { newTenantKey, unwrapTenantKey, contentCipher } from "./encryption";
import { ownerEmail } from "./config";
import { migrateTopicNotes } from "./memory";

export const INITIAL_TENANT = "00000000-0000-4000-8000-000000000001";

// Transactional database upgrade; see docs/tenant-migration.md for backup/rollback.
export async function migrateTenancy(tx: Queryable) {
  await tx.query(`CREATE TABLE IF NOT EXISTS ap_tenants (
    id uuid PRIMARY KEY,name text NOT NULL,wrapped_key text NOT NULL,
    disabled_at timestamptz,created_at timestamptz NOT NULL DEFAULT now())`);
  const existing = await tx.query("SELECT id FROM ap_tenants WHERE id=$1", [
    INITIAL_TENANT,
  ]);
  if (!existing.rows.length)
    await tx.query(
      "INSERT INTO ap_tenants(id,name,wrapped_key) VALUES($1,'Personal',$2)",
      [INITIAL_TENANT, newTenantKey(INITIAL_TENANT)],
    );
  await tx.query("SELECT set_config('astropath.tenant_id',$1,true)", [
    INITIAL_TENANT,
  ]);
  await tx.query(
    await readFile(new URL("./tenant-schema.sql", import.meta.url), "utf8"),
  );
  await tx.query(
    await readFile(new URL("./knowledge-schema.sql", import.meta.url), "utf8"),
  );
  await tx.query(
    await readFile(new URL("./memory-schema.sql", import.meta.url), "utf8"),
  );
  const owner = (
    await tx.query<{ id: string; name: string; email: string }>(
      `SELECT id,name,email FROM "user" WHERE lower(email)=$1`,
      [ownerEmail()],
    )
  ).rows[0];
  if (owner)
    await tx.query(
      `INSERT INTO ap_members(id,tenant_id,email,name,user_id,spaces,role)
      VALUES($1,$2,$3,$4,$5,ARRAY['general'],'owner') ON CONFLICT(tenant_id,user_id) DO NOTHING`,
      [
        randomUUID(),
        INITIAL_TENANT,
        owner.email.toLowerCase(),
        owner.name,
        owner.id,
      ],
    );
  const tenants = (
    await tx.query<{ id: string; wrapped_key: string }>(
      "SELECT id,wrapped_key FROM ap_tenants",
    )
  ).rows;
  for (const tenant of tenants) {
    const cipher = contentCipher(
      tenant.id,
      unwrapTenantKey(tenant.id, tenant.wrapped_key),
    );
    const messages = (
      await tx.query<{
        id: string;
        title: string;
        body: string;
        tags: string[];
      }>(
        "SELECT id,title,body,tags FROM ap_messages WHERE tenant_id=$1 AND encrypted_content IS NULL",
        [tenant.id],
      )
    ).rows;
    for (const message of messages)
      await tx.query(
        "UPDATE ap_messages SET title='',body='',tags='{}',encrypted_content=$2 WHERE id=$1",
        [
          message.id,
          cipher.encrypt(`message:${message.id}`, {
            title: message.title,
            body: message.body,
            tags: message.tags,
          }),
        ],
      );
    const files = (
      await tx.query<{ id: string; name: string; content_type: string }>(
        "SELECT id,name,content_type FROM ap_files WHERE tenant_id=$1 AND encrypted_metadata IS NULL",
        [tenant.id],
      )
    ).rows;
    for (const file of files)
      await tx.query(
        "UPDATE ap_files SET name='',content_type='application/octet-stream',encrypted_metadata=$2 WHERE id=$1",
        [
          file.id,
          cipher.encrypt(`file-metadata:${file.id}`, {
            name: file.name,
            content_type: file.content_type,
          }),
        ],
      );
    const events = (
      await tx.query<{
        id: string;
        message_id: string;
        type: string;
        data: object;
      }>(
        "SELECT id,message_id,type,data FROM ap_events WHERE tenant_id=$1 AND NOT(data ? 'sealed')",
        [tenant.id],
      )
    ).rows;
    for (const event of events)
      await tx.query("UPDATE ap_events SET data=$2::jsonb WHERE id=$1", [
        event.id,
        JSON.stringify({
          sealed: cipher.encrypt(
            `event:${event.message_id}:${event.type}`,
            event.data,
          ),
        }),
      ]);
    const activity = (
      await tx.query<{ id: string; detail: string }>(
        "SELECT id,detail FROM ap_activity WHERE tenant_id=$1 AND detail IS NOT NULL AND encrypted_detail IS NULL",
        [tenant.id],
      )
    ).rows;
    for (const item of activity)
      await tx.query(
        "UPDATE ap_activity SET detail=NULL,encrypted_detail=$2 WHERE id=$1",
        [item.id, cipher.encrypt(`activity:${item.id}`, item.detail)],
      );
    await migrateTopicNotes(tx, tenant.id, cipher);
  }
}
