import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";
import { tenantDatabase, type Database, type Queryable } from "../src/lib/db";
import { migrateTenancy, INITIAL_TENANT } from "../src/lib/tenant-migration";
import { newTenantKey } from "../src/lib/encryption";
import {
  agents,
  agentFor,
  handleFrom,
  resolveHandles,
} from "../src/lib/agents";
import { createConnection } from "../src/lib/admin";
import type { Principal } from "../src/lib/policy";

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
vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    db: {
      ...actual.db,
      forTenant: (id: string) => actual.tenantDatabase(id, directory),
    },
  };
});
const second = randomUUID();
const owner: Principal = {
  id: "owner:owner",
  userId: "owner",
  name: "Porter Westling",
  owner: true,
  tenantId: INITIAL_TENANT,
  scopes: ["astropath:read", "astropath:write"],
  spaces: null,
};
const connection = (id: string, name: string): Principal => ({
  id,
  name,
  owner: false,
  tenantId: INITIAL_TENANT,
  scopes: ["astropath:read", "astropath:write"],
  spaces: ["general"],
});
const ids = {
  oldClaude: randomUUID(),
  newClaude: randomUUID(),
  codex: randomUUID(),
  otherTenant: randomUUID(),
};

beforeAll(async () => {
  vi.stubEnv("ASTROPATH_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("APP_URL", "https://astropath.example");
  vi.stubEnv("OWNER_EMAIL", "owner@example.com");
  await engine.exec(`CREATE TABLE "user"(id text PRIMARY KEY,name text,email text);
    INSERT INTO "user" VALUES('owner','Porter Westling','owner@example.com');`);
  await engine.exec(
    await readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8"),
  );
  await directory.transaction(migrateTenancy);
  await directory.query(
    "INSERT INTO ap_tenants(id,name,wrapped_key) VALUES($1,'Other',$2)",
    [second, newTenantKey(second)],
  );
  await directory.query(
    "INSERT INTO ap_spaces(tenant_id,slug,name) VALUES($1,'general','General')",
    [second],
  );
  // Connections as they exist before agents: a revoked "Claude", its
  // reconnect under the same name, Codex, and a "Claude" in another tenant.
  await directory.query(
    `INSERT INTO ap_connections(id,tenant_id,name,kind,scopes,spaces,created_by_user_id,created_at,revoked_at)
    VALUES($1,$5,'Claude','oauth','{astropath:read}','{general}','owner','2026-09-01',now()),
      ($2,$5,'Claude','oauth','{astropath:read}','{general}','owner','2026-09-02',NULL),
      ($3,$5,'Codex','token','{astropath:read}','{general}','owner','2026-09-03',NULL),
      ($4,$6,'Claude','oauth','{astropath:read}','{general}','owner','2026-09-04',NULL)`,
    [
      ids.oldClaude,
      ids.newClaude,
      ids.codex,
      ids.otherTenant,
      INITIAL_TENANT,
      second,
    ],
  );
  await directory.transaction(migrateTenancy);
  await directory.transaction(migrateTenancy);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await engine.close();
});

it("derives readable handles from names", () => {
  expect(handleFrom("Claude Code (Work)")).toBe("claude-code-work");
  expect(handleFrom("Évelyne's Agent")).toBe("evelyne-s-agent");
  expect(handleFrom("!!!")).toBe("agent");
});

it("migrates connections to agents, keeping reconnects together and tenants apart", async () => {
  const rows = (
    await directory.query<{ id: string; agent_id: string; tenant_id: string }>(
      "SELECT id,agent_id,tenant_id FROM ap_connections",
    )
  ).rows;
  const agentOf = (id: string) => rows.find((row) => row.id === id)!.agent_id;
  expect(agentOf(ids.oldClaude)).toBe(agentOf(ids.newClaude));
  expect(agentOf(ids.codex)).not.toBe(agentOf(ids.newClaude));
  expect(agentOf(ids.otherTenant)).not.toBe(agentOf(ids.newClaude));
  const listed = (await agents.list(owner)).agents;
  expect(listed.map((agent) => agent.handle).sort()).toEqual([
    "claude",
    "codex",
    "porter-westling",
  ]);
  expect(
    listed.find((agent) => agent.handle === "porter-westling"),
  ).toMatchObject({
    kind: "human",
    display_name: "Porter Westling",
    active: true,
  });
  // The other tenant has its own @claude.
  const otherOwner = { ...owner, tenantId: second };
  expect(
    (await agents.list(otherOwner)).agents.map((agent) => agent.handle),
  ).toContain("claude");
  const raw = await directory.query("SELECT encrypted_profile FROM ap_agents");
  expect(JSON.stringify(raw.rows)).not.toContain("Porter Westling");
});

it("lets an agent describe itself and resolves @handles", async () => {
  const codex = connection(ids.codex, "Codex");
  const { agent } = await agents.setProfile(codex, {
    harness: "Codex CLI",
    description: "Works in ~/dev/personal; good at refactors.",
  });
  expect(agent).toMatchObject({ handle: "codex", harness: "Codex CLI" });
  expect((await agents.me(codex)).agent.description).toContain("refactors");
  await agents.setProfile(codex, { harness: "" });
  expect((await agents.me(codex)).agent.harness).toBeUndefined();
  const tenant = await tenantDatabase(INITIAL_TENANT, directory);
  const resolved = await tenant.transaction((tx) =>
    resolveHandles(tx, ["@Codex", "claude"]),
  );
  expect(resolved.map((row) => row.handle).sort()).toEqual(["claude", "codex"]);
  await expect(
    tenant.transaction((tx) => resolveHandles(tx, ["@nobody"])),
  ).rejects.toMatchObject({ code: "unknown_handle" });
  await expect(
    agents.setProfile({ ...codex, scopes: ["astropath:read"] }, {}),
  ).rejects.toMatchObject({ code: "insufficient_scope" });
});

it("lets only the owner rename handles, and only to a free one", async () => {
  const claude = (await agents.list(owner)).agents.find(
    (agent) => agent.handle === "claude",
  )!;
  await expect(
    agents.update({ ...owner, owner: false }, claude.id, { handle: "cc" }),
  ).rejects.toMatchObject({ code: "owner_required" });
  await expect(
    agents.update(owner, claude.id, { handle: "codex" }),
  ).rejects.toMatchObject({ code: "handle_taken" });
  await expect(
    agents.update(connection(ids.codex, "Codex"), claude.id, { handle: "x" }),
  ).rejects.toMatchObject({ code: "account_required" });
  const renamed = await agents.update(owner, claude.id, {
    handle: "claude-code",
    harness: "Claude Code",
  });
  expect(renamed.agent).toMatchObject({
    handle: "claude-code",
    harness: "Claude Code",
  });
  // A connection keeps its agent across the rename.
  expect(
    (await agents.me(connection(ids.newClaude, "Claude"))).agent.handle,
  ).toBe("claude-code");
});

it("attaches new tokens to the matching agent, or to a chosen one", async () => {
  const codexAgent = (await agents.list(owner)).agents.find(
    (agent) => agent.handle === "codex",
  )!;
  const chosen = await createConnection(owner, {
    name: "Codex Laptop",
    scopes: ["astropath:read"],
    agent_id: codexAgent.id,
  });
  const fresh = await createConnection(owner, {
    name: "Lev",
    scopes: ["astropath:read"],
  });
  const handleOf = async (id: string, name: string) =>
    (await agents.me(connection(id, name))).agent.handle;
  expect(await handleOf(chosen.id, "Codex Laptop")).toBe("codex");
  expect(await handleOf(fresh.id, "Lev")).toBe("lev");
  await expect(
    createConnection(owner, {
      name: "Stray",
      scopes: ["astropath:read"],
      agent_id: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 404 });
});

it("creates an agent on first use for a connection that has none", async () => {
  const id = randomUUID();
  await directory.query(
    `INSERT INTO ap_connections(id,tenant_id,name,kind,scopes,spaces,created_by_user_id)
    VALUES($1,$2,'Hermes','oauth','{astropath:read}','{general}','owner')`,
    [id, INITIAL_TENANT],
  );
  const tenant = await tenantDatabase(INITIAL_TENANT, directory);
  const agent = await tenant.transaction((tx) =>
    agentFor(tx, connection(id, "Hermes")),
  );
  expect(agent).toMatchObject({ handle: "hermes", kind: "agent" });
});
