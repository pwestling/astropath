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
import {
  projects,
  projectModel,
  validate,
  applyOverrides,
} from "../src/lib/projects";
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
  const url = new URL(`https://projects.example/api/v1/${path}`);
  return { GET, POST, PATCH }[method as "GET"](
    new Request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: "https://projects.example",
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
  vi.stubEnv("APP_URL", "https://projects.example");
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
type Generated = Awaited<ReturnType<typeof projectModel.generate>>;
type Raw = Generated["projects"][number];
const project = (fields: Partial<Raw>): Raw => ({
  key: "astropath",
  name: "Astropath",
  summary: "Agent workspace.",
  latest_kind: "progress",
  latest_headline: "Board shipped",
  latest_detail: "",
  alert: "none",
  alert_text: "",
  archive: false,
  archive_reason: "",
  agents: [],
  sources: ["T1"],
  ...fields,
});
let inputs: string[] = [];
let reply: (input: string) => Generated = () => ({ projects: [] });
const catalog = new Map([
  [
    "T1",
    {
      type: "topic" as const,
      id: "t1",
      topic_id: "t1",
      title: "Deploy",
      at: "2026-10-01T10:00:00.000Z",
    },
  ],
  [
    "M1",
    {
      type: "memory" as const,
      id: "m1",
      session_id: "s1",
      title: "Note",
      at: "2026-10-02T10:00:00.000Z",
    },
  ],
]);

it("keeps only projects backed by real sources and known handles", () => {
  const result = validate(
    {
      projects: [
        project({
          key: "Astropath!",
          agents: ["@codex", "ghost"],
          sources: ["t1", "M1", "T9"],
          alert: "needs_you",
          alert_text: "Approve the deploy window.",
        }),
        project({ key: "astropath", name: "Dup", sources: ["T1"] }),
        project({ key: "invented", name: "Ghost", sources: ["T42"] }),
        project({
          key: "printing",
          name: "Printing",
          sources: ["M1"],
          alert: "blocked",
          alert_text: "",
          archive: true,
          archive_reason: "Finished in September.",
        }),
      ],
    },
    catalog,
    new Set(["codex"]),
  );
  expect(result.map((p) => p.key)).toEqual([
    "astropath",
    "astropath-2",
    "printing",
  ]);
  expect(result[0]).toMatchObject({
    agents: ["codex"],
    sources: [{ id: "t1" }, { id: "m1", session_id: "s1" }],
    last_activity: "2026-10-02T10:00:00.000Z",
    alert: { kind: "needs_you", text: "Approve the deploy window." },
    ai_archived: null,
  });
  // An alert without text is no alert.
  expect(result[2]).toMatchObject({
    alert: null,
    ai_archived: { reason: "Finished in September." },
  });
});

it("applies a person's archive, keep-active and silence over the AI's view", () => {
  const [base] = validate(
    {
      projects: [
        project({
          alert: "blocked",
          alert_text: "DNS is down.",
          sources: ["T1"],
        }),
      ],
    },
    catalog,
    new Set(),
  );
  const at = (when: string, kind: "archived" | "unarchived" | "silenced") => ({
    id: kind,
    kind,
    set_at: when,
    key: "astropath",
    name: "Astropath",
    source_ids: ["t1"],
  });
  const before = "2026-10-01T12:00:00.000Z";
  const earlier = "2026-09-30T12:00:00.000Z";
  expect(applyOverrides([base], [at(before, "archived")])[0]).toMatchObject({
    archived: true,
    archived_by: "you",
    resumed: false,
  });
  // New activity after your archive brings it back.
  expect(applyOverrides([base], [at(earlier, "archived")])[0]).toMatchObject({
    archived: false,
    resumed: true,
  });
  const aiArchived = { ...base, ai_archived: { reason: "Looks done." } };
  expect(applyOverrides([aiArchived], [])[0]).toMatchObject({
    archived: true,
    archived_by: "ai",
  });
  expect(
    applyOverrides([aiArchived], [at(before, "unarchived")])[0],
  ).toMatchObject({ archived: false, kept_active: true });
  expect(applyOverrides([base], [at(before, "silenced")])[0].silenced).toBe(
    true,
  );
  expect(applyOverrides([base], [at(earlier, "silenced")])[0].silenced).toBe(
    false,
  );
  // A renamed project still matches by shared sources.
  expect(
    applyOverrides(
      [{ ...base, key: "astropath-app" }],
      [at(before, "archived")],
    )[0].archived_by,
  ).toBe("you");
});

it("is off until the owner opts in, and only people can trigger runs or overrides", async () => {
  vi.stubEnv("ASTROPATH_AI_BASE_URL", "");
  expect((await projects.list(agent)).configured).toBe(false);
  await expect(projects.refresh(human, {})).rejects.toMatchObject({
    code: "projects_unavailable",
  });
  vi.stubEnv("ASTROPATH_AI_BASE_URL", "http://gateway.test/chatgpt/v1");
  expect(await projects.settings(agent)).toMatchObject({
    configured: true,
    enabled: false,
    model: "gpt-5.6-sol",
  });
  await expect(projects.refresh(human, {})).rejects.toMatchObject({
    code: "projects_disabled",
  });
  await expect(
    projects.setEnabled(memberHuman, { enabled: true }),
  ).rejects.toMatchObject({ code: "owner_required" });
  await expect(
    projects.setEnabled(agent, { enabled: true }),
  ).rejects.toMatchObject({ code: "account_required" });
  expect((await projects.setEnabled(human, { enabled: true })).enabled).toBe(
    true,
  );
  await expect(projects.refresh(agent, {})).rejects.toMatchObject({
    code: "account_required",
  });
  await expect(
    projects.setOverride(agent, {
      space: "general",
      key: "x",
      kind: "archived",
    }),
  ).rejects.toMatchObject({ code: "account_required" });
});

it("mines projects from one space, honours overrides on the next run, and reuses fresh results", async () => {
  vi.spyOn(projectModel, "generate").mockImplementation(async (input) => {
    inputs.push(input);
    return reply(input);
  });
  await board.postTopic(other, {
    title: "Astropath DNS cutover blocked",
    body: "Waiting on the registrar. @owner please approve the transfer.",
  });
  await memory.remember(agent, {
    session_key: "codex:projects",
    session_name: "PETG tuning",
    session_context: "Codex in ~/prints",
    body: "Retraction 0.8 mm fixed PETG stringing.",
    idempotency_key: "projects-memory-1",
  });
  await board.postTopic(human, {
    title: "Private budget",
    body: "Not for agents.",
    space: "private",
  });
  reply = () => ({
    projects: [
      project({
        alert: "needs_you",
        alert_text: "Approve the registrar transfer.",
        latest_kind: "blocked",
        latest_headline: "DNS cutover waits on the registrar",
        agents: ["claude"],
        sources: ["T1"],
      }),
      project({
        key: "petg",
        name: "PETG printing",
        latest_kind: "shipped",
        latest_headline: "Stringing fixed with 0.8 mm retraction",
        archive: true,
        archive_reason: "Tuning is finished.",
        agents: ["codex"],
        sources: ["M1"],
      }),
    ],
  });
  const first = (await projects.refresh(human, { space: "general" })).spaces[0];
  expect(inputs).toHaveLength(1);
  expect(inputs[0]).toContain('"Astropath DNS cutover blocked"');
  expect(inputs[0]).toContain("PETG tuning; Codex in ~/prints");
  expect(inputs[0]).not.toContain("Private budget");
  expect(first).toMatchObject({ space: "general", stale: false });
  expect(first.projects.map((p) => [p.key, p.archived, p.archived_by])).toEqual(
    [
      ["petg", true, "ai"],
      ["astropath", false, null],
    ],
  );
  const raw = await directory.query("SELECT * FROM ap_concern_snapshots");
  expect(JSON.stringify(raw.rows)).not.toContain("DNS");
  // Fresh: no second model call without force.
  await projects.refresh(human, { space: "general" });
  expect(inputs).toHaveLength(1);
  // The person keeps PETG active and silences the Astropath alert.
  await projects.setOverride(human, {
    space: "general",
    key: "petg",
    kind: "unarchived",
  });
  const after = await projects.setOverride(human, {
    space: "general",
    key: "astropath",
    kind: "silenced",
  });
  const byKey = new Map(after.spaces[0].projects.map((p) => [p.key, p]));
  expect(byKey.get("petg")).toMatchObject({
    archived: false,
    kept_active: true,
  });
  expect(byKey.get("astropath")).toMatchObject({ silenced: true });
  // The next run is told about previous projects and the overrides.
  await projects.refresh(human, { space: "general", force: true });
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toContain("PREVIOUS PROJECTS");
  expect(inputs[1]).toContain("- petg | PETG printing | archived");
  expect(inputs[1]).toContain("petg | PETG printing | kept active");
  expect(inputs[1]).toContain("astropath | Astropath | silenced");
  // Archiving by the person replaces keep-active.
  const archived = await projects.setOverride(human, {
    space: "general",
    key: "petg",
    kind: "archived",
  });
  expect(
    archived.spaces[0].projects.find((p) => p.key === "petg"),
  ).toMatchObject({ archived: true, archived_by: "you", kept_active: false });
  await expect(
    projects.setOverride(human, {
      space: "general",
      key: "nope",
      kind: "archived",
    }),
  ).rejects.toMatchObject({ status: 404 });
});

it("ignores older snapshot formats, keeps the last good list on failure, and limits spaces", async () => {
  // An earlier "concerns" snapshot (no version) is newer but ignored.
  const tenant = await tenantDatabase(INITIAL_TENANT, directory);
  const id = randomUUID();
  await tenant.query(
    "INSERT INTO ap_concern_snapshots(id,space,status,model,started_by,encrypted_content,started_at,finished_at) VALUES($1,'general','ok','x','test',$2,now(),now())",
    [id, tenant.cipher!.encrypt(`concerns:${id}`, { concerns: [] })],
  );
  expect(
    (await projects.list(human)).spaces[0].projects.map((p) => p.key).sort(),
  ).toEqual(["astropath", "petg"]);
  vi.mocked(projectModel.generate).mockRejectedValueOnce(
    new Error("The model request failed (503)."),
  );
  const failed = (
    await projects.refresh(human, { space: "general", force: true })
  ).spaces[0];
  expect(failed.error).toBe("The model request failed (503).");
  expect(failed.projects.length).toBe(2);
  expect((await projects.list(agent)).spaces.map((s) => s.space)).toEqual([
    "general",
  ]);
  expect((await api("projects", "GET")).status).toBe(200);
  expect((await api("projects/refresh", "POST", {})).status).toBe(403);
  expect(
    (
      await api("projects/overrides", "POST", {
        space: "general",
        key: "petg",
        kind: "archived",
      })
    ).status,
  ).toBe(403);
});
