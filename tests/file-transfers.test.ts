import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";
import type { Database, Queryable } from "../src/lib/db";
import type { Principal } from "../src/lib/policy";
import { migrateTenancy, INITIAL_TENANT } from "../src/lib/tenant-migration";
import {
  createUpload,
  completeUpload,
  downloadLink,
  transfer,
  uploadInline,
} from "../src/lib/file-transfers";
import { store } from "../src/lib/store";
import { GET, POST } from "../src/app/api/v1/[[...path]]/route";
import { newTenantKey } from "../src/lib/encryption";

const state = vi.hoisted(() => ({
  database: undefined as Database | undefined,
  objects: new Map<string, Buffer>(),
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
    api: { getSession: async () => ({ user: { id: "owner" } }) },
  }),
}));
vi.mock("../src/lib/storage", () => ({
  putFile: async (file: { pathname: string }, bytes: Uint8Array) => {
    if (state.objects.has(file.pathname)) throw new Error("Already exists");
    state.objects.set(file.pathname, Buffer.from(bytes));
  },
  readFileBytes: async (path: string) => state.objects.get(path) ?? null,
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
const database: Database = {
  ...adapter(engine),
  transaction: (fn) => engine.transaction((tx) => fn(adapter(tx))),
};
const writer: Principal = {
  id: randomUUID(),
  name: "Writer",
  owner: false,
  tenantId: INITIAL_TENANT,
  spaces: ["general"],
  scopes: ["astropath:read", "astropath:write"],
};
const reader: Principal = {
  ...writer,
  id: randomUUID(),
  name: "Reader",
  scopes: ["astropath:read"],
};
beforeAll(async () => {
  state.database = database;
  vi.stubEnv("ASTROPATH_MASTER_KEY", Buffer.alloc(32, 5).toString("base64"));
  vi.stubEnv("OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("APP_URL", "https://files.example.com");
  await engine.exec(
    `CREATE TABLE "user"(id text PRIMARY KEY,name text,email text); INSERT INTO "user" VALUES('owner','Owner','owner@example.com')`,
  );
  await engine.exec(
    await readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8"),
  );
  await database.transaction(migrateTenancy);
  for (const principal of [writer, reader])
    await database.query(
      `INSERT INTO ap_connections(id,tenant_id,name,kind,scopes,spaces,created_by_user_id)
    VALUES($1,$2,$3,'token',$4,$5,'owner')`,
      [
        principal.id,
        INITIAL_TENANT,
        principal.name,
        principal.scopes,
        principal.spaces,
      ],
    );
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await engine.close();
});

it("proxies original bytes through encrypted storage and rechecks transfer permissions", async () => {
  const bytes = Buffer.from("private original file bytes");
  const upload = await createUpload(writer, {
    name: "private-note.txt",
    content_type: "text/plain",
    size: bytes.length,
  });
  expect(upload.upload_url).toMatch(
    /^https:\/\/files.example.com\/api\/transfers\//,
  );
  await expect(completeUpload(writer, upload.file_id)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    transfer(
      new Request(upload.upload_url, {
        method: "PUT",
        headers: upload.headers,
        body: "too much data".repeat(20),
      }),
      upload.file_id,
    ),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    transfer(
      new Request(upload.upload_url, {
        method: "PUT",
        headers: upload.headers,
        body: bytes,
      }),
      randomUUID(),
    ),
  ).rejects.toMatchObject({ status: 401 });
  expect(
    (
      await transfer(
        new Request(upload.upload_url, {
          method: "PUT",
          headers: upload.headers,
          body: bytes,
        }),
        upload.file_id,
      )
    ).status,
  ).toBe(200);
  expect(await completeUpload(writer, upload.file_id)).toMatchObject({
    status: "ready",
  });
  const raw = (
    await database.query("SELECT * FROM ap_files WHERE id=$1", [upload.file_id])
  ).rows[0];
  expect(JSON.stringify(raw)).not.toContain("private-note.txt");
  expect(state.objects.get(String(raw.pathname))!.includes(bytes)).toBe(false);
  await expect(downloadLink(reader, upload.file_id)).rejects.toMatchObject({
    status: 404,
  });
  await store.create(writer, {
    title: "Attachment",
    attachment_ids: [upload.file_id],
  });
  const link = await downloadLink(reader, upload.file_id);
  expect(link.name).toBe("private-note.txt");
  const downloaded = await transfer(new Request(link.url), upload.file_id);
  expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
  expect(downloaded.headers.get("cache-control")).toContain("no-store");
  await database.query(
    "UPDATE ap_connections SET revoked_at=now() WHERE id=$1",
    [reader.id],
  );
  await expect(
    transfer(new Request(link.url), upload.file_id),
  ).rejects.toMatchObject({ code: "access_revoked" });
});
it("encrypts inline binary bytes and rejects read-only uploads", async () => {
  const bytes = Buffer.from([0, 255, 16, 32]);
  const metadata = {
    name: "binary.bin",
    size: bytes.length,
    content_type: "application/octet-stream",
  };
  await expect(
    uploadInline(reader, metadata, bytes.toString("base64")),
  ).rejects.toMatchObject({ status: 403 });
  const file = await uploadInline(writer, metadata, bytes.toString("base64"));
  const link = await downloadLink(writer, file.file_id);
  expect(
    Buffer.from(
      await (await transfer(new Request(link.url), file.file_id)).arrayBuffer(),
    ),
  ).toEqual(bytes);
});

it("lets humans create and select tenants while keeping platform administration out of content", async () => {
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return (method === "GET" ? GET : POST)(
      new Request(`https://files.example.com/api/v1/${path}`, {
        method,
        headers: {
          Origin: "https://files.example.com",
          "Content-Type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
  }
  const created = await request("tenants", "POST", { name: "Personal two" });
  expect(created.status).toBe(201);
  const tenant = (await created.json()).tenant;
  const selected = await request("tenants/select", "POST", {
    tenant_id: tenant.id,
  });
  expect(selected.status).toBe(200);
  expect(selected.headers.get("set-cookie")).toContain("HttpOnly");
  const headers = { "X-Astropath-Tenant": tenant.id };
  const me = await (await request("me", "GET", undefined, headers)).json();
  expect(me.identity).toMatchObject({
    tenantId: tenant.id,
    owner: true,
    platformAdmin: true,
  });
  const token = await (
    await request(
      "connections",
      "POST",
      { name: "Private agent", scopes: ["astropath:read", "astropath:write"] },
      headers,
    )
  ).json();
  const pinned = await (
    await request("me", "GET", undefined, {
      Authorization: `Bearer ${token.token}`,
      "X-Astropath-Tenant": INITIAL_TENANT,
    })
  ).json();
  expect(pinned.identity).toMatchObject({ tenantId: tenant.id, owner: false });
  const foreign = randomUUID();
  await database.query(
    "INSERT INTO ap_tenants(id,name,wrapped_key) VALUES($1,'Foreign',$2)",
    [foreign, newTenantKey(foreign)],
  );
  expect(
    (
      await request("messages", "GET", undefined, {
        "X-Astropath-Tenant": foreign,
      })
    ).status,
  ).toBe(403);
  expect(
    (await request("tenants/select", "POST", { tenant_id: foreign })).status,
  ).toBe(403);
  const admin = await request("admin/tenants");
  expect(admin.status).toBe(200);
  const metadata = await admin.json();
  expect(
    metadata.tenants.some((item: { id: string }) => item.id === foreign),
  ).toBe(true);
  expect(JSON.stringify(metadata)).not.toContain("wrapped_key");
});
