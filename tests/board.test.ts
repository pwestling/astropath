import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { tenantDatabase, type Database, type Queryable } from "../src/lib/db";
import { migrateTenancy, INITIAL_TENANT } from "../src/lib/tenant-migration";
import { newTenantKey } from "../src/lib/encryption";
import { board } from "../src/lib/board";
import { store } from "../src/lib/store";
import { memory } from "../src/lib/memory";
import { agents } from "../src/lib/agents";
import { mintToken, type Principal } from "../src/lib/policy";
import { GET, POST, PATCH } from "../src/app/api/v1/[[...path]]/route";
import { POST as mcpPost } from "../src/app/mcp/route";
import { GET as openapi } from "../src/app/openapi.json/route";

const state = vi.hoisted(() => ({
  database: undefined as Database | undefined,
  human: false,
}));
vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    systemDb: {
      query: (sql: string, values?: unknown[]) =>
        state.database!.query(sql, values),
      transaction: <T>(fn: (tx: Queryable) => Promise<T>) =>
        state.database!.transaction(fn),
    },
    db: {
      ...actual.db,
      forTenant: (id: string) => actual.tenantDatabase(id, state.database!),
    },
  };
});
vi.mock("../src/lib/auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => (state.human ? { user: { id: "owner" } } : null),
    },
  }),
}));
const engine = new PGlite();
function adapter(client: Pick<PGlite, "query" | "exec">): Queryable {
  return {
    query: async <T extends QueryResultRow>(
      sql: string,
      values?: unknown[],
    ) => {
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (!values)
        return { rows: ((await client.exec(sql)).at(-1)?.rows ?? []) as T[] };
      return { rows: (await client.query<T>(sql, values)).rows };
    },
  };
}
const directory: Database = {
  ...adapter(engine),
  transaction: (fn) => engine.transaction((tx) => fn(adapter(tx))),
};
const second = randomUUID();
const tokens = [mintToken(), mintToken()];
const agent: Principal = {
  id: randomUUID(),
  name: "Codex",
  tenantId: INITIAL_TENANT,
  owner: false,
  spaces: ["general"],
  scopes: ["astropath:read", "astropath:write"],
};
const other: Principal = { ...agent, id: randomUUID(), name: "Claude" };
const human: Principal = {
  ...agent,
  id: "owner:owner",
  userId: "owner",
  name: "Owner",
  owner: true,
  spaces: null,
};
const inOtherTenant: Principal = { ...other, tenantId: second };
async function api(
  path: string,
  method = "GET",
  body?: unknown,
  token = tokens[0].token,
) {
  const url = new URL(`https://board.example/api/v1/${path}`);
  return { GET, POST, PATCH }[method as "GET"](
    new Request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: "https://board.example",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    {
      params: Promise.resolve({
        path: url.pathname.slice("/api/v1/".length).split("/"),
      }),
    },
  );
}
beforeAll(async () => {
  state.database = directory;
  vi.stubEnv("ASTROPATH_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("APP_URL", "https://board.example");
  await engine.exec(`CREATE TABLE "user"(id text PRIMARY KEY,name text,email text);
    INSERT INTO "user" VALUES('owner','Owner','owner@example.com');`);
  await engine.exec(
    await readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8"),
  );
  await directory.transaction(migrateTenancy);
  await directory.transaction(migrateTenancy);
  await directory.query(
    "INSERT INTO ap_tenants(id,name,wrapped_key) VALUES($1,'Other',$2)",
    [second, newTenantKey(second)],
  );
  await directory.query(
    "INSERT INTO ap_spaces(tenant_id,slug,name) VALUES($1,'general','General'),($2,'private','Private')",
    [second, INITIAL_TENANT],
  );
  for (const [index, principal] of [agent, other].entries())
    await directory.query(
      "INSERT INTO ap_connections(id,tenant_id,name,kind,scopes,spaces,created_by_user_id,token_hash) VALUES($1,$2,$3,'token',$4,$5,'owner',$6)",
      [
        principal.id,
        INITIAL_TENANT,
        principal.name,
        principal.scopes,
        principal.spaces,
        tokens[index].tokenHash,
      ],
    );
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await engine.close();
});

// A second connection of the same agent (e.g. Codex on another machine).
const laptop: Principal = { ...agent, id: randomUUID(), name: "Codex Laptop" };

async function names(principal: Principal) {
  const result = await board.catchUp(principal, {});
  return {
    mentions: result.mentions.map((item) => item.title),
    new_topics: result.new_topics.map((item) => item.title),
    replies: result.replies.map((item) => item.excerpt),
    other_replies: result.omitted.other_replies,
  };
}

it("posts topics with explicit and inline @mentions, rejecting unknown handles", async () => {
  // Codex catches up once so later checks only see new posts.
  await board.catchUp(agent, {});
  await board.catchUp(other, {});
  const { topic } = await board.postTopic(other, {
    title: "PETG stringing results",
    body: "Retraction 0.8 mm fixed most of it. cc @owner for the printer settings.",
    mentions: ["@codex"],
  });
  expect(topic.author).toMatchObject({ handle: "claude", kind: "agent" });
  expect(topic.mentions.sort()).toEqual(["codex", "owner"]);
  await expect(
    board.postTopic(other, { title: "Typo", body: "", mentions: ["codx"] }),
  ).rejects.toMatchObject({ code: "unknown_handle" });
  // An @word that is not a handle in the body is just text.
  const plain = await board.postTopic(other, {
    title: "Email me",
    body: "Reach me @ the usual place, or @nobody.",
  });
  expect(plain.topic.mentions).toEqual([]);
  const mine = await board.listTopics(agent, { mentioning: "me" });
  expect(mine.topics.map((t) => t.title)).toContain("PETG stringing results");
  const read = await board.readTopic(agent, { topic_id: topic.id });
  expect(read.messages[0]).toMatchObject({
    title: "PETG stringing results",
    author: { handle: "claude" },
  });
});

it("catches an agent up on mentions, new topics and replies where it is involved", async () => {
  const news = await names(agent);
  expect(news.mentions).toEqual(["PETG stringing results"]);
  expect(news.new_topics).toEqual(["Email me"]);
  // Nothing new the second time.
  expect(await names(agent)).toEqual({
    mentions: [],
    new_topics: [],
    replies: [],
    other_replies: 0,
  });
  const petg = (await board.listTopics(agent, { q: "PETG stringing" }))
    .topics[0];
  const emailMe = (await board.listTopics(agent, { q: "Email me" })).topics[0];
  await board.reply(agent, {
    topic_id: petg.id,
    body: "Thanks, trying 0.8 mm now.",
  });
  await board.reply(other, { topic_id: petg.id, body: "Let me know." });
  await board.reply(other, { topic_id: emailMe.id, body: "Unrelated aside." });
  // Codex wrote in the PETG topic, so the reply there is relevant; the
  // other reply is only counted. Its own reply never comes back to it.
  expect(await names(agent)).toEqual({
    mentions: [],
    new_topics: [],
    replies: ["Let me know."],
    other_replies: 1,
  });
});

it("shares one cursor across an agent's connections and supports peek", async () => {
  const tenant = await tenantDatabase(INITIAL_TENANT, directory);
  const agentId = (
    await tenant.query<{ agent_id: string }>(
      "SELECT agent_id FROM ap_connections WHERE id=$1",
      [agent.id],
    )
  ).rows[0].agent_id;
  await directory.query(
    "INSERT INTO ap_connections(id,tenant_id,name,kind,scopes,spaces,created_by_user_id,agent_id) VALUES($1,$2,'Codex Laptop','token',$3,$4,'owner',$5)",
    [laptop.id, INITIAL_TENANT, laptop.scopes, laptop.spaces, agentId],
  );
  await board.postTopic(other, {
    title: "Heads up @codex",
    body: "@codex the API changed.",
  });
  const peeked = await board.catchUp(laptop, { peek: true });
  expect(peeked.mentions.map((item) => item.title)).toEqual([
    "Heads up @codex",
  ]);
  expect((await names(laptop)).mentions).toEqual(["Heads up @codex"]);
  // Seen from the laptop, so not repeated on the other connection.
  expect((await names(agent)).mentions).toEqual([]);
  // An explicit since re-reads without moving the cursor.
  const reread = await board.catchUp(agent, { since: peeked.since });
  expect(reread.mentions.map((item) => item.title)).toEqual([
    "Heads up @codex",
  ]);
  expect((await names(agent)).mentions).toEqual([]);
});

it("keeps posts within accessible spaces and tenants", async () => {
  await board.postTopic(human, {
    title: "Private plans",
    body: "@codex this is private.",
    space: "private",
  });
  expect((await names(agent)).mentions).toEqual([]);
  expect(
    (await board.listTopics(agent, { q: "Private plans" })).topics,
  ).toEqual([]);
  const outsider: Principal = { ...inOtherTenant, id: randomUUID() };
  await directory.query(
    "INSERT INTO ap_connections(id,tenant_id,name,kind,scopes,spaces,created_by_user_id) VALUES($1,$2,'Claude','token',$3,$4,'owner')",
    [outsider.id, second, outsider.scopes, outsider.spaces],
  );
  const elsewhere = await board.catchUp(outsider, { since: "0" });
  expect([...elsewhere.mentions, ...elsewhere.new_topics]).toEqual([]);
  await expect(
    board.postTopic(agent, { title: "x", body: "", space: "private" }),
  ).rejects.toMatchObject({ status: 404 });
  const raw = await directory.query("SELECT * FROM ap_messages");
  expect(JSON.stringify(raw.rows)).not.toContain("Private plans");
});

it("turns a legacy recipient into a mention, at write time and in the backfill", async () => {
  const sent = await store.create(other, {
    title: "Legacy handoff",
    body: "Old style",
    recipient: "Codex",
  });
  expect(sent.message.mentions).toHaveLength(1);
  await directory.query(
    "UPDATE ap_messages SET agent_id=NULL,mentions='{}' WHERE id=$1",
    [sent.message.id],
  );
  await directory.transaction(migrateTenancy);
  const row = (
    await directory.query<{ agent_id: string; mentions: string[] }>(
      "SELECT agent_id,mentions FROM ap_messages WHERE id=$1",
      [sent.message.id],
    )
  ).rows[0];
  expect(row.agent_id).not.toBeNull();
  expect(row.mentions).toHaveLength(1);
});

it("serves the board over HTTP and MCP", async () => {
  const posted = await api("board/topics", "POST", {
    title: "HTTP topic",
    body: "Hello @claude",
    idempotency_key: "http-topic",
  });
  expect(posted.status).toBe(201);
  const { topic } = await posted.json();
  expect(topic.mentions).toEqual(["claude"]);
  expect(
    (
      await api("board/topics", "POST", {
        title: "HTTP topic",
        body: "Hello @claude",
        idempotency_key: "http-topic",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api(`board/topics/${topic.id}/replies`, "POST", {
        body: "First reply",
      })
    ).status,
  ).toBe(201);
  const thread = await (await api(`board/topics/${topic.id}`)).json();
  expect(thread.messages.map((m: { body: string }) => m.body)).toEqual([
    "Hello @claude",
    "First reply",
  ]);
  const caught = await (
    await api("board/catch-up", "POST", { peek: true }, tokens[1].token)
  ).json();
  expect(caught.mentions.map((m: { title: string }) => m.title)).toContain(
    "HTTP topic",
  );
  expect(
    (await (await api("board/topics?mentioning=claude")).json()).topics.length,
  ).toBeGreaterThan(0);

  const client = new Client({ name: "Board test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://board.example/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[1].token}` } },
      fetch: (input, init) => mcpPost(new Request(input, init)),
    }),
  );
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "catch_up",
        "post_topic",
        "reply",
        "read_topic",
        "list_topics",
        "list_agents",
        "set_profile",
      ]),
    );
    expect(
      tools.tools.find((tool) => tool.name === "send_message")!.description,
    ).toMatch(/^Deprecated/);
    const result = await client.callTool({
      name: "catch_up",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const identity = await client.callTool({
      name: "get_identity",
      arguments: {},
    });
    const text = identity.content.find((item) => item.type === "text");
    expect(
      text && text.type === "text" && JSON.parse(text.text).agent.handle,
    ).toBe("claude");
  } finally {
    await client.close();
  }
});

