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
import { knowledge } from "../src/lib/knowledge";
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
  const url = new URL(`https://knowledge.example/api/v1/${path}`);
  return { GET, POST, PATCH }[method as "GET"](
    new Request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: "https://knowledge.example",
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
  vi.stubEnv("APP_URL", "https://knowledge.example");
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

it("reuses broad topic paths and permits notes at every hierarchy level", async () => {
  const { topic } = await knowledge.ensureTopic(agent, {
    path: ["3D printing", "Materials", "PETG"],
  });
  expect(topic.path.map((part) => part.name)).toEqual([
    "3D printing",
    "Materials",
    "PETG",
  ]);
  const retry = await knowledge.ensureTopic(other, {
    path: ["3d   PRINTING", "materials", "petg"],
  });
  expect(retry).toMatchObject({ created: false, topic: { id: topic.id } });
  expect(
    (await knowledge.listTopics(agent, {})).topics.map((item) => item.name),
  ).toContain("3D printing");
  expect(
    (
      await knowledge.listTopics(agent, { parent_id: topic.path[0].id })
    ).topics.map((item) => item.name),
  ).toEqual(["Materials"]);
  expect(
    (
      await knowledge.listTopics(agent, { q: "printing / materials" })
    ).topics.map((item) => item.id),
  ).toContain(topic.id);
  const { session } = await knowledge.registerSession(agent, {
    session_key: "native-thread-1",
    name: "PETG experiments",
  });
  for (const part of topic.path)
    expect(
      (
        await knowledge.appendNote(agent, {
          topic_id: part.id,
          session_id: session.id,
          body: `Context at ${part.name}`,
          idempotency_key: part.id,
        })
      ).note.topic_id,
    ).toBe(part.id);
  expect(
    (await knowledge.listNotes(agent, { topic_id: topic.path[0].id })).notes,
  ).toHaveLength(3);
  expect(
    (
      await knowledge.listNotes(agent, {
        topic_id: topic.path[0].id,
        include_descendants: false,
      })
    ).notes,
  ).toHaveLength(1);
});
it("binds immutable sessions to a connection and space and preserves note attribution", async () => {
  const { topic } = await knowledge.ensureTopic(agent, {
    path: ["Authorship"],
  });
  const first = await knowledge.registerSession(agent, {
    session_key: "shared-key",
    name: "Original session",
  });
  const same = await knowledge.registerSession(agent, {
    session_key: "shared-key",
    name: "Changed name",
  });
  expect(same.session).toEqual(first.session);
  expect(same.created).toBe(false);
  const sibling = await knowledge.registerSession(agent, {
    session_key: "different-key",
    name: "Second session",
  });
  const another = await knowledge.registerSession(other, {
    session_key: "shared-key",
    name: "Other connection",
  });
  expect(another.session.id).not.toBe(first.session.id);
  const input = {
    topic_id: topic.id,
    session_id: first.session.id,
    body: "A lasting discovery",
    kind: "milestone",
    idempotency_key: "first-note",
  };
  const result = await knowledge.appendNote(agent, input);
  expect(result.note.author).toMatchObject({
    principal_id: agent.id,
    name: "Codex",
    session_id: first.session.id,
    session_name: "Original session",
    session_key: "shared-key",
  });
  expect(
    (
      await knowledge.appendNote(
        { ...agent, name: "Renamed credential" },
        input,
      )
    ).note,
  ).toEqual(result.note);
  expect(
    (
      await knowledge.appendNote(agent, {
        ...input,
        session_id: sibling.session.id,
        idempotency_key: "second-note",
      })
    ).note.author.session_id,
  ).toBe(sibling.session.id);
  await expect(
    knowledge.appendNote(agent, { ...input, body: "Different content" }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    knowledge.appendNote(other, { ...input, idempotency_key: "spoof" }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    knowledge.appendNote(agent, {
      topic_id: topic.id,
      body: "Missing session",
      idempotency_key: "missing",
    }),
  ).rejects.toMatchObject({ code: "session_required" });
  expect(
    (
      await knowledge.appendNote(human, {
        topic_id: topic.id,
        body: "Human context",
        idempotency_key: "human",
      })
    ).note.author.session_id,
  ).toBeNull();
  await expect(
    directory.query("UPDATE ap_topic_notes SET kind='note' WHERE id=$1", [
      result.note.id,
    ]),
  ).rejects.toThrow("immutable");
  await expect(
    directory.query("DELETE FROM ap_agent_sessions WHERE id=$1", [
      first.session.id,
    ]),
  ).rejects.toThrow("immutable");
});
it("isolates tenants and spaces, including session references and searches", async () => {
  const { topic } = await knowledge.ensureTopic(human, {
    space: "private",
    path: ["Secret area"],
  });
  const { session } = await knowledge.registerSession(human, {
    space: "private",
    name: "Private session",
    session_key: "private-key",
  });
  await knowledge.appendNote(human, {
    topic_id: topic.id,
    session_id: session.id,
    body: "Private content",
    idempotency_key: "private",
  });
  await expect(knowledge.readTopic(agent, topic.id)).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    knowledge.listTopics(agent, { parent_id: topic.id }),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (await knowledge.listNotes(agent, { q: "Private content" })).notes,
  ).toEqual([]);
  expect(
    (await knowledge.listTopics(inOtherTenant, { q: "Secret" })).topics,
  ).toEqual([]);
  await expect(
    knowledge.readTopic(inOtherTenant, topic.id),
  ).rejects.toMatchObject({ status: 404 });
  const publicTopic = (
    await knowledge.ensureTopic(agent, { path: ["Public area"] })
  ).topic;
  await expect(
    knowledge.appendNote(human, {
      topic_id: publicTopic.id,
      session_id: session.id,
      body: "Wrong space",
      idempotency_key: "wrong-space",
    }),
  ).rejects.toMatchObject({ status: 404 });
  const scoped = await tenantDatabase(second, directory);
  expect(
    (await scoped.query("SELECT * FROM ap_topics WHERE id=$1", [topic.id]))
      .rows,
  ).toEqual([]);
  await expect(
    scoped.query(
      "INSERT INTO ap_topics(id,space,parent_id,name_hash,encrypted_name,created_by) VALUES($1,'general',$2,'hash','invalid','test')",
      [randomUUID(), topic.id],
    ),
  ).rejects.toThrow();
  const raw = await directory.query(
    "SELECT encrypted_name,name_hash FROM ap_topics WHERE id=$1",
    [topic.id],
  );
  expect(JSON.stringify(raw.rows)).not.toContain("Secret area");
  const rawNotes = await directory.query(
    "SELECT * FROM ap_topic_notes WHERE topic_id=$1",
    [topic.id],
  );
  expect(JSON.stringify(rawNotes.rows)).not.toContain("Private content");
  expect(JSON.stringify(rawNotes.rows)).not.toContain("Private session");
});
it("reserves archiving for humans and preserves independently archived children", async () => {
  const leaf = (
    await knowledge.ensureTopic(agent, { path: ["Archive test", "Child"] })
  ).topic;
  const root = leaf.path[0].id;
  const session = (
    await knowledge.registerSession(agent, {
      name: "Archiving",
      session_key: "archive-session",
    })
  ).session;
  const input = {
    topic_id: leaf.id,
    session_id: session.id,
    body: "Retained history",
    idempotency_key: "archive-note",
  };
  await knowledge.appendNote(agent, input);
  await expect(
    knowledge.archiveTopic(agent, root, { archived: true }),
  ).rejects.toMatchObject({ code: "account_required" });
  await knowledge.archiveTopic(human, leaf.id, { archived: true });
  await knowledge.archiveTopic(human, root, { archived: true });
  expect(
    (await knowledge.listTopics(agent, { q: "Archive test" })).topics,
  ).toEqual([]);
  expect(
    (
      await knowledge.listTopics(agent, {
        q: "Archive test",
        include_archived: true,
      })
    ).topics,
  ).toHaveLength(2);
  expect((await knowledge.listNotes(agent, { topic_id: root })).notes).toEqual(
    [],
  );
  expect(
    (
      await knowledge.listNotes(agent, {
        topic_id: root,
        include_archived: true,
      })
    ).notes,
  ).toHaveLength(1);
  await expect(
    knowledge.ensureTopic(agent, { path: ["Archive test", "New child"] }),
  ).rejects.toMatchObject({ code: "topic_archived" });
  await expect(
    knowledge.appendNote(agent, {
      ...input,
      idempotency_key: "new-archived-note",
    }),
  ).rejects.toMatchObject({ code: "topic_archived" });
  expect((await knowledge.appendNote(agent, input)).replayed).toBe(true);
  await knowledge.archiveTopic(human, root, { archived: false });
  expect(
    (await knowledge.readTopic(agent, leaf.id)).topic.effective_archived,
  ).toBe(true);
  await knowledge.archiveTopic(human, leaf.id, { archived: false });
  expect(
    (await knowledge.listNotes(agent, { topic_id: root })).notes,
  ).toHaveLength(1);
});
it("searches encrypted notes beyond a scan batch and paginates without skipping matches", async () => {
  const topic = (await knowledge.ensureTopic(agent, { path: ["Pagination"] }))
    .topic;
  const scoped = await tenantDatabase(INITIAL_TENANT, directory);
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
      content: scoped.cipher!.encrypt(`topic-note:${id}`, {
        body: index < 3 ? `Needle ${index}` : "Other content",
        author,
      }),
      key: `bulk-${index}`,
    };
  });
  await scoped.query(
    `INSERT INTO ap_topic_notes(id,space,topic_id,principal_id,kind,encrypted_content,retry_key_hash,content_hash)
    SELECT r.id,'general',$1,$2,'note',r.content,r.key,r.key FROM jsonb_to_recordset($3) AS r(id uuid,content text,key text)`,
    [topic.id, human.id, JSON.stringify(records)],
  );
  const page = await knowledge.listNotes(agent, {
    topic_id: topic.id,
    q: "needle",
    limit: 2,
  });
  expect(page.notes).toHaveLength(2);
  expect(page.next_before).not.toBeNull();
  const last = await knowledge.listNotes(agent, {
    topic_id: topic.id,
    q: "needle",
    limit: 2,
    before: page.next_before,
  });
  expect(last.notes).toHaveLength(1);
  expect(last.next_before).toBeNull();
  expect(
    new Set([...page.notes, ...last.notes].map((note) => note.id)).size,
  ).toBe(3);
});
it("enforces HTTP scope, author validation, human-only archives and revocation", async () => {
  const workInput = {
    path: ["HTTP combined"],
    session_key: "combined-http",
    session_name: "HTTP combined session",
    body: "HTTP captured knowledge",
    idempotency_key: "combined-http",
  };
  expect((await api("work-notes", "POST", workInput)).status).toBe(201);
  expect((await api("work-notes", "POST", workInput)).status).toBe(200);
  expect(
    (await api("work-notes", "POST", { ...workInput, author: "spoof" })).status,
  ).toBe(400);
  const topicResponse = await api("topics", "POST", { path: ["HTTP topic"] });
  expect(topicResponse.status).toBe(201);
  const { topic } = await topicResponse.json();
  const registration = await api("agent-sessions", "POST", {
    session_key: "http-native",
    name: "HTTP session",
  });
  const { session } = await registration.json();
  const input = {
    topic_id: topic.id,
    session_id: session.id,
    body: "HTTP milestone",
    idempotency_key: "http-note",
  };
  expect(
    (await api("topic-notes", "POST", { ...input, author: "Someone else" }))
      .status,
  ).toBe(400);
  expect((await api("topic-notes", "POST", input)).status).toBe(201);
  expect(
    (await api(`topics/${topic.id}`, "PATCH", { archived: true })).status,
  ).toBe(403);
  state.human = true;
  expect(
    (await api(`topics/${topic.id}`, "PATCH", { archived: true }, "")).status,
  ).toBe(200);
  state.human = false;
  await directory.query(
    "UPDATE ap_connections SET scopes=ARRAY['astropath:read'] WHERE id=$1",
    [other.id],
  );
  expect(
    (
      await api(
        "topics",
        "POST",
        { path: ["Read-only write"] },
        tokens[1].token,
      )
    ).status,
  ).toBe(403);
  expect((await api("topics", "GET", undefined, tokens[1].token)).status).toBe(
    200,
  );
  await directory.query(
    "UPDATE ap_connections SET revoked_at=now() WHERE id=$1",
    [other.id],
  );
  expect((await api("topics", "GET", undefined, tokens[1].token)).status).toBe(
    401,
  );
  const schema = await openapi().json();
  expect(schema.paths["/topic-notes"].post.operationId).toBe("appendTopicNote");
});
it("exposes the complete agent workflow through MCP without an archive tool", async () => {
  const client = new Client({ name: "Knowledge test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL("https://knowledge.example/mcp"),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens[0].token}` },
        },
        fetch: (input, init) => mcpPost(new Request(input, init)),
      },
    ),
  );
  try {
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "list_topics",
        "ensure_topic",
        "read_topic",
        "register_agent_session",
        "append_topic_note",
        "list_topic_notes",
        "record_work_note",
        "create_public_upload",
      ]),
    );
    expect(listed.tools.some((tool) => tool.name === "archive_topic")).toBe(
      false,
    );
    async function call(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const text = result.content.find((item) => item.type === "text");
      if (!text || text.type !== "text")
        throw new Error("Missing tool response");
      return JSON.parse(text.text);
    }
    const { topic } = await call("ensure_topic", {
      path: ["MCP topic", "Experiments"],
    });
    const { session } = await call("register_agent_session", {
      name: "MCP run",
      session_key: "mcp-thread",
    });
    const { note } = await call("append_topic_note", {
      topic_id: topic.id,
      session_id: session.id,
      body: "MCP discovery",
      idempotency_key: "mcp-note",
    });
    expect(note.author.principal_id).toBe(agent.id);
    for (const [key, value] of Object.entries({
      R2_PUBLIC_ACCOUNT_ID: "test-account",
      R2_PUBLIC_BUCKET: "public-test",
      R2_PUBLIC_ACCESS_KEY_ID: "public-key",
      R2_PUBLIC_SECRET_ACCESS_KEY: "public-secret",
      R2_PUBLIC_BASE_URL: "https://files.example",
    }))
      vi.stubEnv(key, value);
    const publicInput = {
      name: "public.txt",
      size: 12,
      content_type: "text/plain",
    };
    const upload = await call("create_public_upload", publicInput);
    expect(upload.public_url).toMatch(/^https:\/\/files.example\/uploads\//);
    expect(upload.visibility).toBe("public");
    const httpUpload = await api("public-files/uploads", "POST", publicInput);
    expect(httpUpload.status).toBe(201);
    expect((await httpUpload.json()).public_url).toMatch(
      /^https:\/\/files.example\/uploads\//,
    );
    expect(
      (await api("public-files/uploads", "POST", publicInput, "invalid"))
        .status,
    ).toBe(401);
    expect((await (await api("public-files/config")).json()).enabled).toBe(
      true,
    );
    const combined = await call("record_work_note", {
      path: ["MCP topic", "Combined"],
      session_key: "mcp-thread",
      session_name: "MCP run",
      body: "One-call capture",
      idempotency_key: "mcp-combined",
    });
    expect(combined.note.author.session_id).toBe(session.id);
    expect(
      (await call("list_topic_notes", { topic_id: topic.id })).notes[0].id,
    ).toBe(note.id);
  } finally {
    await client.close();
  }
});

