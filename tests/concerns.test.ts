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
import { concerns, concernModel, validate } from "../src/lib/concerns";
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
  const url = new URL(`https://concerns.example/api/v1/${path}`);
  return { GET, POST, PATCH }[method as "GET"](
    new Request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: "https://concerns.example",
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
  vi.stubEnv("APP_URL", "https://concerns.example");
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

const memberHuman: Principal = {
  ...human,
  owner: false,
  id: "member:m1",
  userId: "m1",
};
type Generated = Awaited<ReturnType<typeof concernModel.generate>>;
let inputs: string[] = [];
let reply: (input: string) => Generated = () => ({ concerns: [] });

it("keeps only concerns backed by real sources and known handles", () => {
  const catalog = new Map([
    [
      "T1",
      {
        type: "topic" as const,
        id: "t1",
        topic_id: "t1",
        title: "Deploy",
        at: "2026-10-01T10:00:00Z",
      },
    ],
    [
      "M1",
      {
        type: "memory" as const,
        id: "m1",
        session_id: "s1",
        title: "Note",
        at: "2026-10-02T10:00:00Z",
      },
    ],
  ]);
  const result = validate(
    {
      concerns: [
        {
          key: "Deploy window!",
          title: "Deploy",
          status: "in_progress",
          summary: "s",
          next_step: "",
          agents: ["@codex", "ghost"],
          sources: ["t1", "M1", "T9"],
        },
        {
          key: "deploy-window",
          title: "Dup key",
          status: "needs_you",
          summary: "s",
          next_step: "Approve",
          agents: [],
          sources: ["T1"],
        },
        {
          key: "invented",
          title: "No sources",
          status: "blocked",
          summary: "s",
          next_step: "",
          agents: [],
          sources: ["T42"],
        },
      ],
    },
    catalog,
    new Set(["codex"]),
  );
  expect(result.map((c) => c.key)).toEqual([
    "deploy-window-2",
    "deploy-window",
  ]);
  expect(result[1]).toMatchObject({
    agents: ["codex"],
    sources: [{ id: "t1" }, { id: "m1", session_id: "s1" }],
    last_activity: "2026-10-02T10:00:00Z",
  });
});

it("is off until the owner opts in, and only people can trigger a run", async () => {
  vi.stubEnv("ASTROPATH_AI_BASE_URL", "");
  expect((await concerns.list(agent)).configured).toBe(false);
  await expect(concerns.refresh(human, {})).rejects.toMatchObject({
    code: "concerns_unavailable",
  });
  vi.stubEnv("ASTROPATH_AI_BASE_URL", "http://gateway.test/chatgpt/v1");
  expect(await concerns.settings(agent)).toMatchObject({
    configured: true,
    enabled: false,
    model: "gpt-5.6-sol",
  });
  await expect(concerns.refresh(human, {})).rejects.toMatchObject({
    code: "concerns_disabled",
  });
  await expect(
    concerns.setEnabled(memberHuman, { enabled: true }),
  ).rejects.toMatchObject({ code: "owner_required" });
  await expect(
    concerns.setEnabled(agent, { enabled: true }),
  ).rejects.toMatchObject({ code: "account_required" });
  expect((await concerns.setEnabled(human, { enabled: true })).enabled).toBe(
    true,
  );
  await expect(concerns.refresh(agent, {})).rejects.toMatchObject({
    code: "account_required",
  });
});

it("summarizes one space from topics and memories, stores it encrypted, and reuses it while fresh", async () => {
  vi.spyOn(concernModel, "generate").mockImplementation(async (input) => {
    inputs.push(input);
    return reply(input);
  });
  await board.postTopic(other, {
    title: "DNS cutover blocked",
    body: "Waiting on the registrar. @owner can you approve the transfer?",
  });
  await memory.remember(agent, {
    session_key: "codex:concerns",
    session_name: "Concern test",
    body: "Retraction 0.8 mm fixed PETG stringing.",
    idempotency_key: "concerns-memory-1",
  });
  await board.postTopic(human, {
    title: "Private budget",
    body: "Not for agents.",
    space: "private",
  });
  reply = () => ({
    concerns: [
      {
        key: "dns-cutover",
        title: "Approve the DNS transfer",
        status: "needs_you",
        summary: "The registrar transfer waits on you.",
        next_step: "Approve the transfer.",
        agents: ["claude"],
        sources: ["T1"],
      },
      {
        key: "petg",
        title: "PETG stringing fixed",
        status: "resolved",
        summary: "0.8 mm retraction worked.",
        next_step: "",
        agents: ["codex"],
        sources: ["M1"],
      },
    ],
  });
  const result = await concerns.refresh(human, { space: "general" });
  const general = result.spaces.find((s) => s.space === "general")!;
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toContain('"DNS cutover blocked"');
  expect(inputs[0]).toContain("Retraction 0.8 mm");
  expect(inputs[0]).not.toContain("Private budget");
  expect(general).toMatchObject({
    stale: false,
    running: false,
    model: "gpt-5.6-sol",
  });
  expect(general.concerns.map((c) => c.key)).toEqual(["dns-cutover", "petg"]);
  expect(general.concerns[0].sources[0]).toMatchObject({
    type: "topic",
    title: "DNS cutover blocked",
  });
  expect(general.concerns[1].sources[0]).toMatchObject({ type: "memory" });
  const raw = await directory.query("SELECT * FROM ap_concern_snapshots");
  expect(JSON.stringify(raw.rows)).not.toContain("DNS");
  // Fresh: a second visit does not call the model again.
  await concerns.refresh(human, { space: "general" });
  expect(inputs).toHaveLength(1);
  // A forced refresh does, and passes the previous concerns for continuity.
  await concerns.refresh(human, { space: "general", force: true });
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toContain("PREVIOUS CONCERNS");
  expect(inputs[1]).toContain(
    "dns-cutover | needs_you | Approve the DNS transfer",
  );
});

it("keeps the last good list when a run fails, and limits lists to accessible spaces", async () => {
  vi.mocked(concernModel.generate).mockRejectedValueOnce(
    new Error("The model request failed (503)."),
  );
  const result = await concerns.refresh(human, {
    space: "general",
    force: true,
  });
  const general = result.spaces.find((s) => s.space === "general")!;
  expect(general.error).toBe("The model request failed (503).");
  expect(general.concerns.map((c) => c.key)).toEqual(["dns-cutover", "petg"]);
  const visible = await concerns.list(agent);
  expect(visible.spaces.map((s) => s.space)).toEqual(["general"]);
  const response = await api("concerns", "GET");
  expect(response.status).toBe(200);
  expect((await api("concerns/refresh", "POST", {})).status).toBe(403);
});
