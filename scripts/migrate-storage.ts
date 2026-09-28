import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { get, head } from "@vercel/blob";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { pool } from "../src/lib/db";
import { r2Client, r2Object, missingObject } from "../src/lib/storage";

// Copy, never delete or modify metadata. Safe to rerun during/after cutover.
// The legacy Blob read fallback covers uploads finishing during DNS propagation.
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function main() {
  assert.ok(process.env.BLOB_READ_WRITE_TOKEN, "Source Blob token required");
  const files = await pool.query<{
    pathname: string;
    size: string;
    content_type: string;
    status: string;
  }>(
    "SELECT pathname,size,content_type,status FROM ap_files ORDER BY created_at",
  );
  let copied = 0,
    verified = 0,
    pending = 0,
    destinationOnly = 0;
  for (const file of files.rows) {
    let source: Awaited<ReturnType<typeof get>> | undefined;
    try {
      source = await get(file.pathname, { access: "private", useCache: false });
    } catch (error) {
      // Do not mistake permission/network errors for an abandoned upload.
      if (!(error instanceof Error) || error.name !== "BlobNotFoundError")
        throw error;
    }
    if (!source) {
      // After cutover, new files legitimately exist only in R2.
      try {
        const result = await r2Client().send(
          new GetObjectCommand(r2Object(file.pathname)),
        );
        const bytes = await result.Body?.transformToByteArray();
        assert.ok(bytes);
        assert.equal(bytes.length, Number(file.size));
        assert.equal(result.ContentType, file.content_type);
        destinationOnly++;
      } catch (error) {
        if (!missingObject(error)) throw error;
        assert.equal(
          file.status,
          "pending",
          "A ready file is missing from both stores",
        );
        pending++;
      }
      continue;
    }
    assert.equal(source.statusCode, 200);
    assert.ok(source.stream);
    const bytes = Buffer.from(await new Response(source.stream).arrayBuffer());
    const meta = await head(file.pathname);
    assert.equal(bytes.length, Number(file.size), "Source size mismatch");
    assert.equal(meta.contentType, file.content_type, "Source MIME mismatch");
    let existing: Uint8Array | undefined;
    try {
      const result = await r2Client().send(
        new GetObjectCommand(r2Object(file.pathname)),
      );
      existing = await result.Body?.transformToByteArray();
      assert.equal(result.ContentType, file.content_type);
    } catch (error) {
      if (!missingObject(error)) throw error;
    }
    if (!existing) {
      await r2Client().send(
        new PutObjectCommand({
          ...r2Object(file.pathname),
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: file.content_type,
          IfNoneMatch: "*",
        }),
      );
      copied++;
      const result = await r2Client().send(
        new GetObjectCommand(r2Object(file.pathname)),
      );
      existing = await result.Body?.transformToByteArray();
      assert.equal(result.ContentType, file.content_type);
    }
    assert.ok(existing);
    assert.equal(
      digest(existing),
      digest(bytes),
      "Destination bytes differ from source",
    );
    verified++;
  }
  console.log({
    files: files.rowCount,
    copied,
    verified,
    pendingWithoutObject: pending,
    destinationOnly,
  });
}
main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Migration failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
