import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";
import { tenantDatabase, type Database, type Queryable } from "../src/lib/db";
import { migrateTenancy, INITIAL_TENANT } from "../src/lib/tenant-migration";
import { newTenantKey } from "../src/lib/encryption";
import {
  createPublicUpload,
  importPublicObjects,
  listPublicFiles,
  publicObjects,
} from "../src/lib/public-files";
import type { Principal } from "../src/lib/policy";

const engine = new PGlite();
function adapter(client: Pick<PGlite, "query" | "exec">): Queryable {
  return {
    query: async <T extends QueryResultRow>(
      sql: string,
      values?: unknown[],
    ) => {
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
const database: Database = {
  forTenant: (id) => tenantDatabase(id, directory),
  query: async () => {
    throw new Error("Content queries require a tenant");
  },
  transaction: async () => {
    throw new Error("Content transactions require a tenant");
  },
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
const writer: Principal = {
  id: randomUUID(),
  name: "Codex",
  tenantId: INITIAL_TENANT,
  owner: false,
  spaces: ["general"],
  scopes: ["astropath:read", "astropath:write"],
};
const elsewhere: Principal = { ...writer, tenantId: second, name: "Other" };
const uploaded = new Map<string, number>();
const keyOf = (url: string) =>
  decodeURIComponent(new URL(url).pathname.slice(1));

beforeAll(async () => {
  vi.stubEnv("ASTROPATH_MASTER_KEY", randomBytes(32).toString("base64"));
  vi.stubEnv("APP_URL", "https://astropath.example");
  for (const [key, value] of Object.entries({
    R2_PUBLIC_ACCOUNT_ID: "test-account",
    R2_PUBLIC_BUCKET: "public-bucket",
    R2_PUBLIC_BASE_URL: "https://files.example",
    R2_PUBLIC_ACCESS_KEY_ID: "public-key",
    R2_PUBLIC_SECRET_ACCESS_KEY: "public-secret",
  }))
    vi.stubEnv(key, value);
  await engine.exec(
    `CREATE TABLE "user"(id text PRIMARY KEY,name text,email text);`,
  );
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
    "INSERT INTO ap_spaces(tenant_id,slug,name) VALUES($1,'general','General')",
    [second],
  );
  vi.spyOn(publicObjects, "head").mockImplementation(async (key) =>
    uploaded.has(key) ? { size: uploaded.get(key)! } : null,
  );
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  vi.unstubAllEnvs();
  await engine.close();
});

it("lists only uploads confirmed in the bucket, newest first, per workspace", async () => {
  const first = await createPublicUpload(writer, {
    name: "first.stl",
    content_type: "model/stl",
    size: 10,
  });
  const second = await createPublicUpload(writer, {
    name: "second.pdf",
    content_type: "application/pdf",
    size: 20,
  });
  const pending = await createPublicUpload(writer, {
    name: "pending.zip",
    content_type: "application/zip",
    size: 30,
  });
  uploaded.set(keyOf(first.public_url), 10);
  uploaded.set(keyOf(second.public_url), 20);
  const page = await listPublicFiles(writer, {}, database);
  expect(page.files.map((item) => item.name)).toEqual([
    "second.pdf",
    "first.stl",
  ]);
  expect(page.files[0]).toMatchObject({
    id: second.id,
    size: 20,
    content_type: "application/pdf",
    public_url: second.public_url,
    uploaded_by: "Codex",
  });
  // Another workspace sharing the bucket never sees these files.
  expect((await listPublicFiles(elsewhere, {}, database)).files).toEqual([]);
  // The pending upload appears once its PUT lands.
  uploaded.set(keyOf(pending.public_url), 30);
  expect(
    (await listPublicFiles(writer, {}, database)).files.map((f) => f.name),
  ).toEqual(["pending.zip", "second.pdf", "first.stl"]);
  const raw = await directory.query("SELECT * FROM ap_public_files");
  expect(JSON.stringify(raw.rows)).not.toContain("second.pdf");
});

it("retires uploads whose ticket expired without an object and pages results", async () => {
  const abandoned = await createPublicUpload(writer, {
    name: "never-uploaded.bin",
    content_type: "application/octet-stream",
    size: 5,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * 3600_000);
  await listPublicFiles(writer, {}, database);
  const row = await directory.query<{ abandoned_at: string | null }>(
    "SELECT abandoned_at FROM ap_public_files WHERE id=$1",
    [abandoned.id],
  );
  expect(row.rows[0].abandoned_at).not.toBeNull();
  vi.useRealTimers();
  const head = vi.mocked(publicObjects.head);
  head.mockClear();
  const first = await listPublicFiles(writer, { limit: 2 }, database);
  expect(first.files).toHaveLength(2);
  expect(first.next_before).not.toBeNull();
  const rest = await listPublicFiles(
    writer,
    { limit: 2, before: first.next_before! },
    database,
  );
  expect(rest.files.map((item) => item.name)).toEqual(["first.stl"]);
  // Confirmed and retired rows are not checked against the bucket again.
  expect(head).not.toHaveBeenCalled();
  await expect(
    listPublicFiles({ ...writer, scopes: [] }, {}, database),
  ).rejects.toMatchObject({ code: "insufficient_scope" });
});

it("keeps an upload pending when the bucket cannot be reached", async () => {
  const flaky = await createPublicUpload(writer, {
    name: "flaky.txt",
    content_type: "text/plain",
    size: 7,
  });
  uploaded.set(keyOf(flaky.public_url), 7);
  const head = vi.mocked(publicObjects.head);
  head.mockRejectedValueOnce(new Error("network down"));
  const names = async () =>
    (await listPublicFiles(writer, {}, database)).files.map((f) => f.name);
  expect(await names()).not.toContain("flaky.txt");
  expect(await names()).toContain("flaky.txt");
});

it("imports earlier bucket objects once into the chosen space", async () => {
  const known = (
    await listPublicFiles(writer, { limit: 100 }, database)
  ).files.find((f) => f.name === "first.stl")!;
  const list = vi.spyOn(publicObjects, "list").mockResolvedValue([
    {
      key: keyOf(known.public_url),
      size: 10,
      modified: new Date("2026-09-01T00:00:00Z"),
      content_type: "model/stl",
    },
    {
      key: "uploads/0b9f1b8e-2f39-4d43-9d8a-0f3c1f1f6a11/legacy 100%.pdf",
      size: 42,
      modified: new Date("2026-09-15T12:00:00Z"),
      content_type: "application/pdf",
    },
  ]);
  const tenant = await tenantDatabase(INITIAL_TENANT, directory);
  expect(
    await tenant.transaction((tx) => importPublicObjects(tx, "general")),
  ).toBe(1);
  expect(
    await tenant.transaction((tx) => importPublicObjects(tx, "general")),
  ).toBe(0);
  list.mockRestore();
  const legacy = (
    await listPublicFiles(writer, { limit: 100 }, database)
  ).files.find((f) => f.name === "legacy 100%.pdf");
  expect(legacy).toMatchObject({
    size: 42,
    content_type: "application/pdf",
    uploaded_by: "Imported",
    public_url:
      "https://files.example/uploads/0b9f1b8e-2f39-4d43-9d8a-0f3c1f1f6a11/legacy%20100%25.pdf",
  });
  expect(new Date(legacy!.created_at).toISOString()).toBe(
    "2026-09-15T12:00:00.000Z",
  );
  expect(
    (await listPublicFiles(elsewhere, {}, database)).files.map((f) => f.name),
  ).not.toContain("legacy 100%.pdf");
});
