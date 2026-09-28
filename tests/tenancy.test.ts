import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import { tenantDatabase, type Database, type Queryable } from "../src/lib/db";
import { migrateTenancy, INITIAL_TENANT } from "../src/lib/tenant-migration";
import { newTenantKey, contentCipher, seal, open } from "../src/lib/encryption";
import { MessageStore } from "../src/lib/store";
import { SkillStore } from "../src/lib/skills";
import { userPrincipal, connectionSpaces } from "../src/lib/access";
import type { Principal } from "../src/lib/policy";

const engine = new PGlite();
function adapter(client: Pick<PGlite, "query" | "exec">): Queryable {
  return {
    query: async <T extends QueryResultRow>(
      sql: string,
      values?: unknown[],
    ) => {
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (!values) {
        const results = await client.exec(sql);
        return { rows: (results.at(-1)?.rows ?? []) as T[] };
      }
      return { rows: (await client.query<T>(sql, values)).rows };
    },
  };
}
const directory: Database = {
  ...adapter(engine),
  transaction: (fn) => engine.transaction((tx) => fn(adapter(tx))),
};
const database: Database = {
  ...directory,
  forTenant: (id) => tenantDatabase(id, directory),
};
const messages = new MessageStore(database);
const skills = new SkillStore(database);
const second = randomUUID();
let owner: Principal;
let other: Principal;

beforeAll(async () => {
  process.env.ASTROPATH_MASTER_KEY = randomBytes(32).toString("base64");
  process.env.OWNER_EMAIL = "owner@example.com";
  await engine.exec(`CREATE TABLE "user"(id text PRIMARY KEY,name text,email text);
    INSERT INTO "user" VALUES('owner','Owner','owner@example.com'),('other','Other','other@example.com');`);
  await engine.exec(
    await readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8"),
  );
  // Exercise encryption of existing content, not just empty schema creation.
  const id = randomUUID();
  await directory.query(
    "INSERT INTO ap_messages(id,space,title,body,sender,principal_id,thread_id) VALUES($1,'general','Legacy title','Legacy body','Owner','owner:owner',$1)",
    [id],
  );
  await directory.query(
    "INSERT INTO ap_files(id,space,name,content_type,size,pathname,principal_id,message_id) VALUES($1,'general','legacy-secret.txt','text/plain',1,'old-path','owner:owner',$2)",
    [randomUUID(), id],
  );
  await directory.query(
    "INSERT INTO ap_activity(actor,action,target_id,detail) VALUES('Owner','created',$1,'Legacy activity detail')",
    [id],
  );
  await directory.query(
    "INSERT INTO ap_events(type,space,message_id,actor_id,actor,data) VALUES('message.created','general',$1,'owner:owner','Owner',$2::jsonb)",
    [id, JSON.stringify({ title: "Legacy event title" })],
  );
  await directory.transaction(migrateTenancy);
  await directory.transaction(migrateTenancy);
  await directory.query(
    "INSERT INTO ap_tenants(id,name,wrapped_key) VALUES($1,'Second',$2)",
    [second, newTenantKey(second)],
  );
  await directory.query(
    "INSERT INTO ap_spaces(tenant_id,slug,name) VALUES($1,'general','General')",
    [second],
  );
  await directory.query(
    "INSERT INTO ap_members(id,tenant_id,email,name,user_id,spaces,role) VALUES($1,$2,'other@example.com','Other','other',ARRAY['general'],'owner')",
    [randomUUID(), second],
  );
  owner = (await userPrincipal(directory, "owner", INITIAL_TENANT))!;
  other = (await userPrincipal(directory, "other", second))!;
});
afterAll(async () => {
  await engine.close();
});

