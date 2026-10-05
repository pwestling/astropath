import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";
import { createLocalJWKSet, SignJWT } from "jose";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Database, Queryable } from "../src/lib/db";
import { migrateTenancy, INITIAL_TENANT } from "../src/lib/tenant-migration";
import { mintToken, type Principal } from "../src/lib/policy";
import { GET, POST, PATCH } from "../src/app/api/v1/[[...path]]/route";
import { POST as mcpPost } from "../src/app/mcp/route";
import { POST as publishPost } from "../src/app/api/platform/v1/apps/[app]/releases/route";
import { GET as jwksGet } from "../src/app/api/platform/v1/jwks/[tenant]/route";
import { canonicalJson, validateManifest } from "../src/lib/platform/contracts";
// @ts-expect-error The example app is plain JavaScript.
import { createEchoApp, manifest } from "../examples/echo-app/app.mjs";

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
const ORIGIN = "https://platform.example";
const ECHO = "http://echo.test";
const tokens = [mintToken(), mintToken()];
const codex: Principal = {
  id: randomUUID(),
  name: "Codex",
  tenantId: INITIAL_TENANT,
  owner: false,
  spaces: ["general"],
  scopes: ["astropath:read", "astropath:write"],
};
const claude: Principal = { ...codex, id: randomUUID(), name: "Claude" };

async function api(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
) {
  const url = new URL(`${ORIGIN}/api/v1/${path}`);
  state.human = !token;
  return { GET, POST, PATCH }[method as "GET"](
    new Request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: url.pathname.slice(8).split("/") }) },
  );
}
const asOwner = (path: string, method = "GET", body?: unknown) =>
  api(path, method, body);
const asCodex = (path: string, method = "GET", body?: unknown) =>
  api(path, method, body, tokens[0].token);
const asClaude = (path: string, method = "GET", body?: unknown) =>
  api(path, method, body, tokens[1].token);
async function publish(key: string, body: unknown, app = "echo") {
  const response = await publishPost(
    new Request(`${ORIGIN}/api/platform/v1/apps/${app}/releases`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ app }) },
  );
  return { status: response.status, body: await response.json() };
}

// The echo app runs in-process; fetches to its origin reach it directly.
let echo: ReturnType<typeof createEchoApp>;
let serving: string | null = null;
let dropResponse = false;
const slowRoute = async (args: { ms: number }) => {
  await new Promise((resolve) => setTimeout(resolve, args.ms));
  return { done: true };
};
function startEcho(release: string) {
  serving = release;
  echo = createEchoApp({
    issuer: ORIGIN,
    jwks: async (header: unknown, token: unknown) => {
      const keys = await (
        await jwksGet(new Request(`${ORIGIN}/x`), {
          params: Promise.resolve({ tenant: INITIAL_TENANT }),
        })
      ).json();
      return createLocalJWKSet(keys)(header as never, token as never);
    },
    release,
    routes: { "/ops/slow/v1": slowRoute },
  });
}
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== ECHO) return realFetch(input, init);
  if (!serving)
    return Promise.reject(
      Object.assign(new TypeError("fetch failed"), {
        cause: new Error("connect ECONNREFUSED"),
      }),
    );
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    echo.handle(new Request(url, init)).then((response: Response) => {
      if (dropResponse) reject(new TypeError("socket hang up"));
      else resolve(response);
    }, reject);
  });
});

