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
import { memory } from "../src/lib/memory";
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
  const url = new URL(`https://memory.example/api/v1/${path}`);
  return { GET, POST, PATCH }[method as "GET"](
    new Request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: "https://memory.example",
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
  vi.stubEnv("APP_URL", "https://memory.example");
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

async function scoped() {
  return tenantDatabase(INITIAL_TENANT, directory);
}

it("appends memories to a session registered on first use", async () => {
  const first = await memory.remember(agent, {
    session_key: "native-thread-1",
    session_name: "PETG experiments",
    session_context: "Codex in ~/prints",
    body: "PETG at 235°C gave the best layer adhesion.",
    idempotency_key: "petg-1",
  });
  expect(first.replayed).toBe(false);
  expect(first.session).toMatchObject({
    name: "PETG experiments",
    context: "Codex in ~/prints",
  });
  expect(first.memory.author).toMatchObject({
    principal_id: agent.id,
    name: "Codex",
    session_id: first.session!.id,
    session_name: "PETG experiments",
    session_key: "native-thread-1",
    session_context: "Codex in ~/prints",
  });
  // The session identity is immutable: a later name or context is ignored.
  const second = await memory.remember(agent, {
    session_key: "native-thread-1",
    session_name: "Renamed",
    session_context: "Elsewhere",
    body: "245°C strings noticeably more.",
    idempotency_key: "petg-2",
  });
  expect(second.session).toEqual(first.session);
  // Another connection with the same native key gets its own session.
  const foreign = await memory.remember(other, {
    session_key: "native-thread-1",
    body: "Unrelated",
    idempotency_key: "petg-1",
  });
  expect(foreign.session!.id).not.toBe(first.session!.id);
  expect(foreign.session!.name).toBe("Unnamed session");
  const log = await memory.recall(agent, { session_key: "native-thread-1" });
  expect(log.memories.map((item) => item.body)).toEqual([
    "245°C strings noticeably more.",
    "PETG at 235°C gave the best layer adhesion.",
  ]);
  expect(
    (await memory.recall(agent, { session_id: first.session!.id })).memories,
  ).toHaveLength(2);
});

it("replays exact retries and rejects a changed memory under the same key", async () => {
  const input = {
    session_key: "retry-session",
    session_name: "Retries",
    body: "Original",
    idempotency_key: "retry-1",
  };
  const first = await memory.remember(agent, input);
  const retry = await memory.remember(agent, input);
  expect(retry).toMatchObject({ replayed: true, memory: first.memory });
  await expect(
    memory.remember(agent, { ...input, body: "Changed" }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
});

it("requires a session for agents and allows account entries for humans", async () => {
  await expect(
    memory.remember(agent, { body: "No session", idempotency_key: "none" }),
  ).rejects.toMatchObject({ code: "session_required" });
  const saved = await memory.remember(human, {
    body: "A note from the owner",
    idempotency_key: "owner-1",
  });
  expect(saved.memory.author).toMatchObject({
    principal_id: human.id,
    session_id: null,
  });
  const accountOnly = await memory.recall(human, {
    principal_id: human.id,
    no_session: true,
  });
  expect(accountOnly.memories.map((item) => item.id)).toContain(
    saved.memory.id,
  );
  await expect(
    memory.remember(
      { ...agent, scopes: ["astropath:read"] },
      { session_key: "s", body: "x", idempotency_key: "scope" },
    ),
  ).rejects.toMatchObject({ code: "insufficient_scope" });
});

it("isolates tenants and spaces and keeps content encrypted", async () => {
  const secret = await memory.remember(human, {
    space: "private",
    session_key: "private-key",
    session_name: "Private session",
    body: "Private content",
    idempotency_key: "private",
  });
  expect(
    (await memory.recall(agent, { q: "Private content" })).memories,
  ).toEqual([]);
  expect(
    (await memory.recall(inOtherTenant, { q: "Private content" })).memories,
  ).toEqual([]);
  await expect(
    memory.remember(agent, {
      space: "private",
      session_key: "x",
      body: "Wrong space",
      idempotency_key: "wrong-space",
    }),
  ).rejects.toMatchObject({ status: 404 });
  // A session key only matches the caller's own sessions.
  expect(
    (await memory.recall(agent, { session_key: "private-key" })).memories,
  ).toEqual([]);
  const other_tenant = await tenantDatabase(second, directory);
  expect(
    (
      await other_tenant.query("SELECT * FROM ap_memories WHERE id=$1", [
        secret.memory.id,
      ])
    ).rows,
  ).toEqual([]);
  const raw = await directory.query(
    "SELECT m.*,s.encrypted_content AS session FROM ap_memories m JOIN ap_agent_sessions s ON s.id=m.session_id WHERE m.id=$1",
    [secret.memory.id],
  );
  expect(JSON.stringify(raw.rows)).not.toContain("Private content");
  expect(JSON.stringify(raw.rows)).not.toContain("Private session");
  const tenant = await scoped();
  await expect(
    tenant.query("UPDATE ap_memories SET space='general' WHERE id=$1", [
      secret.memory.id,
    ]),
  ).rejects.toThrow();
  await expect(
    tenant.query("DELETE FROM ap_memories WHERE id=$1", [secret.memory.id]),
  ).rejects.toThrow();
});

it("searches encrypted memories beyond a scan batch without skipping matches", async () => {
  const tenant = await scoped();
  const author = {
    principal_id: human.id,
    name: human.name,
    session_id: null,
    session_name: null,
    session_key: null,
  };
  const records = Array.from({ length: 205 }, (_, index) => {
    const id = randomUUID();
    return {
      id,
      content: tenant.cipher!.encrypt(`memory:${id}`, {
        body: index < 3 ? `Needle ${index}` : "Other content",
        author,
      }),
      key: `bulk-${index}`,
    };
  });
  await tenant.query(
    `INSERT INTO ap_memories(id,space,principal_id,encrypted_content,retry_key_hash,content_hash)
    SELECT r.id,'general',$1,r.content,r.key,r.key FROM jsonb_to_recordset($2) AS r(id uuid,content text,key text)`,
    [human.id, JSON.stringify(records)],
  );
  const page = await memory.recall(agent, { q: "needle", limit: 2 });
  expect(page.memories).toHaveLength(2);
  expect(page.next_before).not.toBeNull();
  const last = await memory.recall(agent, {
    q: "needle",
    limit: 2,
    before: page.next_before!,
  });
  expect(last.memories).toHaveLength(1);
  expect(last.next_before).toBeNull();
  expect(
    new Set([...page.memories, ...last.memories].map((item) => item.id)).size,
  ).toBe(3);
});

it("lists sessions by latest activity with counts and a preview", async () => {
  await memory.remember(agent, {
    session_key: "listing-a",
    session_name: "Listing A",
    body: "Older session entry",
    idempotency_key: "listing-a-1",
  });
  await memory.remember(agent, {
    session_key: "listing-b",
    session_name: "Listing B",
    session_context: "Claude Code in ~/dev/astropath",
    body: "First B entry",
    idempotency_key: "listing-b-1",
  });
  await memory.remember(agent, {
    session_key: "listing-b",
    body: "Latest B entry",
    idempotency_key: "listing-b-2",
  });
  const page = await memory.sessions(agent, { limit: 2 });
  expect(page.sessions[0]).toMatchObject({
    session_name: "Listing B",
    context: "Claude Code in ~/dev/astropath",
    author_name: "Codex",
    count: 2,
    latest: "Latest B entry",
  });
  expect(page.next_before).not.toBeNull();
  const rest = await memory.sessions(agent, {
    limit: 100,
    before: page.next_before!,
  });
  expect(page.sessions[1].session_name).toBe("Listing A");
  const names = rest.sessions.map((item) => item.session_name);
  expect(names).toContain("Retries");
  expect(names).not.toContain("Listing A");
  expect(
    [...page.sessions, ...rest.sessions].some(
      (item) => item.session_name === "Private session",
    ),
  ).toBe(false);
});

it("serves memories over HTTP, keeps work-notes compatible and retires topic routes", async () => {
  const input = {
    session_key: "http-session",
    session_name: "HTTP session",
    body: "HTTP memory",
    idempotency_key: "http-1",
  };
  expect((await api("memories", "POST", input)).status).toBe(201);
  expect((await api("memories", "POST", input)).status).toBe(200);
  expect(
    (await api("memories", "POST", { ...input, author: "spoof" })).status,
  ).toBe(400);
  const found = await (await api("memories?q=http%20memory")).json();
  expect(found.memories[0].body).toBe("HTTP memory");
  const sessions = await (await api("memory-sessions")).json();
  expect(sessions.sessions[0].session_name).toBe("HTTP session");
  const legacy = await api("work-notes", "POST", {
    path: ["3D printing", "PETG"],
    session_key: "http-session",
    session_name: "HTTP session",
    kind: "decision",
    body: "Use the enclosure for PETG.",
    idempotency_key: "http-legacy",
  });
  expect(legacy.status).toBe(201);
  expect((await legacy.json()).memory.legacy).toEqual({
    path: ["3D printing", "PETG"],
    kind: "decision",
  });
  for (const route of ["topics", "topic-notes", "agent-sessions"])
    expect((await api(route)).status).toBe(410);
  await directory.query(
    "UPDATE ap_connections SET scopes=ARRAY['astropath:read'] WHERE id=$1",
    [other.id],
  );
  expect(
    (
      await api(
        "memories",
        "POST",
        { ...input, idempotency_key: "read-only" },
        tokens[1].token,
      )
    ).status,
  ).toBe(403);
  expect(
    (await api("memories", "GET", undefined, tokens[1].token)).status,
  ).toBe(200);
  await directory.query(
    "UPDATE ap_connections SET revoked_at=now() WHERE id=$1",
    [other.id],
  );
  expect(
    (await api("memories", "GET", undefined, tokens[1].token)).status,
  ).toBe(401);
  const schema = await openapi().json();
  expect(schema.paths["/memories"].post.operationId).toBe("remember");
  expect(schema.paths["/topics"]).toBeUndefined();
});

it("exposes remember and recall over MCP without the topic tools", async () => {
  const client = new Client({ name: "Memory test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://memory.example/mcp"), {
      requestInit: {
        headers: { Authorization: `Bearer ${tokens[0].token}` },
      },
      fetch: (input, init) => mcpPost(new Request(input, init)),
    }),
  );
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["remember", "recall", "record_work_note"]),
    );
    for (const retired of [
      "list_topics",
      "ensure_topic",
      "read_topic",
      "register_agent_session",
      "append_topic_note",
      "list_topic_notes",
    ])
      expect(names).not.toContain(retired);
    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const text = result.content.find((item) => item.type === "text");
      if (!text || text.type !== "text")
        throw new Error("Missing tool response");
      return JSON.parse(text.text);
    }
    const saved = await call("remember", {
      session_key: "mcp-thread",
      session_name: "MCP run",
      body: "MCP discovery",
      idempotency_key: "mcp-1",
    });
    expect(saved.memory.author.principal_id).toBe(agent.id);
    const combined = await call("record_work_note", {
      path: ["MCP topic"],
      session_key: "mcp-thread",
      session_name: "MCP run",
      body: "One-call capture",
      idempotency_key: "mcp-combined",
    });
    expect(combined.memory.author.session_id).toBe(saved.session.id);
    const recalled = await call("recall", { session_key: "mcp-thread" });
    expect(
      recalled.memories.map((item: { body: string }) => item.body),
    ).toEqual(["One-call capture", "MCP discovery"]);
  } finally {
    await client.close();
  }
});

