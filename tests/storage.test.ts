import { afterEach, expect, it, vi } from "vitest";
import { r2Object, signedUpload, storageProvider } from "../src/lib/storage";

afterEach(() => vi.unstubAllEnvs());

it("rejects misspelled providers instead of silently sending files elsewhere", () => {
  vi.stubEnv("STORAGE_PROVIDER", "R2");
  expect(storageProvider).toThrow("STORAGE_PROVIDER");
});

it("keeps development R2 objects under their own prefix", () => {
  vi.stubEnv("R2_BUCKET", "private-test");
  expect(r2Object("attachments/123/photo.png")).toEqual({
    Bucket: "private-test",
    Key: "attachments/123/photo.png",
  });
  vi.stubEnv("R2_KEY_PREFIX", "astropath-dev/");
  expect(r2Object("attachments/123/photo.png")).toEqual({
    Bucket: "private-test",
    Key: "astropath-dev/attachments/123/photo.png",
  });
});

it("binds R2 upload permissions to the exact object, size, MIME type and no-overwrite condition", async () => {
  vi.stubEnv("STORAGE_PROVIDER", "r2");
  vi.stubEnv("R2_ACCOUNT_ID", "test-account");
  vi.stubEnv("R2_BUCKET", "private-test");
  vi.stubEnv("R2_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "test-secret-key");
  const signed = await signedUpload(
    {
      pathname: "attachments/123/photo with spaces.png",
      size: 42,
      contentType: "image/png",
    },
    Date.now() + 900_000,
  );
  const url = new URL(signed.url);
  expect(url.hostname).toBe(
    "private-test.test-account.r2.cloudflarestorage.com",
  );
  expect(decodeURIComponent(url.pathname)).toBe(
    "/attachments/123/photo with spaces.png",
  );
  const headers = url.searchParams.get("X-Amz-SignedHeaders")!.split(";");
  expect(headers).toEqual(
    expect.arrayContaining(["content-length", "content-type", "if-none-match"]),
  );
  expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(
    900,
  );
  expect(signed.headers).toEqual({
    "Content-Type": "image/png",
    "Content-Length": "42",
    "If-None-Match": "*",
  });
});
