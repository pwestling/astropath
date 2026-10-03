import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";
import { tenantDatabase, type Database, type Queryable } from "../src/lib/db";
import { migrateTenancy, INITIAL_TENANT } from "../src/lib/tenant-migration";
import { newTenantKey } from "../src/lib/encryption";
import { rotateTenantKeys, verifyTenantKeys } from "../src/lib/key-rotation";

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
const key = () => randomBytes(32).toString("base64");
const oldKey = key();
const newKey = key();
const second = randomUUID();
let memoryId = "";

async function readBack(tenant: string) {
  const db = await tenantDatabase(tenant, directory);
  const row = (
    await db.query<{ encrypted_content: string }>(
      "SELECT encrypted_content FROM ap_memories WHERE id=$1",
      [memoryId],
    )
  ).rows[0];
  return db.cipher!.decrypt<{ body: string }>(
    `memory:${memoryId}`,
    row.encrypted_content,
  ).body;
}

beforeAll(async () => {
  vi.stubEnv("ASTROPATH_MASTER_KEY", oldKey);
  vi.stubEnv("OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("APP_URL", "https://keys.example");
  await engine.exec(
    `CREATE TABLE "user"(id text PRIMARY KEY,name text,email text);`,
  );
  await engine.exec(
    await readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8"),
  );
  await directory.transaction(migrateTenancy);
  await directory.query(
    "INSERT INTO ap_tenants(id,name,wrapped_key) VALUES($1,'Other',$2)",
    [second, newTenantKey(second)],
  );
  // Content encrypted under a tenant key wrapped by the old master key.
  const db = await tenantDatabase(INITIAL_TENANT, directory);
  memoryId = randomUUID();
  await db.query(
    "INSERT INTO ap_memories(id,space,principal_id,encrypted_content,retry_key_hash,content_hash) VALUES($1,'general','p',$2,'r','c')",
    [
      memoryId,
      db.cipher!.encrypt(`memory:${memoryId}`, {
        body: "Secret note",
        author: {},
      }),
    ],
  );
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await engine.close();
});

it("refuses to run without a distinct previous key", async () => {
  await expect(
    directory.transaction((tx) => rotateTenantKeys(tx, false)),
  ).rejects.toThrow(/ASTROPATH_PREVIOUS_MASTER_KEY/);
  vi.stubEnv("ASTROPATH_PREVIOUS_MASTER_KEY", oldKey);
  await expect(
    directory.transaction((tx) => rotateTenantKeys(tx, false)),
  ).rejects.toThrow(/same key/);
});

it("keeps content readable through a rotation, and is repeatable", async () => {
  // Switch to the new key with the old one as previous: still readable.
  vi.stubEnv("ASTROPATH_MASTER_KEY", newKey);
  vi.stubEnv("ASTROPATH_PREVIOUS_MASTER_KEY", oldKey);
  expect(await readBack(INITIAL_TENANT)).toBe("Secret note");
  expect((await verifyTenantKeys(directory)).failing).toHaveLength(2);
  // Dry run changes nothing.
  const before = (
    await directory.query("SELECT wrapped_key FROM ap_tenants ORDER BY id")
  ).rows;
  expect(
    await directory.transaction((tx) => rotateTenantKeys(tx, false)),
  ).toEqual({ tenants: 2, rotated: 2, already: 0, applied: false });
  expect(
    (await directory.query("SELECT wrapped_key FROM ap_tenants ORDER BY id"))
      .rows,
  ).toEqual(before);
  // Apply, verify, and drop the previous key.
  expect(
    await directory.transaction((tx) => rotateTenantKeys(tx, true)),
  ).toEqual({ tenants: 2, rotated: 2, already: 0, applied: true });
  expect(await verifyTenantKeys(directory)).toEqual({
    tenants: 2,
    failing: [],
  });
  vi.stubEnv("ASTROPATH_PREVIOUS_MASTER_KEY", "");
  expect(await readBack(INITIAL_TENANT)).toBe("Secret note");
  // The old key alone no longer opens anything.
  vi.stubEnv("ASTROPATH_MASTER_KEY", oldKey);
  await expect(readBack(INITIAL_TENANT)).rejects.toThrow();
  // Re-running with both keys is a no-op.
  vi.stubEnv("ASTROPATH_MASTER_KEY", newKey);
  vi.stubEnv("ASTROPATH_PREVIOUS_MASTER_KEY", oldKey);
  expect(
    await directory.transaction((tx) => rotateTenantKeys(tx, true)),
  ).toEqual({ tenants: 2, rotated: 0, already: 2, applied: true });
});

it("changes nothing when a tenant key opens with neither key", async () => {
  vi.stubEnv("ASTROPATH_MASTER_KEY", key());
  vi.stubEnv("ASTROPATH_PREVIOUS_MASTER_KEY", key());
  const before = (
    await directory.query("SELECT wrapped_key FROM ap_tenants ORDER BY id")
  ).rows;
  await expect(
    directory.transaction((tx) => rotateTenantKeys(tx, true)),
  ).rejects.toThrow(/neither/);
  expect(
    (await directory.query("SELECT wrapped_key FROM ap_tenants ORDER BY id"))
      .rows,
  ).toEqual(before);
});