beforeAll(async () => {
  state.database = directory;
  vi.stubEnv("ASTROPATH_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("APP_URL", ORIGIN);
  await engine.exec(`CREATE TABLE "user"(id text PRIMARY KEY,name text,email text);
    INSERT INTO "user" VALUES('owner','Owner','owner@example.com');`);
  await engine.exec(
    await readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8"),
  );
  await directory.transaction(migrateTenancy);
  await directory.transaction(migrateTenancy);
  for (const [index, principal] of [codex, claude].entries())
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
  vi.unstubAllGlobals();
  await engine.close();
});

const slowOp = {
  name: "echo.slow",
  version: "1.0.0",
  summary: "Wait, then answer.",
  effect: "write",
  timeout_ms: 1000,
  input_schema: {
    type: "object",
    properties: { ms: { type: "integer" } },
    required: ["ms"],
    additionalProperties: false,
  },
  output_schema: { type: "object" },
  route: { path: "/ops/slow/v1" },
};

let publisherKey = "";
let firstRevision = "";

describe("manifest validation", () => {
  it("rejects remote references, foreign namespaces and bad examples", () => {
    const bad = manifest("9.9.9", [
      {
        ...slowOp,
        name: "other.thing",
        input_schema: {
          type: "object",
          properties: { a: { $ref: "https://evil.example/schema.json" } },
        },
      },
      { ...slowOp, examples: [{ ms: "soon" }] },
    ]);
    expect(() => validateManifest(bad, "echo")).toThrowError(
      /other\.thing|\$ref/,
    );
    try {
      validateManifest(bad, "echo");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/must be echo\.<name>/);
      expect(message).toMatch(/local reference/);
      expect(message).toMatch(/examples\.0 does not match/);
    }
    expect(() => validateManifest(manifest(), "other")).toThrowError(
      /app must be other/,
    );
    expect(() =>
      validateManifest({ ...manifest(), app: "platform" }, "platform"),
    ).toThrowError(/reserved/);
  });
  it("hashes arguments canonically", () => {
    expect(canonicalJson({ b: [1, { d: 2, c: "x" }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":"x","d":2}]}',
    );
  });
});

describe("the tool platform", () => {
  it("serves built-in operations through discover and invoke", async () => {
    const listed = await (await asCodex("discover", "POST", {})).json();
    expect(listed.catalog_revision).toMatch(/^cat_/);
    expect(listed.apps.map((a: { app: string }) => a.app)).toEqual(
      expect.arrayContaining(["core", "platform"]),
    );
    const found = await (
      await asCodex("discover", "POST", { query: "remember memory" })
    ).json();
    expect(found.results[0].operation).toBe("core.remember");
    const contract = await (
      await asCodex("discover", "POST", { operation: "core.remember" })
    ).json();
    expect(contract.results[0].input_schema.properties.body).toBeTruthy();
    expect(contract.results[0].input_schema.properties).not.toHaveProperty(
      "idempotency_key",
    );

    const call = {
      operation: "core.remember",
      version: "1.0.0",
      arguments: {
        body: "Platform test memory.",
        session_key: "client:platform-1",
      },
      idempotency_key: "mem-1",
    };
    const missingKey = await asCodex("invoke", "POST", {
      ...call,
      idempotency_key: undefined,
    });
    expect(missingKey.status).toBe(400);
    const first = await (await asCodex("invoke", "POST", call)).json();
    expect(first).toMatchObject({ status: "succeeded", replayed: false });
    expect(first.receipt_id).toBeTruthy();
    const again = await (await asCodex("invoke", "POST", call)).json();
    expect(again).toMatchObject({
      status: "succeeded",
      replayed: true,
      receipt_id: first.receipt_id,
    });
    expect(again.result.memory.id).toBe(first.result.memory.id);
    const conflict = await asCodex("invoke", "POST", {
      ...call,
      arguments: { ...call.arguments, body: "Different." },
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      effect_state: "none",
    });
    const recalled = await (
      await asCodex("invoke", "POST", {
        operation: "core.recall",
        version: "1.0.0",
        arguments: { q: "Platform test" },
      })
    ).json();
    expect(recalled.result.memories).toHaveLength(1);

    // Receipts are visible to their caller and the owner only.
    const receipt = await (
      await asCodex(`invocations/${first.receipt_id}`)
    ).json();
    expect(receipt).toMatchObject({
      status: "succeeded",
      operation: "core.remember",
    });
    expect((await asClaude(`invocations/${first.receipt_id}`)).status).toBe(
      404,
    );
    expect((await asOwner(`invocations/${first.receipt_id}`)).status).toBe(200);
    const viaOperation = await (
      await asCodex("invoke", "POST", {
        operation: "platform.get_receipt",
        version: "1.0.0",
        arguments: { receipt_id: first.receipt_id },
      })
    ).json();
    expect(viaOperation.result.receipt_id).toBe(first.receipt_id);

    const unselected = await asCodex("execute", "POST", {
      operations: [{ operation: "core.nothing", version: "1.0.0" }],
      code: "async () => 1",
    });
    expect((await unselected.json()).error.code).toBe("NOT_AVAILABLE");
  });

  it("lets only the owner create apps and issues a publisher key once", async () => {
    expect(
      (
        await asCodex("apps", "POST", {
          id: "echo",
          name: "Echo",
          origin: ECHO,
        })
      ).status,
    ).toBe(403);
    const bad = await asOwner("apps", "POST", {
      id: "echo",
      name: "Echo",
      origin: `${ECHO}/path?x=1`,
    });
    expect(bad.status).toBe(400);
    const created = await asOwner("apps", "POST", {
      id: "echo",
      name: "Echo",
      origin: ECHO,
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.publisher_key).toMatch(/^apk_/);
    expect(body.jwks_url).toBe(`/api/platform/v1/jwks/${INITIAL_TENANT}`);
    publisherKey = body.publisher_key;
    expect(
      (await asOwner("apps", "POST", { id: "echo", name: "x", origin: ECHO }))
        .status,
    ).toBe(409);
  });

  it("publishes a release only once the app serves it", async () => {
    const before = await (await asCodex("discover", "POST", {})).json();
    firstRevision = before.catalog_revision;
    expect(
      (await publish("apk_" + "x".repeat(43), { manifest: manifest() })).status,
    ).toBe(401);
    expect(
      (await publish(publisherKey, { manifest: manifest() }, "other")).status,
    ).toBe(403);
    const notServing = await publish(publisherKey, { manifest: manifest() });
    expect(notServing.status).toBe(502);
    expect(notServing.body.error.message).toMatch(/Deploy first/);
    startEcho("0.1.0");
    const stale = await publish(publisherKey, {
      manifest: manifest(),
      expected_catalog_revision: "cat_" + "0".repeat(32),
    });
    expect(stale.body.error.code).toBe("CATALOG_CONFLICT");
    const published = await publish(publisherKey, {
      manifest: manifest(),
      expected_catalog_revision: firstRevision,
    });
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({
      app: "echo",
      release: "0.1.0",
      operations: 2,
    });
    expect(published.body.catalog_revision).not.toBe(firstRevision);
    const replay = await publish(publisherKey, { manifest: manifest() });
    expect(replay).toMatchObject({ status: 200, body: { replayed: true } });
    const changed = manifest();
    changed.description = "Different content.";
    expect(
      (await publish(publisherKey, { manifest: changed })).body.error.code,
    ).toBe("RELEASE_CONFLICT");
  });

  it("shows new app operations to an already-connected MCP client", async () => {
    const client = new Client({ name: "platform-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens[0].token}` },
        },
        fetch: (input, init) => mcpPost(new Request(input, init)),
      }),
    );
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(
        expect.arrayContaining(["discover", "invoke", "execute"]),
      );
      const toolSchemas = JSON.stringify((await client.listTools()).tools);
      const searched = await client.callTool({
        name: "discover",
        arguments: { query: "shout" },
      });
      expect(
        (searched.structuredContent as { results: unknown[] }).results,
      ).toEqual([]);
      // A new release adds an operation; the client's tool list is unchanged.
      startEcho("0.2.0");
      const shout = {
        ...slowOp,
        name: "echo.shout",
        summary: "Shout text back.",
        effect: "read",
        input_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        route: { path: "/ops/say/v1" },
        output_schema: { type: "object" },
      };
      expect(
        (await publish(publisherKey, { manifest: manifest("0.2.0", [shout]) }))
          .status,
      ).toBe(201);
      expect(JSON.stringify((await client.listTools()).tools)).toBe(
        toolSchemas,
      );
      const found = await client.callTool({
        name: "discover",
        arguments: { query: "shout" },
      });
      const result = found.structuredContent as {
        catalog_revision: string;
        results: { operation: string; version: string }[];
      };
      expect(result.results[0]).toMatchObject({
        operation: "echo.shout",
        version: "1.0.0",
      });
      const called = await client.callTool({
        name: "invoke",
        arguments: {
          catalog_revision: result.catalog_revision,
          operation: "echo.say",
          version: "1.0.0",
          arguments: { text: "hello" },
        },
      });
      expect(called.isError).toBeFalsy();
      expect(called.structuredContent).toMatchObject({
        status: "succeeded",
        result: { text: "hello", caller: "Codex" },
      });
      const invalid = await client.callTool({
        name: "invoke",
        arguments: {
          operation: "echo.say",
          version: "1.0.0",
          arguments: { text: 42 },
        },
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid.content)).toContain("INVALID_ARGUMENTS");
    } finally {
      await client.close();
    }
  });

  it("deduplicates writes by key and never repeats a committed effect", async () => {
    const call = {
      operation: "echo.counter_add",
      version: "1.0.0",
      arguments: { amount: 5 },
      idempotency_key: "add-5",
    };
    const first = await (await asCodex("invoke", "POST", call)).json();
    expect(first).toMatchObject({ status: "succeeded", result: { total: 5 } });
    const replay = await (await asCodex("invoke", "POST", call)).json();
    expect(replay).toMatchObject({ replayed: true, result: { total: 5 } });
    expect(echo.total).toBe(5);
    // The response is lost after the app committed: the outcome is unknown,
    // and a retry with the same key finishes the same invocation once.
    dropResponse = true;
    const lost = await (
      await asCodex("invoke", "POST", {
        ...call,
        idempotency_key: "add-2",
        arguments: { amount: 2 },
      })
    ).json();
    dropResponse = false;
    expect(lost).toMatchObject({
      status: "unknown",
      error: {
        code: "OUTCOME_UNKNOWN",
        effect_state: "unknown",
        retry_advice: "same_key",
      },
    });
    expect(echo.total).toBe(7);
    const retried = await (
      await asCodex("invoke", "POST", {
        ...call,
        idempotency_key: "add-2",
        arguments: { amount: 2 },
      })
    ).json();
    expect(retried).toMatchObject({
      status: "succeeded",
      receipt_id: lost.receipt_id,
      result: { total: 7 },
    });
    expect(echo.total).toBe(7);
  });

  it("reports a timeout on a non-deduplicating write as unknown, without retrying it", async () => {
    startEcho("0.3.0");
    expect(
      (await publish(publisherKey, { manifest: manifest("0.3.0", [slowOp]) }))
        .status,
    ).toBe(201);
    const call = {
      operation: "echo.slow",
      version: "1.0.0",
      arguments: { ms: 1500 },
      idempotency_key: "slow-1",
    };
    const first = await (await asCodex("invoke", "POST", call)).json();
    expect(first).toMatchObject({
      status: "unknown",
      error: { code: "OUTCOME_UNKNOWN", retry_advice: "reconcile" },
    });
    const again = await (await asCodex("invoke", "POST", call)).json();
    expect(again).toMatchObject({
      status: "unknown",
      replayed: true,
      receipt_id: first.receipt_id,
      error: { retry_advice: "reconcile" },
    });
  });

  it("honours a pinned catalog until the operation version is retired", async () => {
    const pinned = (await (await asCodex("discover", "POST", {})).json())
      .catalog_revision;
    startEcho("0.4.0");
    const without = manifest("0.4.0");
    without.operations = without.operations.filter(
      (op: { name: string }) => op.name !== "echo.counter_add",
    );
    expect((await publish(publisherKey, { manifest: without })).status).toBe(
      201,
    );
    const say = await (
      await asCodex("invoke", "POST", {
        catalog_revision: pinned,
        operation: "echo.say",
        version: "1.0.0",
        arguments: { text: "still here" },
      })
    ).json();
    expect(say.status).toBe("succeeded");
    const retired = await asCodex("invoke", "POST", {
      catalog_revision: pinned,
      operation: "echo.counter_add",
      version: "1.0.0",
      arguments: { amount: 1 },
      idempotency_key: "retired-1",
    });
    expect((await retired.json()).error.code).toBe("OPERATION_RETIRED");
    const current = await asCodex("invoke", "POST", {
      operation: "echo.counter_add",
      version: "1.0.0",
      arguments: { amount: 1 },
      idempotency_key: "retired-2",
    });
    expect((await current.json()).error.code).toBe("NOT_AVAILABLE");
    const unknownRevision = await asCodex("invoke", "POST", {
      catalog_revision: "cat_" + "1".repeat(32),
      operation: "echo.say",
      version: "1.0.0",
      arguments: { text: "x" },
    });
    expect((await unknownRevision.json()).error.code).toBe("CATALOG_EXPIRED");
    // Changing an existing version's contract is rejected.
    const changed = manifest("0.5.0");
    changed.operations[0].summary = "A different contract.";
    startEcho("0.5.0");
    expect(
      (await publish(publisherKey, { manifest: changed })).body.error.message,
    ).toMatch(/different contract/);
  });

  it("grants app operations automatically, with exclusions and explicit apps", async () => {
    const say = {
      operation: "echo.say",
      version: "1.0.0",
      arguments: { text: "hi" },
    };
    expect((await (await asClaude("invoke", "POST", say)).json()).status).toBe(
      "succeeded",
    );
    // Excluding a connection hides the app from it entirely.
    expect(
      (
        await asOwner("apps/echo/grants", "POST", {
          connection_id: claude.id,
          mode: "exclude",
        })
      ).status,
    ).toBe(200);
    const hidden = await (
      await asClaude("discover", "POST", { operation: "echo.say" })
    ).json();
    expect(hidden.results).toEqual([]);
    const denied = await (await asClaude("invoke", "POST", say)).json();
    const missing = await (
      await asClaude("invoke", "POST", { ...say, operation: "echo.nothing" })
    ).json();
    expect(denied.error).toEqual(missing.error);
    expect((await (await asCodex("invoke", "POST", say)).json()).status).toBe(
      "succeeded",
    );
    // Explicit apps reach only included connections.
    await asOwner("apps/echo", "PATCH", { grant_policy: "explicit" });
    expect(
      (await (await asCodex("invoke", "POST", say)).json()).error.code,
    ).toBe("NOT_AVAILABLE");
    await asOwner("apps/echo/grants", "POST", {
      connection_id: codex.id,
      mode: "include",
    });
    expect((await (await asCodex("invoke", "POST", say)).json()).status).toBe(
      "succeeded",
    );
    await asOwner("apps/echo", "PATCH", { grant_policy: "auto" });
    await asOwner("apps/echo/grants", "POST", {
      connection_id: claude.id,
      mode: null,
    });
    expect((await (await asClaude("invoke", "POST", say)).json()).status).toBe(
      "succeeded",
    );
    // A read-only connection gets only read operations.
    await directory.query("UPDATE ap_connections SET scopes=$2 WHERE id=$1", [
      claude.id,
      ["astropath:read"],
    ]);
    const visible = await (
      await asClaude("discover", "POST", { namespace: "echo" })
    ).json();
    expect(
      visible.results.map((r: { operation: string }) => r.operation),
    ).toEqual(["echo.say"]);
    await directory.query("UPDATE ap_connections SET scopes=$2 WHERE id=$1", [
      claude.id,
      claude.scopes,
    ]);
    // Disabling an app blocks it at once.
    await asOwner("apps/echo", "PATCH", { disabled: true });
    expect(
      (await (await asCodex("invoke", "POST", say)).json()).error.code,
    ).toBe("NOT_AVAILABLE");
    await asOwner("apps/echo", "PATCH", { disabled: false });
    const listed = await (await asOwner("apps")).json();
    expect(listed.apps[0]).toMatchObject({
      id: "echo",
      active_release: "0.4.0",
    });
    expect(listed.recent.length).toBeGreaterThan(0);
  });

  it("binds delegated tokens to one app, call and argument set", async () => {
    const keys = await (
      await jwksGet(new Request(`${ORIGIN}/x`), {
        params: Promise.resolve({ tenant: INITIAL_TENANT }),
      })
    ).json();
    expect(keys.keys[0]).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
    });
    expect(keys.keys[0]).not.toHaveProperty("d");
    // A token minted for another audience is rejected by the app.
    const forged = await new SignJWT({ operation: "echo.say" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("astropath-app:echo")
      .setIssuer(ORIGIN)
      .sign(new TextEncoder().encode("x".repeat(32)));
    const response = await echo.handle(
      new Request(`${ECHO}/ops/say/v1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${forged}` },
        body: JSON.stringify({ text: "x" }),
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("the change feed", () => {
  it("returns topics, replies and settled memories once, in readable spaces", async () => {
    const start = await (await asCodex("changes")).json();
    expect(start.cursor).toMatch(/^e\d+\.m\d+$/);
    await directory.query(
      "INSERT INTO ap_spaces(tenant_id,slug,name) VALUES($1,'private','Private') ON CONFLICT DO NOTHING",
      [INITIAL_TENANT],
    );
    const topic = await (
      await asCodex("board/topics", "POST", {
        title: "Feed topic",
        body: "Indexed body.",
      })
    ).json();
    await asCodex(`board/topics/${topic.topic.id}/replies`, "POST", {
      body: "A reply.",
    });
    await asOwner("board/topics", "POST", {
      title: "Private topic",
      body: "Not for Codex.",
      space: "private",
    });
    const remembered = await (
      await asCodex("invoke", "POST", {
        operation: "core.remember",
        version: "1.0.0",
        arguments: { body: "Feed memory.", session_key: "client:feed-1" },
        idempotency_key: "feed-mem-1",
      })
    ).json();
    expect(remembered.status).toBe("succeeded");
    // Unsettled memories wait; settled ones appear.
    const early = await (await asCodex(`changes?after=${start.cursor}`)).json();
    expect(early.changes.map((c: { kind: string }) => c.kind)).toEqual([
      "topic",
      "reply",
    ]);
    // Memories are immutable; skip the trigger only to age them in the test.
    await engine.exec(`SET session_replication_role = replica;
      UPDATE ap_memories SET created_at=created_at - interval '1 minute';
      SET session_replication_role = origin;`);
    const feed = await (await asCodex(`changes?after=${start.cursor}`)).json();
    const kinds = feed.changes.map(
      (c: { kind: string; title?: string; body: string }) => [
        c.kind,
        c.title ?? c.body,
      ],
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        ["topic", "Feed topic"],
        ["reply", "Feed topic"],
        ["memory", "Feed memory."],
      ]),
    );
    expect(JSON.stringify(feed)).not.toContain("Not for Codex");
    const reply = feed.changes.find(
      (c: { kind: string }) => c.kind === "reply",
    );
    expect(reply).toMatchObject({
      body: "A reply.",
      thread_id: topic.topic.id,
    });
    const after = await (await asCodex(`changes?after=${feed.cursor}`)).json();
    expect(after.changes).toEqual([]);
    expect(after.cursor).toBe(feed.cursor);
    // The owner sees every space; the same feed is a core operation.
    const owner = await (await asOwner(`changes?after=${start.cursor}`)).json();
    expect(JSON.stringify(owner)).toContain("Not for Codex");
    const viaInvoke = await (
      await asCodex("invoke", "POST", {
        operation: "core.changes",
        version: "1.0.0",
        arguments: { after: start.cursor, limit: 1 },
      })
    ).json();
    expect(viaInvoke.result.has_more).toBe(true);
    expect(viaInvoke.result.changes.length).toBeLessThanOrEqual(2);
    expect((await asCodex("changes?after=bogus")).status).toBe(400);
  });
});

describe("execute", () => {
  const run = async (body: Record<string, unknown>, as = asCodex) => {
    const response = await as("execute", "POST", body);
    return { status: response.status, body: await response.json() };
  };
  const read = (
    code: string,
    operations = [{ operation: "core.recall", version: "1.0.0" }],
  ) => run({ operations, code });

  it("composes operations and returns a result with its call ledger", async () => {
    const { body } = await run({
      operations: [
        { operation: "core.recall", version: "1.0.0" },
        { operation: "echo.say", version: "1.0.0" },
      ],
      code: `async () => {
        const said = await api.echo.say({ text: "composed" });
        const found = await api.core.recall({ q: "Platform test" });
        console.log("found", found.memories.length);
        return { said: said.text, caller: said.caller, memories: found.memories.length };
      }`,
    });
    expect(body).toMatchObject({
      status: "succeeded",
      result: { said: "composed", caller: "Codex", memories: 1 },
      logs: ["found 1"],
      effects: { has_committed_effects: false, has_unsettled_calls: false },
    });
    expect(body.calls.map((c: { operation: string }) => c.operation)).toEqual([
      "echo.say",
      "core.recall",
    ]);
    const fetched = await (
      await asCodex(`executions/${body.execution_id}`)
    ).json();
    expect(fetched).toMatchObject({ status: "succeeded", replayed: true });
    expect((await asClaude(`executions/${body.execution_id}`)).status).toBe(
      404,
    );
  });

  it("keeps read mode read-only and requires a key for writes", async () => {
    const remember = [{ operation: "core.remember", version: "1.0.0" }];
    expect((await read("async () => 1", remember)).body.error.message).toMatch(
      /mode "write"/,
    );
    expect(
      (
        await run({
          mode: "write",
          operations: remember,
          code: "async () => 1",
        })
      ).body.error.message,
    ).toMatch(/execution_key/);
  });

  it("reports partial effects, never re-runs a keyed execution, and conflicts on change", async () => {
    const program = {
      mode: "write",
      execution_key: "exec-partial-1",
      operations: [{ operation: "core.remember", version: "1.0.0" }],
      code: `async () => {
        await api.core.remember({ body: "Written by a program.", session_key: "client:exec-1" }, { idempotency_key: "exec-mem-1" });
        throw new Error("boom after the write");
      }`,
    };
    const first = (await run(program)).body;
    expect(first).toMatchObject({
      status: "failed",
      error: { code: "PROGRAM_ERROR", message: "Error: boom after the write" },
      effects: { has_committed_effects: true },
      calls: [
        {
          operation: "core.remember",
          status: "succeeded",
          effect_state: "committed",
        },
      ],
    });
    const again = (await run(program)).body;
    expect(again).toMatchObject({
      execution_id: first.execution_id,
      replayed: true,
      status: "failed",
    });
    const recalled = await (
      await asCodex("invoke", "POST", {
        operation: "core.recall",
        version: "1.0.0",
        arguments: { q: "Written by a program" },
      })
    ).json();
    expect(recalled.result.memories).toHaveLength(1);
    const changed = await run({
      ...program,
      code: program.code.replace("boom", "bang"),
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    // A write without its own idempotency key is rejected inside the program.
    const unkeyed = (
      await run({
        ...program,
        execution_key: "exec-unkeyed",
        code: `async () => { try { await api.core.remember({ body: "x", session_key: "client:exec-1" }); } catch (e) { return [e.name, e.code]; } }`,
      })
    ).body;
    expect(unkeyed.result).toEqual(["OperationError", "INVALID_ARGUMENTS"]);
  });

  it("holds its sandbox and budget boundaries", async () => {
    const escape =
      await read(`async () => [typeof process, typeof require, typeof fetch,
      typeof setTimeout, typeof globalThis.call, Object.getPrototypeOf(api), Object.isFrozen(api.core)]`);
    expect(escape.body.result).toEqual([
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      "undefined",
      null,
      true,
    ]);
    const cpu = await read("async () => { while (true) {} }");
    expect(cpu.body).toMatchObject({
      status: "timed_out",
      error: { code: "EXECUTION_LIMIT", effect_state: "none" },
    });
    expect(cpu.body.error.message).toMatch(/CPU/);
    const memory = await read(
      `async () => { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }`,
    );
    expect(memory.body.error.code).toBe("EXECUTION_LIMIT");
    expect(memory.body.error.message).toMatch(/memory/);
    const big = await read(`async () => "x".repeat(70000)`);
    expect(big.body.error.message).toMatch(/64 KiB/);
    const syntax = await read("async () => {");
    expect(syntax.body.error.code).toBe("INVALID_ARGUMENTS");
    const notFunction = await read("42");
    expect(notFunction.body.error.message).toMatch(/function expression/);
    const many = await read(`async () => {
      let failed = null;
      for (let i = 0; i < 51; i++) {
        try { await api.core.recall({ q: "x", limit: 1 }); } catch (e) { failed = [i, e.code]; }
      }
      return failed;
    }`);
    expect(many.body.result).toEqual([50, "EXECUTION_LIMIT"]);
    expect(many.body.calls).toHaveLength(50);
  }, 30000);

  it("tracks calls the program did not await", async () => {
    const { body } = await read(
      `async () => { api.core.recall({ q: "x" }); return "early"; }`,
    );
    expect(body).toMatchObject({ status: "succeeded", result: "early" });
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0].status).toBe("succeeded");
  });

  it("is available through the MCP execute tool", async () => {
    const client = new Client({ name: "execute-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens[0].token}` },
        },
        fetch: (input, init) => mcpPost(new Request(input, init)),
      }),
    );
    try {
      const result = await client.callTool({
        name: "execute",
        arguments: {
          operations: [{ operation: "core.list_agents", version: "1.0.0" }],
          code: "async () => (await api.core.list_agents({})).agents.length > 0",
        },
      });
      expect(result.structuredContent).toMatchObject({
        status: "succeeded",
        result: true,
      });
    } finally {
      await client.close();
    }
  });
});

describe("a large app catalog", () => {
  it("publishes, pages and disables far more than a couple of hundred operations", async () => {
    const many = Array.from({ length: 450 }, (_, n) => ({
      name: `echo.imported_${String(n).padStart(4, "0")}`,
      version: "1.0.0",
      summary: `Imported tool ${n}.`,
      group: n < 30 ? "alpha" : "beta",
      effect: "read",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" } },
        additionalProperties: false,
      },
      output_schema: { type: "object" },
      route: { path: "/ops/say/v1" },
    }));
    const release = {
      ...manifest("0.9.0", many),
      groups: [{ id: "alpha", name: "Alpha", description: "The first few." }],
    };
    expect(validateManifest(release, "echo").contracts).toHaveLength(452);
    startEcho("0.9.0");
    const published = await publish(publisherKey, { manifest: release });
    expect(published).toMatchObject({ status: 201, body: { operations: 452 } });

    // Discovery stays bounded: a page at a time, within one namespace.
    const page = await (
      await asCodex("discover", "POST", { namespace: "echo", limit: 20 })
    ).json();
    expect(page.results).toHaveLength(20);
    expect(page.next_cursor).toBeTruthy();
    expect(
      page.results.every((r: { operation: string }) =>
        r.operation.startsWith("echo."),
      ),
    ).toBe(true);
    const apps = await (await asCodex("discover", "POST", {})).json();
    expect(apps.catalog_revision).toBe(page.catalog_revision);
    expect(
      apps.apps.find((a: { app: string }) => a.app === "echo").operations,
    ).toBe(452);

    // Groups scope listing and search to one part of the app.
    const echoApp = apps.apps.find((a: { app: string }) => a.app === "echo");
    expect(echoApp.groups).toEqual([
      {
        namespace: "echo.alpha",
        name: "Alpha",
        description: "The first few.",
        operations: 30,
      },
      {
        namespace: "echo.beta",
        name: "beta",
        description: "",
        operations: 420,
      },
    ]);
    const names = async (body: object) =>
      (
        await (await asCodex("discover", "POST", { limit: 20, ...body })).json()
      ).results.map((r: { operation: string }) => r.operation);
    const alpha = await names({ namespace: "echo.alpha" });
    expect(alpha).toHaveLength(20);
    expect(alpha.every((name: string) => name < "echo.imported_0030")).toBe(
      true,
    );
    expect(await names({ namespace: "echo.alpha", query: "tool 7" })).toContain(
      "echo.imported_0007",
    );
    expect(
      await names({ namespace: "echo.beta", query: "imported_0007" }),
    ).not.toContain("echo.imported_0007");
    expect(await names({ namespace: "echo.nothing" })).toEqual([]);
    expect(await names({ namespace: "echo", query: "echo text" })).toContain(
      "echo.say",
    );
    const outside = await asCodex("discover", "POST", {
      namespace: "echo.beta",
      operation: "echo.imported_0007",
    });
    expect((await outside.json()).error.code).toBe("INVALID_ARGUMENTS");

    // More than 200 can be disabled, and the reused catalog notices at once.
    const disabled = many.slice(0, 300).map((op) => op.name);
    await asOwner("apps/echo", "PATCH", { disabled_operations: disabled });
    const after = await (await asCodex("discover", "POST", {})).json();
    expect(after.catalog_revision).not.toBe(page.catalog_revision);
    expect(
      after.apps.find((a: { app: string }) => a.app === "echo").operations,
    ).toBe(152);
    const gone = await asCodex("invoke", "POST", {
      operation: disabled[0],
      version: "1.0.0",
      arguments: {},
    });
    expect((await gone.json()).error.code).toBe("NOT_AVAILABLE");
    const kept = await (
      await asCodex("discover", "POST", { operation: many[400].name })
    ).json();
    expect(kept.results).toHaveLength(1);
  });
});