it("attributes posts to sessions and lets others mention one session", async () => {
  const session = {
    session_key: "codex:astropath-1",
    session_name: "Astropath board redesign",
    session_context: "Codex in ~/dev/personal/astropath",
  };
  // The board and the memory log share session records.
  const remembered = await memory.remember(agent, {
    ...session,
    body: "Started the board work.",
    idempotency_key: "board-session-memory",
  });
  const { topic } = await board.postTopic(agent, {
    ...session,
    title: "Session-attributed topic",
    body: "Posted from a specific conversation.",
  });
  const ref = remembered.session!.id.replace(/-/g, "").slice(0, 8);
  expect(topic.author).toMatchObject({
    handle: "codex",
    session: {
      ref,
      name: "Astropath board redesign",
      context: "Codex in ~/dev/personal/astropath",
    },
  });
  // Another Codex session that should not claim the mention.
  await board.postTopic(agent, {
    session_key: "codex:other-work",
    session_name: "Sidereal experiments",
    title: "Other session",
    body: "Unrelated.",
  });
  const directory = (await agents.list(other)).agents.find(
    (item) => item.handle === "codex",
  )!;
  expect(directory.recent_sessions.map((item) => item.ref)).toContain(ref);
  expect(directory.recent_sessions[0]).toHaveProperty("name");

  await board.catchUp(agent, {});
  const explicit = await board.reply(other, {
    topic_id: topic.id,
    body: "Picking this up.",
    mentions: [`@codex#${ref}`],
  });
  expect(explicit.message.mentions).toEqual([`codex#${ref}`]);
  const inline = await board.postTopic(other, {
    title: "Inline session mention",
    body: `@codex#${ref} please check the migration.`,
  });
  expect(inline.topic.mentions).toEqual([`codex#${ref}`]);
  await expect(
    board.postTopic(other, {
      title: "Bad ref",
      body: "",
      mentions: ["@codex#ffffffff"],
    }),
  ).rejects.toMatchObject({ code: "unknown_session" });
  // An unknown ref written in a body still mentions the agent.
  const loose = await board.postTopic(other, {
    title: "Loose ref",
    body: "@codex#ffffffff hello",
  });
  expect(loose.topic.mentions).toEqual(["codex"]);

  const fromThisSession = await board.catchUp(agent, {
    peek: true,
    session_key: "codex:astropath-1",
  });
  const flagged = fromThisSession.mentions.find(
    (item) => item.title === "Inline session mention",
  )!;
  expect(flagged).toMatchObject({
    for_sessions: [{ ref, name: "Astropath board redesign" }],
    for_this_session: true,
  });
  const fromOtherSession = await board.catchUp(agent, {
    session_key: "codex:other-work",
  });
  expect(
    fromOtherSession.mentions.find(
      (item) => item.title === "Inline session mention",
    ),
  ).toMatchObject({ for_this_session: false });
  expect(
    fromOtherSession.mentions.find((item) => item.title === "Loose ref"),
  ).not.toHaveProperty("for_sessions");
});

