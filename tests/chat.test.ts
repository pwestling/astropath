import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import type { Database } from "../src/lib/db";
import { MessageStore } from "../src/lib/store";
import { ChatStore, waitMessagesInput } from "../src/lib/chat";
import { AppError } from "../src/lib/errors";
import type { Principal } from "../src/lib/policy";

const engine = new PGlite();
const database: Database = {
  query: async <T extends QueryResultRow>(sql: string, values?: unknown[]) => ({
    rows: (await engine.query<T>(sql, values)).rows,
  }),
  transaction: (fn) =>
    engine.transaction((tx) =>
      fn({
        query: async <T extends QueryResultRow>(
          sql: string,
          values?: unknown[],
        ) => {
          if (sql.startsWith("SELECT pg_advisory_xact_lock"))
            return { rows: [] };
          return { rows: (await tx.query<T>(sql, values)).rows };
        },
      }),
    ),
};
const messages = new MessageStore(database);
const chat = new ChatStore(database);
const alice: Principal = {
  id: "alice",
  name: "Claude",
  owner: false,
  spaces: ["general", "private"],
  scopes: ["astropath:read", "astropath:write"],
};
const bob: Principal = {
  ...alice,
  id: "bob",
  name: "Muse",
  spaces: ["general"],
};
const context = (principal = bob) => ({
  authenticate: async () => principal,
  signal: new AbortController().signal,
  pollMs: 1,
});

beforeAll(async () => {
  await engine.exec(
    await readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8"),
  );
  await database.query(
    "INSERT INTO ap_spaces(slug,name) VALUES('private','Private')",
  );
});
beforeEach(() =>
  engine.exec(
    "TRUNCATE ap_events,ap_messages,ap_files,ap_receipts,ap_activity RESTART IDENTITY CASCADE",
  ),
);
afterAll(() => engine.close());

