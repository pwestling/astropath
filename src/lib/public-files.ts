import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { appUrl } from "./config";
import { AppError } from "./errors";
import { db, forPrincipal } from "./db";
import { requireScope, requireSpace, type Principal } from "./policy";
import { fileInput } from "./validation";

// A single PUT stays below R2's single-part limit and never buffers in the app.
export const MAX_PUBLIC_FILE_BYTES = 4 * 1024 ** 3;
export const publicUploadInput = fileInput.extend({
  name: fileInput.shape.name.refine(
    (name) => name !== "." && name !== "..",
    "Use a filename, not a path segment.",
  ),
  size: z.number().int().min(1).max(MAX_PUBLIC_FILE_BYTES),
});

function publicStorage() {
  const account = process.env.R2_PUBLIC_ACCOUNT_ID;
  const bucket = process.env.R2_PUBLIC_BUCKET;
  const origin = process.env.R2_PUBLIC_BASE_URL;
  const accessKeyId = process.env.R2_PUBLIC_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_PUBLIC_SECRET_ACCESS_KEY;
  if (!account || !bucket || !origin || !accessKeyId || !secretAccessKey)
    throw new AppError(
      503,
      "public_uploads_unavailable",
      "Public uploads are not configured.",
    );
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new AppError(
      503,
      "public_uploads_unavailable",
      "Public storage has an invalid download origin.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    url.origin === appUrl() ||
    (account === process.env.R2_ACCOUNT_ID && bucket === process.env.R2_BUCKET)
  )
    throw new AppError(
      503,
      "public_uploads_unavailable",
      "Public storage must use a separate bucket and HTTPS download origin.",
    );
  return { account, bucket, origin: url.origin, accessKeyId, secretAccessKey };
}

export function publicUploadStatus() {
  try {
    publicStorage();
    return { enabled: true, max_size: MAX_PUBLIC_FILE_BYTES };
  } catch {
    return { enabled: false, max_size: MAX_PUBLIC_FILE_BYTES };
  }
}

export async function createPublicUpload(principal: Principal, raw: unknown) {
  requireScope(principal, "astropath:write");
  const input = publicUploadInput.parse(raw);
  const space = input.space ?? principal.spaces?.[0] ?? "general";
  requireSpace(principal, space);
  const database = await forPrincipal(db, principal);
  if (
    !(await database.query("SELECT slug FROM ap_spaces WHERE slug=$1", [space]))
      .rows.length
  )
    throw new AppError(404, "not_found", "Space not found.");
  const config = publicStorage();
  // Neither caller-provided paths nor private file IDs can select the destination.
  const key = `uploads/${randomUUID()}/${input.name}`;
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(input.name).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
  const headers = {
    "Content-Type": input.content_type,
    "Content-Length": String(input.size),
    "Content-Disposition": disposition,
    "If-None-Match": "*",
  };
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.account}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  try {
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ContentType: input.content_type,
        ContentLength: input.size,
        ContentDisposition: disposition,
        IfNoneMatch: "*",
      }),
      {
        expiresIn: 3600,
        signableHeaders: new Set(
          Object.keys(headers).map((h) => h.toLowerCase()),
        ),
      },
    );
    return {
      upload_url: uploadUrl,
      method: "PUT" as const,
      headers,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      public_url: `${config.origin}/${key.split("/").map(encodeURIComponent).join("/")}`,
      name: input.name,
      size: input.size,
      visibility: "public" as const,
    };
  } finally {
    client.destroy();
  }
}