it("hides sessions in spaces the viewer cannot access", async () => {
  const lev: Principal = {
    ...agent,
    id: randomUUID(),
    name: "Lev",
    spaces: ["general", "private"],
  };
  await directory.query(
    "INSERT INTO ap_connections(id,tenant_id,name,kind,scopes,spaces,created_by_user_id) VALUES($1,$2,'Lev','token',$3,$4,'owner')",
    [lev.id, INITIAL_TENANT, lev.scopes, lev.spaces],
  );
  await memory.remember(lev, {
    space: "private",
    session_key: "lev-private",
    session_name: "Private planning",
    body: "Private.",
    idempotency_key: "lev-private-memory",
  });
  const sessionsSeenBy = async (viewer: Principal) =>
    (await agents.list(viewer)).agents
      .find((item) => item.handle === "lev")!
      .recent_sessions.map((session) => session.name);
  expect(await sessionsSeenBy(human)).toContain("Private planning");
  expect(await sessionsSeenBy(agent)).not.toContain("Private planning");
});

it("delivers a session mention to that session even after a sibling caught up", async () => {
  const sessionA = { session_key: "codex:a", session_name: "Session A" };
  const b = await memory.remember(agent, {
    session_key: "codex:b",
    session_name: "Session B",
    body: "Session B exists.",
    idempotency_key: "codex-b-exists",
  });
  const refB = b.session!.id.replace(/-/g, "").slice(0, 8);
  await board.catchUp(agent, {});
  // A sibling session of the same agent can flag session B.
  const { topic } = await board.postTopic(agent, {
    ...sessionA,
    title: "For my sibling",
    body: `@codex#${refB} you own the migration.`,
  });
  expect(topic.mentions).toEqual([`codex#${refB}`]);
  // Session A catches up first: its own post is not reported back to it,
  // and the agent cursor moves past it.
  const a = await board.catchUp(agent, { session_key: "codex:a" });
  expect(a.mentions.map((item) => item.title)).not.toContain("For my sibling");
  // Session B still receives it from its own session cursor.
  const forB = await board.catchUp(agent, { session_key: "codex:b" });
  expect(
    forB.mentions.find((item) => item.title === "For my sibling"),
  ).toMatchObject({ for_this_session: true });
  expect(
    (await board.catchUp(agent, { session_key: "codex:b" })).mentions,
  ).toEqual([]);
  // The same holds for another agent mentioning session B.
  await board.postTopic(other, {
    title: "Claude to session B",
    body: `@codex#${refB} heads up.`,
  });
  await board.catchUp(agent, {});
  expect(
    (await board.catchUp(agent, { session_key: "codex:b" })).mentions.map(
      (item) => item.title,
    ),
  ).toEqual(["Claude to session B"]);
  // A session mentioning only itself mentions no one.
  const self = await board.postTopic(agent, {
    ...sessionA,
    title: "Note to self",
    body: "@codex reminder",
  });
  expect(self.topic.mentions).toEqual([]);
});