it("replies in the parent's space with the real sender, attachments and stable retry cursor", async () => {
  const parent = await messages.create(alice, {
    title: "Question",
    space: "private",
  });
  const fileId = randomUUID();
  await database.query(
    "INSERT INTO ap_files(id,space,name,content_type,size,pathname,principal_id,status) VALUES($1::uuid,'private','a.txt','text/plain',1,$1::text,'alice','ready')",
    [fileId],
  );
  const input = {
    message_id: parent.message.id,
    body: "Answer",
    attachment_ids: [fileId],
    idempotency_key: "answer-1",
  };
  const answer = await chat.reply(alice, input);
  expect(answer.message).toMatchObject({
    space: "private",
    parent_id: parent.message.id,
    thread_id: parent.message.id,
    sender: "Claude",
    recipient: "Claude",
    title: "Question",
  });
  expect(
    (await chat.thread(alice, { message_id: answer.message.id })).messages[1]
      .attachments,
  ).toMatchObject([{ id: fileId, name: "a.txt" }]);
  expect(await chat.reply(alice, input)).toMatchObject({
    replayed: true,
    cursor: answer.cursor,
    message: { id: answer.message.id },
  });
  await expect(
    chat.reply(alice, { ...input, body: "Changed" }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(chat.reply(bob, input)).rejects.toMatchObject({ status: 404 });
  await expect(
    chat.reply(alice, { ...input, space: "general" }),
  ).rejects.toThrow();
  await expect(
    chat.reply(alice, { ...input, sender: "spoof" }),
  ).rejects.toThrow();
});

it("supports broadcast replies and enforces read-only credentials", async () => {
  const parent = await messages.create(alice, {
    title: "Hello",
    recipient: "Muse",
  });
  const reply = await chat.reply(bob, {
    message_id: parent.message.id,
    body: "For everyone",
    recipient: null,
  });
  expect(reply.message.recipient).toBeNull();
  const readOnly = { ...bob, scopes: ["astropath:read"] };
  await expect(
    chat.reply(readOnly, { message_id: parent.message.id, body: "Denied" }),
  ).rejects.toMatchObject({ status: 403 });
  expect(
    (await chat.thread(readOnly, { message_id: parent.message.id })).messages,
  ).toHaveLength(2);
});

it("wait_for_reply catches fast replies and nested conversation turns but ignores receipts and own messages", async () => {
  const sent = await messages.create(alice, { title: "Question" });
  await messages.acknowledge(bob, sent.message.id);
  await chat.reply(alice, { message_id: sent.message.id, body: "My clarification" });
  const fast = await chat.reply(bob, {
    message_id: sent.message.id,
    body: "Fast answer",
  });
  const nested = await chat.reply(bob, {
    message_id: fast.message.id,
    body: "More detail",
  });
  const result = await chat.waitReply(
    alice,
    { message_id: sent.message.id, timeout_seconds: 0 },
    context(alice),
  );
  expect(result.messages.map((m) => m.id)).toEqual([
    fast.message.id,
    nested.message.id,
  ]);
  expect(result.status).toBe("messages");
  expect(
    (
      await chat.waitReply(
        alice,
        { message_id: sent.message.id, after: result.cursor, timeout_seconds: 0 },
        context(alice),
      )
    ).status,
  ).toBe("timeout");
  expect(
    (
      await chat.waitReply(
        alice,
        { message_id: fast.message.id, after: "0", timeout_seconds: 0 },
        context(alice),
      )
    ).messages.map((m) => m.id),
  ).toEqual([nested.message.id]);
});

it("combines space and exact recipient filters, includes replies, and never crosses space permissions", async () => {
  const root = await messages.create(alice, {
    title: "To Muse",
    recipient: "Muse",
  });
  const reply = await chat.reply(alice, {
    message_id: root.message.id,
    body: "Followup",
    recipient: "Muse",
  });
  await messages.create(alice, {
    title: "Private",
    space: "private",
    recipient: "Muse",
  });
  await messages.create(alice, { title: "Different case", recipient: "muse" });
  await messages.create(alice, { title: "Broadcast" });
  await messages.create(bob, { title: "Self", recipient: "Muse" });
  const result = await chat.waitMessages(
    bob,
    { space: "general", recipient: "Muse", after: "0", timeout_seconds: 0 },
    context(),
  );
  expect(result.messages.map((m) => m.id)).toEqual([
    root.message.id,
    reply.message.id,
  ]);
  expect(result.cursor).toBe("6");
  expect(
    (
      await chat.waitMessages(
        bob,
        {
          recipient: "Muse",
          after: "0",
          include_self: true,
          timeout_seconds: 0,
        },
        context(),
      )
    ).messages,
  ).toHaveLength(3);
  await expect(
    chat.waitMessages(bob, { space: "private", timeout_seconds: 0 }, context()),
  ).rejects.toMatchObject({ status: 404 });
});

it("starts live unless a cursor is supplied and returns immediately on a zero timeout", async () => {
  await messages.create(alice, { title: "Already here" });
  const result = await chat.waitMessages(
    bob,
    { timeout_seconds: 0 },
    context(),
  );
  expect(result).toMatchObject({
    status: "timeout",
    messages: [],
    cursor: "1",
    has_more: false,
  });
  expect(
    (
      await chat.waitMessages(
        bob,
        { after: "0", timeout_seconds: 0 },
        context(),
      )
    ).messages,
  ).toHaveLength(1);
  await expect(
    chat.waitMessages(bob, { after: "2", timeout_seconds: 0 }, context()),
  ).rejects.toMatchObject({ status: 400 });
  for (const input of [
    { after: "01" },
    { timeout_seconds: 51 },
    { timeout_seconds: -1 },
    { limit: 0 },
    { include_self: "false" },
  ])
    expect(waitMessagesInput.safeParse(input).success).toBe(false);
});

it("delivers messages arriving during a wait and stops authenticating after return", async () => {
  let calls = 0;
  const result = await chat.waitMessages(
    bob,
    { timeout_seconds: 1 },
    {
      ...context(),
      authenticate: async () => {
        if (++calls === 2) await messages.create(alice, { title: "Live" });
        return bob;
      },
    },
  );
  expect(result.messages[0].title).toBe("Live");
  expect(calls).toBe(2);
});

it("returns a normal timeout after waiting when no reply arrives", async () => {
  const started = Date.now();
  const result = await chat.waitMessages(
    bob,
    { timeout_seconds: 1 },
    { ...context(), pollMs: 100 },
  );
  expect(result).toMatchObject({
    status: "timeout",
    messages: [],
    cursor: "0",
    has_more: false,
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
});

it("checks revocation, identity, scopes and membership during an idle wait", async () => {
  for (const loss of ["revoked", "scope", "membership", "identity"]) {
    let calls = 0;
    await expect(
      chat.waitMessages(
        bob,
        { space: "general", timeout_seconds: 1 },
        {
          ...context(),
          authenticate: async () => {
            if (++calls === 1) return bob;
            await messages.create(alice, { title: "Must not disclose" });
            if (loss === "revoked")
              throw new AppError(401, "invalid_token", "Revoked");
            return {
              ...bob,
              scopes: loss === "scope" ? [] : bob.scopes,
              spaces: loss === "membership" ? [] : bob.spaces,
              id: loss === "identity" ? "another" : bob.id,
            };
          },
        },
      ),
    ).rejects.toMatchObject({
      status: loss === "revoked" ? 401 : loss === "membership" ? 404 : 403,
    });
  }
});

it("cancels promptly instead of continuing database polls after disconnect", async () => {
  const abort = new AbortController();
  let calls = 0;
  await expect(
    chat.waitMessages(
      bob,
      { timeout_seconds: 30 },
      {
        ...context(),
        signal: abort.signal,
        authenticate: async () => {
          calls++;
          abort.abort();
          return bob;
        },
      },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);
});

it("paginates matching events without gaps, preserves bigint IDs and truncates large bodies explicitly", async () => {
  await database.query(
    "SELECT setval(pg_get_serial_sequence('ap_events','id'),9007199254740993,true)",
  );
  const first = await messages.create(alice, {
    title: "One",
    body: "x".repeat(9000),
  });
  const second = await messages.create(alice, { title: "Two" });
  const a = await chat.waitMessages(
    bob,
    { after: "0", limit: 1, timeout_seconds: 0 },
    context(),
  );
  expect(a).toMatchObject({ has_more: true, cursor: first.cursor });
  expect(a.messages[0].body).toHaveLength(8000);
  expect(a.messages[0].body_truncated).toBe(true);
  const b = await chat.waitMessages(
    bob,
    { after: a.cursor, limit: 1, timeout_seconds: 0 },
    context(),
  );
  expect(b.messages.map((m) => m.id)).toEqual([second.message.id]);
  expect(b.cursor).toBe(second.cursor);
  expect(b.has_more).toBe(false);
});

it("reads a stable paginated conversation snapshot and hands off new messages to waiting", async () => {
  const root = await messages.create(alice, { title: "Conversation" });
  const second = await chat.reply(bob, {
    message_id: root.message.id,
    body: "Second",
  });
  const firstPage = await chat.thread(alice, {
    message_id: second.message.id,
    limit: 1,
  });
  expect(firstPage.messages[0].id).toBe(root.message.id);
  const late = await chat.reply(bob, { message_id: second.message.id, body: "Late" });
  const next = await chat.thread(alice, {
    message_id: root.message.id,
    limit: 1,
    page: firstPage.next_page,
  });
  expect(next.messages.map((m) => m.id)).toEqual([second.message.id]);
  expect(next.cursor).toBe(firstPage.cursor);
  expect(next.next_page).toBeNull();
  const fresh = await chat.waitReply(
    alice,
    { message_id: root.message.id, after: next.cursor, timeout_seconds: 0 },
    context(alice),
  );
  expect(fresh.messages.map((m) => m.id)).toEqual([late.message.id]);
  const other = await messages.create(alice, { title: "Other" });
  await expect(
    chat.thread(alice, { message_id: other.message.id, page: firstPage.next_page }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    chat.thread(alice, { message_id: root.message.id, page: "bad" }),
  ).rejects.toMatchObject({ status: 400 });
});

it("includes pre-event history and can wait on an old conversation without a creation event", async () => {
  const root = await messages.create(alice, { title: "Legacy" });
  await database.query("DELETE FROM ap_events WHERE message_id=$1", [
    root.message.id,
  ]);
  const reply = await chat.reply(bob, {
    message_id: root.message.id,
    body: "New reply",
  });
  expect(
    (await chat.thread(alice, { message_id: root.message.id })).messages,
  ).toHaveLength(2);
  expect(
    (
      await chat.waitReply(
        alice,
        { message_id: root.message.id, timeout_seconds: 0 },
        context(alice),
      )
    ).messages[0].id,
  ).toBe(reply.message.id);
});

it("orders committed conversation messages consistently with the event cursor, even with overlapping transaction timestamps", async () => {
  const root = await messages.create(alice, { title: "Root" });
  const first = await chat.reply(bob, {
    message_id: root.message.id,
    body: "First committed reply",
  });
  const second = await chat.reply(bob, {
    message_id: first.message.id,
    body: "Later commit, earlier transaction",
  });
  await database.query(
    "UPDATE ap_messages SET created_at='2020-01-01' WHERE id=$1",
    [second.message.id],
  );
  const a = await chat.thread(alice, { message_id: root.message.id, limit: 1 });
  const b = await chat.thread(alice, {
    message_id: root.message.id,
    limit: 1,
    page: a.next_page,
  });
  const c = await chat.thread(alice, {
    message_id: root.message.id,
    limit: 1,
    page: b.next_page,
  });
  expect([a.messages[0].id, b.messages[0].id, c.messages[0].id]).toEqual([
    root.message.id,
    first.message.id,
    second.message.id,
  ]);
  expect(c.next_page).toBeNull();
  // Historical rows without creation events sort first and paginate into the event-backed rows.
  await database.query("DELETE FROM ap_events WHERE message_id=$1", [
    root.message.id,
  ]);
  const legacy = await chat.thread(alice, { message_id: root.message.id, limit: 1 });
  expect(legacy.messages[0].id).toBe(root.message.id);
  expect(
    (
      await chat.thread(alice, {
        message_id: root.message.id,
        page: legacy.next_page,
      })
    ).messages.map((m) => m.id),
  ).toEqual([first.message.id, second.message.id]);
});
