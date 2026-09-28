import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";

const engine = new PGlite();
const messageId = "11111111-1111-4111-8111-111111111111";
const replyId = "22222222-2222-4222-8222-222222222222";
const fileId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";
let rename: string;
let schema: string;

beforeAll(async () => {
  const legacy = await readFile(
    new URL("./fixtures/deaddrop-schema.sql", import.meta.url),
    "utf8",
  );
  rename = await readFile(
    new URL("../src/lib/rename-schema.sql", import.meta.url),
    "utf8",
  );
  schema = await readFile(
    new URL("../src/lib/schema.sql", import.meta.url),
    "utf8",
  );
  await engine.exec(legacy);
  await engine.query(
    "INSERT INTO dd_connections(id,name,kind,scopes) VALUES($1,'Muse','token',ARRAY['deaddrop:read','deaddrop:write'])",
    [connectionId],
  );
  await engine.query(
    "INSERT INTO dd_drops(id,space,title,sender,principal_id,thread_id,idempotency_key,request_hash) VALUES($1,'general','Original message','Muse',$2,$1,'original-key','original-hash')",
    [messageId, connectionId],
  );
  await engine.query(
    "INSERT INTO dd_drops(id,space,title,sender,principal_id,thread_id,parent_id) VALUES($1,'general','Reply','Muse',$2,$3,$3)",
    [replyId, connectionId, messageId],
  );
  await engine.query(
    "INSERT INTO dd_files(id,space,name,content_type,size,pathname,principal_id,status,drop_id) VALUES($1,'general','original.txt','text/plain',3,'private/original.txt',$2,'ready',$3)",
    [fileId, connectionId, messageId],
  );
  await engine.query(
    "INSERT INTO dd_receipts(drop_id,principal_id) VALUES($1,'reader')",
    [messageId],
  );
  await engine.query(
    "INSERT INTO dd_events(type,space,drop_id,actor_id,actor,data) VALUES('drop.created','general',$1,$2,'Muse','{}')",
    [messageId, connectionId],
  );
  await engine.query(
    "INSERT INTO dd_members(id,email,name,user_id,spaces) VALUES($1,'member@example.com','Member','user-1',ARRAY['general'])",
    [fileId],
  );
  await engine.transaction(async (tx) => {
    await tx.exec(rename);
    await tx.exec(schema);
  });
});
afterAll(() => engine.close());

it("preserves messages, thread lineage, original file paths, receipts, and memberships", async () => {
  expect(
    (
      await engine.query(
        "SELECT title,idempotency_key,request_hash FROM ap_messages WHERE id=$1",
        [messageId],
      )
    ).rows,
  ).toEqual([
    {
      title: "Original message",
      idempotency_key: "original-key",
      request_hash: "original-hash",
    },
  ]);
  expect(
    (
      await engine.query(
        "SELECT parent_id,thread_id FROM ap_messages WHERE id=$1",
        [replyId],
      )
    ).rows,
  ).toEqual([{ parent_id: messageId, thread_id: messageId }]);
  expect(
    (
      await engine.query(
        "SELECT message_id,pathname FROM ap_files WHERE id=$1",
        [fileId],
      )
    ).rows,
  ).toEqual([{ message_id: messageId, pathname: "private/original.txt" }]);
  expect(
    (await engine.query("SELECT message_id,principal_id FROM ap_receipts"))
      .rows,
  ).toEqual([{ message_id: messageId, principal_id: "reader" }]);
  expect(
    (await engine.query("SELECT user_id,spaces FROM ap_members")).rows,
  ).toEqual([{ user_id: "user-1", spaces: ["general"] }]);
  await expect(
    engine.query("DELETE FROM ap_messages WHERE id=$1", [messageId]),
  ).rejects.toThrow();
});

it("revokes old connections while preserving historical sender IDs", async () => {
  const { rows } = await engine.query<{
    id: string;
    scopes: string[];
    revoked: boolean;
  }>("SELECT id,scopes,revoked_at IS NOT NULL AS revoked FROM ap_connections");
  expect(rows).toEqual([
    {
      id: connectionId,
      scopes: ["astropath:read", "astropath:write"],
      revoked: true,
    },
  ]);
});

it("preserves replay cursors and continues the renamed event sequence", async () => {
  expect(
    (await engine.query("SELECT id::text,type,message_id FROM ap_events")).rows,
  ).toEqual([{ id: "1", type: "message.created", message_id: messageId }]);
  expect(
    (
      await engine.query(
        "SELECT pg_sequence_last_value('ap_events_id_seq'::regclass)::text AS id",
      )
    ).rows,
  ).toEqual([{ id: "1" }]);
  expect(
    (
      await engine.query(
        "INSERT INTO ap_events(type,space,message_id,actor_id,actor,data) VALUES('message.updated','general',$1,'writer','Muse','{}') RETURNING id::text",
        [messageId],
      )
    ).rows,
  ).toEqual([{ id: "2" }]);
});

it("can run again without revoking new connections or leaving old index names", async () => {
  await engine.query(
    "INSERT INTO ap_connections(id,name,kind,scopes) VALUES($1,'New Muse','token',ARRAY['astropath:read'])",
    [replyId],
  );
  await engine.transaction(async (tx) => {
    await tx.exec(rename);
    await tx.exec(schema);
  });
  expect(
    (
      await engine.query("SELECT revoked_at FROM ap_connections WHERE id=$1", [
        replyId,
      ])
    ).rows,
  ).toEqual([{ revoked_at: null }]);
  expect(
    (
      await engine.query(
        "SELECT relname FROM pg_class WHERE starts_with(relname,'dd_')",
      )
    ).rows,
  ).toEqual([]);
});

it("rejects mixed legacy/new schemas without partially renaming tables", async () => {
  const mixed = new PGlite();
  try {
    await mixed.exec(
      "CREATE TABLE dd_spaces(slug text); CREATE TABLE dd_connections(id text); CREATE TABLE ap_connections(id text)",
    );
    await expect(mixed.exec(rename)).rejects.toThrow(
      "Both legacy and Astropath tables exist",
    );
    expect(
      (
        await mixed.query(
          "SELECT to_regclass('dd_spaces')::text AS old, to_regclass('ap_spaces')::text AS new",
        )
      ).rows,
    ).toEqual([{ old: "dd_spaces", new: null }]);
  } finally {
    await mixed.close();
  }
});

it("supports fresh Astropath installations", async () => {
  const fresh = new PGlite();
  try {
    await fresh.transaction(async (tx) => {
      await tx.exec(rename);
      await tx.exec(schema);
    });
    expect((await fresh.query("SELECT slug FROM ap_spaces")).rows).toEqual([
      { slug: "general" },
    ]);
  } finally {
    await fresh.close();
  }
});