it("keeps platform administration separate from content membership", async () => {
  expect(owner).toMatchObject({
    platformAdmin: true,
    owner: true,
    tenantId: INITIAL_TENANT,
  });
  expect(await userPrincipal(directory, "owner", second)).toBeNull();
  await expect(
    connectionSpaces(directory, null, "owner", second),
  ).rejects.toMatchObject({ status: 403 });
});
it("supports the same person in multiple tenants with independent roles", async () => {
  await directory.query(
    "INSERT INTO ap_members(id,tenant_id,email,name,user_id,spaces) VALUES($1,$2,'owner@example.com','Owner','owner',ARRAY['general'])",
    [randomUUID(), second],
  );
  expect(await userPrincipal(directory, "owner", second)).toMatchObject({
    owner: false,
    platformAdmin: true,
    tenantId: second,
    spaces: ["general"],
  });
  await directory.query(
    "UPDATE ap_members SET disabled_at=now() WHERE tenant_id=$1 AND user_id='owner'",
    [second],
  );
  expect(await userPrincipal(directory, "owner", second)).toBeNull();
  expect(
    await userPrincipal(directory, "owner", INITIAL_TENANT),
  ).not.toBeNull();
});
it("encrypts migrated and new messages and isolates reads, writes, references, and searches", async () => {
  expect((await messages.list(owner, {})).messages[0].body).toBe("Legacy body");
  const legacyFile = (
    await directory.query<{
      id: string;
      name: string;
      encrypted_metadata: string;
    }>("SELECT id,name,encrypted_metadata FROM ap_files LIMIT 1")
  ).rows[0];
  expect(legacyFile.name).toBe("");
  expect((await messages.file(owner, legacyFile.id)).name).toBe(
    "legacy-secret.txt",
  );
  const activity = (
    await directory.query(
      "SELECT detail,encrypted_detail FROM ap_activity LIMIT 1",
    )
  ).rows[0];
  expect(activity.detail).toBeNull();
  expect(String(activity.encrypted_detail)).not.toContain(
    "Legacy activity detail",
  );
  expect(
    JSON.stringify((await directory.query("SELECT data FROM ap_events")).rows),
  ).not.toContain("Legacy event title");
  const { message } = await messages.create(owner, {
    title: "Secret title",
    body: "Private tenant body",
    tags: ["private"],
  });
  expect((await messages.get(owner, message.id)).title).toBe("Secret title");
  expect((await messages.list(other, {})).messages).toEqual([]);
  await expect(messages.get(other, message.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    messages.create(other, { title: "Bad reply", parent_id: message.id }),
  ).rejects.toMatchObject({ status: 404 });
  const raw = (
    await directory.query(
      "SELECT title,body,tags,encrypted_content FROM ap_messages WHERE id=$1",
      [message.id],
    )
  ).rows[0];
  expect(raw.title).toBe("");
  expect(raw.body).toBe("");
  expect(raw.tags).toEqual([]);
  expect(JSON.stringify(raw)).not.toContain("Private tenant body");
  expect(
    (await messages.list(owner, { q: "private tenant" })).messages.map(
      (m) => m.id,
    ),
  ).toEqual([message.id]);
  const scoped = await tenantDatabase(second, directory);
  await expect(
    scoped.query(
      "INSERT INTO ap_receipts(message_id,principal_id) VALUES($1,'other')",
      [message.id],
    ),
  ).rejects.toThrow();
  await expect(
    scoped.query(
      "INSERT INTO ap_spaces(tenant_id,slug,name) VALUES($1,'escape','Escape')",
      [INITIAL_TENANT],
    ),
  ).rejects.toThrow();
  expect(
    (await scoped.query("SELECT * FROM ap_messages WHERE id=$1", [message.id]))
      .rows,
  ).toEqual([]);
});

it("paginates skills with the same slug in different spaces without skipping revisions", async () => {
  await directory.query(
    "INSERT INTO ap_spaces(tenant_id,slug,name) VALUES($1,'other','Other')",
    [second],
  );
  await skills.publish(other, {
    space: "general",
    slug: "review",
    files: { "SKILL.md": "General space" },
  });
  await skills.publish(other, {
    space: "other",
    slug: "review",
    files: { "SKILL.md": "Other space" },
  });
  const first = await skills.list(other, { limit: 1 });
  expect(first.next_cursor).not.toBeNull();
  const secondPage = await skills.list(other, {
    limit: 1,
    after: first.next_cursor,
  });
  expect(secondPage.skills[0].space).not.toBe(first.skills[0].space);
  expect(secondPage.next_cursor).toBeNull();
  await expect(
    skills.pull(
      { ...other, spaces: ["general"] },
      { space: "other", slug: "review" },
    ),
  ).rejects.toMatchObject({ status: 404 });
});
it("publishes immutable skill revisions, deduplicates retries, and deprecates without changing history", async () => {
  const input = {
    slug: "review",
    files: {
      "SKILL.md": "# Review\nCheck the patch.",
      "references/rules.md": "Be precise.",
    },
  };
  const first = await skills.publish(owner, input);
  const retry = await skills.publish(owner, input);
  expect(retry.id).toBe(first.id);
  expect(retry.replayed).toBe(true);
  const next = await skills.publish(owner, {
    ...input,
    files: { "SKILL.md": "# Review\nCheck tests too." },
  });
  expect(next.revision).toBe(2);
  expect(
    (await skills.pull(owner, { slug: "review", revision_id: first.id })).files,
  ).toEqual(input.files);
  expect((await skills.pull(owner, { slug: "review" })).id).toBe(next.id);
  await expect(
    skills.pull(other, { slug: "review", revision_id: first.id }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    skills.publish({ ...owner, scopes: ["astropath:read"] }, input),
  ).rejects.toMatchObject({ status: 403 });
  await skills.deprecate(owner, {
    slug: "review",
    reason: "Use the new reviewer",
  });
  expect((await skills.list(owner, {})).skills).toEqual([]);
  expect(
    (await skills.list(owner, { include_deprecated: true })).skills,
  ).toHaveLength(1);
  await expect(skills.pull(owner, { slug: "review" })).rejects.toMatchObject({
    code: "skill_deprecated",
  });
  expect(
    (await skills.pull(owner, { slug: "review", revision_id: first.id }))
      .deprecation_reason,
  ).toBe("Use the new reviewer");
  await expect(skills.publish(owner, input)).rejects.toMatchObject({
    code: "skill_deprecated",
  });
  const scoped = await tenantDatabase(INITIAL_TENANT, directory);
  await expect(
    scoped.query(
      "UPDATE ap_skill_revisions SET content_hash='tamper' WHERE id=$1",
      [first.id],
    ),
  ).rejects.toThrow();
  await expect(
    directory.query("DELETE FROM ap_skill_revisions WHERE id=$1", [first.id]),
  ).rejects.toThrow("immutable");
  await skills.deprecate(owner, { slug: "review", deprecated: false });
  expect((await skills.pull(owner, { slug: "review" })).id).toBe(next.id);
});
it("rejects unsafe skill paths and authenticates ciphertext tenant/record binding", async () => {
  await expect(
    skills.publish(owner, {
      slug: "bad",
      files: { "SKILL.md": "safe", "../escape": "bad" },
    }),
  ).rejects.toThrow();
  const key = randomBytes(32);
  const encrypted = seal(key, "tenant:record", Buffer.from("secret"));
  expect(open(key, "tenant:record", encrypted).toString()).toBe("secret");
  expect(() => open(key, "other:record", encrypted)).toThrow();
  expect(() => open(randomBytes(32), "tenant:record", encrypted)).toThrow();
  const bytes = Buffer.from(encrypted.slice(3), "base64url");
  bytes[bytes.length - 1] ^= 1;
  expect(() =>
    open(key, "tenant:record", `v1.${bytes.toString("base64url")}`),
  ).toThrow();
  const cipher = contentCipher("tenant", key);
  expect(
    cipher.decryptBytes(
      "file",
      cipher.encryptBytes("file", Buffer.from([0, 255])),
    ),
  ).toEqual(Buffer.from([0, 255]));
});
