import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPublicUpload,
  MAX_PUBLIC_FILE_BYTES,
  publicUploadStatus,
} from "../src/lib/public-files";
import type { Principal } from "../src/lib/policy";

const state = vi.hoisted(() => ({
  tenants: [] as string[],
  spaces: new Set(["general"]),
}));
vi.mock("../src/lib/db", async (original) => {
  const actual = await original<typeof import("../src/lib/db")>();
  return {
    ...actual,
    db: {
      forTenant: async (tenant: string) => {
        state.tenants.push(tenant);
        return {
          query: async (_sql: string, values: string[]) => ({
            rows: state.spaces.has(values[0]) ? [{ slug: values[0] }] : [],
          }),
        };
      },
    },
  };
});
const writer: Principal = {
  id: "writer",
  name: "Writer",
  owner: false,
  tenantId: "00000000-0000-4000-8000-000000000001",
  scopes: ["astropath:read", "astropath:write"],
  spaces: ["general"],
};
const input = {
  name: "print résumé #1.stl",
  content_type: "application/octet-stream",
  size: 1234,
};
beforeEach(() => {
  state.tenants.length = 0;
  for (const [key, value] of Object.entries({
    APP_URL: "https://astropath.example",
    R2_ACCOUNT_ID: "test-account",
    R2_BUCKET: "private-bucket",
    R2_ACCESS_KEY_ID: "private-key",
    R2_SECRET_ACCESS_KEY: "private-secret",
    R2_PUBLIC_ACCOUNT_ID: "test-account",
    R2_PUBLIC_BUCKET: "public-bucket",
    R2_PUBLIC_BASE_URL: "https://files.example",
    R2_PUBLIC_ACCESS_KEY_ID: "public-key",
    R2_PUBLIC_SECRET_ACCESS_KEY: "public-secret",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

it("signs a separate public object with exact metadata and create-only upload permissions", async () => {
  const result = await createPublicUpload(writer, input);
  const upload = new URL(result.upload_url),
    download = new URL(result.public_url);
  expect(upload.hostname).toBe(
    "public-bucket.test-account.r2.cloudflarestorage.com",
  );
  expect(download.origin).toBe("https://files.example");
  expect(download.search).toBe("");
  expect(decodeURIComponent(upload.pathname)).toBe(
    decodeURIComponent(download.pathname),
  );
  expect(decodeURIComponent(download.pathname)).toMatch(
    /\/uploads\/[a-f0-9-]{36}\/print résumé #1.stl$/,
  );
  expect(download.href).not.toContain(writer.tenantId);
  expect(upload.searchParams.get("X-Amz-Credential")).toContain("public-key/");
  expect(upload.searchParams.get("X-Amz-Expires")).toBe("3600");
  expect(upload.searchParams.get("X-Amz-SignedHeaders")!.split(";")).toEqual(
    expect.arrayContaining([
      "content-length",
      "content-type",
      "content-disposition",
      "if-none-match",
    ]),
  );
  expect(result.headers["Content-Length"]).toBe("1234");
  expect(result.headers["If-None-Match"]).toBe("*");
  expect(result.headers["Content-Disposition"]).toMatch(
    /^attachment; filename\*=UTF-8''/,
  );
  expect(JSON.stringify(result)).not.toMatch(
    /private-key|private-secret|public-secret/,
  );
  expect(state.tenants).toEqual([writer.tenantId]);
  expect((await createPublicUpload(writer, input)).public_url).not.toBe(
    result.public_url,
  );
});

it("requires write scope, tenant identity, and an existing allowed space", async () => {
  await expect(
    createPublicUpload({ ...writer, scopes: ["astropath:read"] }, input),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    createPublicUpload({ ...writer, tenantId: undefined }, input),
  ).rejects.toMatchObject({ code: "tenant_required" });
  await expect(
    createPublicUpload(writer, { ...input, space: "other" }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    createPublicUpload(
      { ...writer, spaces: null },
      { ...input, space: "missing" },
    ),
  ).rejects.toMatchObject({ status: 404 });
});

it("fails closed on missing public credentials, a private bucket, or an unsafe URL", async () => {
  vi.stubEnv("R2_PUBLIC_SECRET_ACCESS_KEY", "");
  expect(publicUploadStatus().enabled).toBe(false);
  await expect(createPublicUpload(writer, input)).rejects.toMatchObject({
    status: 503,
  });
  vi.stubEnv("R2_PUBLIC_SECRET_ACCESS_KEY", "public-secret");
  vi.stubEnv("R2_PUBLIC_BUCKET", "private-bucket");
  await expect(createPublicUpload(writer, input)).rejects.toMatchObject({
    status: 503,
  });
  vi.stubEnv("R2_PUBLIC_BUCKET", "public-bucket");
  for (const url of [
    "invalid",
    "http://files.example",
    "https://user:pass@files.example",
    "https://files.example/path",
    "https://files.example/?token=secret",
    "https://files.example/#hash",
    "https://astropath.example",
  ]) {
    vi.stubEnv("R2_PUBLIC_BASE_URL", url);
    await expect(createPublicUpload(writer, input)).rejects.toMatchObject({
      status: 503,
    });
  }
});

it("accepts large direct uploads but rejects invalid paths, sizes and destination overrides", async () => {
  expect(
    (
      await createPublicUpload(writer, {
        ...input,
        size: MAX_PUBLIC_FILE_BYTES,
      })
    ).size,
  ).toBe(MAX_PUBLIC_FILE_BYTES);
  for (const change of [
    { name: ".." },
    { name: "." },
    { name: "../private" },
    { name: "x\r\ny" },
    { size: 0 },
    { size: MAX_PUBLIC_FILE_BYTES + 1 },
    { bucket: "private-bucket" },
    { pathname: "private-object" },
    { file_id: "existing-private-file" },
  ])
    await expect(
      createPublicUpload(writer, { ...input, ...change }),
    ).rejects.toThrow();
});