it("records work atomically and preserves exact retries across archived paths", async () => {
  const input = {
    path: ["Combined capture", "Experiments"],
    session_key: "combined-native",
    session_name: "Combined session",
    body: "A discovery worth sharing",
    kind: "decision",
    idempotency_key: "combined-1",
  };
  const first = await knowledge.recordWorkNote(agent, input);
  expect(first.note.author.session_id).toBe(first.session.id);
  expect(first.note.topic_id).toBe(first.topic.id);
  const retry = await knowledge.recordWorkNote(agent, {
    ...input,
    path: ["COMBINED capture", "Experiments"],
  });
  expect(retry.note).toEqual(first.note);
  expect(retry.replayed).toBe(true);
  await knowledge.archiveTopic(human, first.topic.path[0].id, {
    archived: true,
  });
  expect((await knowledge.recordWorkNote(agent, input)).note.id).toBe(
    first.note.id,
  );
  await expect(
    knowledge.recordWorkNote(agent, { ...input, body: "Changed" }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    knowledge.recordWorkNote(agent, {
      ...input,
      path: ["Stray topic"],
      session_key: "stray-session",
    }),
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    knowledge.recordWorkNote(agent, {
      ...input,
      idempotency_key: "combined-new",
      session_key: "stray-session",
    }),
  ).rejects.toMatchObject({ code: "topic_archived" });
  expect(
    (await knowledge.listTopics(agent, { q: "Stray topic" })).topics,
  ).toEqual([]);
  const scoped = await tenantDatabase(INITIAL_TENANT, directory);
  expect(
    (
      await scoped.query(
        "SELECT id FROM ap_agent_sessions WHERE session_key_hash=$1",
        [scoped.cipher!.fingerprint("agent-session", "stray-session")],
      )
    ).rows,
  ).toEqual([]);
  await expect(
    knowledge.recordWorkNote({ ...agent, scopes: ["astropath:read"] }, input),
  ).rejects.toMatchObject({ code: "insufficient_scope" });
  await expect(
    knowledge.recordWorkNote(agent, { ...input, space: "private" }),
  ).rejects.toMatchObject({ status: 404 });
  const independent = await knowledge.recordWorkNote(inOtherTenant, input);
  expect(independent.topic.id).not.toBe(first.topic.id);
});