it("copies retired topic notes into the log once, keeping author, time and path", async () => {
  const tenant = await scoped();
  const cipher = tenant.cipher!;
  const parent = randomUUID();
  const child = randomUUID();
  const session = randomUUID();
  const note = randomUUID();
  await tenant.query(
    `INSERT INTO ap_topics(id,space,parent_id,name_hash,encrypted_name,created_by)
    VALUES($1,'general',NULL,'legacy-root',$2,'test'),($3,'general',$1,'legacy-child',$4,'test')`,
    [
      parent,
      cipher.encrypt(`topic:${parent}`, "3D printing"),
      child,
      cipher.encrypt(`topic:${child}`, "PETG"),
    ],
  );
  await tenant.query(
    "INSERT INTO ap_agent_sessions(id,space,principal_id,session_key_hash,encrypted_content) VALUES($1,'general',$2,'legacy-session',$3)",
    [
      session,
      agent.id,
      cipher.encrypt(`agent-session:${session}`, {
        name: "Legacy run",
        session_key: "legacy",
        author_name: "Codex",
      }),
    ],
  );
  const author = {
    principal_id: agent.id,
    name: "Codex",
    session_id: session,
    session_name: "Legacy run",
    session_key: "legacy",
  };
  await tenant.query(
    `INSERT INTO ap_topic_notes(id,space,topic_id,session_id,principal_id,kind,encrypted_content,retry_key_hash,content_hash,created_at)
    VALUES($1,'general',$2,$3,$4,'milestone',$5,'legacy-retry','legacy-content','2026-09-28T12:00:00Z')`,
    [
      note,
      child,
      session,
      agent.id,
      cipher.encrypt(`topic-note:${note}`, {
        body: "Finished the PETG comparison.",
        author,
      }),
    ],
  );
  await directory.transaction(migrateTenancy);
  await directory.transaction(migrateTenancy);
  const copies = await directory.query(
    "SELECT id FROM ap_memories WHERE legacy_note_id=$1",
    [note],
  );
  expect(copies.rows).toHaveLength(1);
  const [copied] = (await memory.recall(agent, { session_id: session }))
    .memories;
  expect(copied).toMatchObject({
    body: "Finished the PETG comparison.",
    author,
    legacy: { path: ["3D printing", "PETG"], kind: "milestone" },
  });
  expect(new Date(copied.created_at).toISOString()).toBe(
    "2026-09-28T12:00:00.000Z",
  );
});
