import { randomUUID } from "node:crypto";
import {
  signedUpload,
  headFile,
  putFile,
  signedDownload,
  readFileBytes,
} from "./storage";
import { db } from "./db";
import { AppError } from "./errors";
import { MAX_INLINE_BYTES } from "./config";
import { requireScope, requireSpace, type Principal } from "./security";
import { fileInput } from "./validation";
import { store, type Attachment } from "./store";

async function reserve(principal: Principal, raw: unknown) {
  requireScope(principal, "astropath:write");
  const input = fileInput.parse(raw);
  input.space ??= principal.spaces?.[0] || "general";
  requireSpace(principal, input.space);
  const spaces = await db.query("SELECT slug FROM ap_spaces WHERE slug=$1", [
    input.space,
  ]);
  if (!spaces.rows.length)
    throw new AppError(404, "not_found", "Space not found.");
  const id = randomUUID();
  const pathname = `attachments/${id}/${input.name}`;
  await db.query(
    `INSERT INTO ap_files(id,space,name,content_type,size,pathname,principal_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      input.space,
      input.name,
      input.content_type,
      input.size,
      pathname,
      principal.id,
    ],
  );
  return { id, pathname, ...input };
}

export async function createUpload(principal: Principal, raw: unknown) {
  const file = await reserve(principal, raw);
  const validUntil = Date.now() + 15 * 60 * 1000;
  const upload = await signedUpload(
    {
      pathname: file.pathname,
      size: file.size,
      contentType: file.content_type,
    },
    validUntil,
  );
  return {
    file_id: file.id,
    upload_url: upload.url,
    method: "PUT",
    headers: upload.headers,
    expires_at: new Date(validUntil).toISOString(),
    complete_url: `/api/v1/files/${file.id}/complete`,
  };
}

export async function completeUpload(principal: Principal, id: string) {
  requireScope(principal, "astropath:write");
  const result = await db.query<Attachment>(
    "SELECT * FROM ap_files WHERE id=$1 AND principal_id=$2",
    [id, principal.id],
  );
  const file = result.rows[0];
  if (!file) throw new AppError(404, "not_found", "Upload not found.");
  requireSpace(principal, file.space);
  if (file.status === "ready") return { file_id: id, status: "ready" };
  let blob;
  try {
    blob = await headFile(file.pathname);
  } catch {
    throw new AppError(
      409,
      "upload_incomplete",
      "Upload the file before completing it.",
    );
  }
  if (
    blob.pathname !== file.pathname ||
    blob.size !== Number(file.size) ||
    blob.contentType !== file.content_type
  ) {
    throw new AppError(
      409,
      "upload_mismatch",
      "The uploaded file does not match its reserved size and content type.",
    );
  }
  await db.query(
    "UPDATE ap_files SET status='ready',ready_at=now() WHERE id=$1",
    [id],
  );
  return { file_id: id, status: "ready" };
}

export async function uploadInline(
  principal: Principal,
  metadata: unknown,
  content: string,
) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      content,
    ) ||
    !content
  )
    throw new AppError(
      400,
      "invalid_base64",
      "Provide standard base64-encoded file bytes.",
    );
  if (content.length > Math.ceil(MAX_INLINE_BYTES / 3) * 4)
    throw new AppError(
      413,
      "file_too_large",
      "JSON uploads are limited to 2 MiB; use a direct upload URL.",
    );
  const bytes = Buffer.from(content, "base64");
  const input = fileInput.parse(metadata);
  if (input.size !== bytes.length)
    throw new AppError(
      400,
      "size_mismatch",
      "The declared size does not match the file bytes.",
    );
  const file = await reserve(principal, input);
  await putFile(
    {
      pathname: file.pathname,
      size: file.size,
      contentType: file.content_type,
    },
    bytes,
  );
  return completeUpload(principal, file.id);
}

export async function downloadLink(principal: Principal, id: string) {
  const file = await store.file(principal, id);
  if (file.status !== "ready")
    throw new AppError(409, "upload_incomplete", "This upload is not ready.");
  const validUntil = Date.now() + 5 * 60 * 1000;
  const url = await signedDownload(file.pathname, validUntil);
  return {
    url,
    name: file.name,
    content_type: file.content_type,
    size: Number(file.size),
    expires_at: new Date(validUntil).toISOString(),
  };
}

export async function imageContent(principal: Principal, id: string) {
  const file = await store.file(principal, id);
  if (
    file.status !== "ready" ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      file.content_type,
    )
  )
    throw new AppError(
      400,
      "not_image",
      "Use this tool for a ready PNG, JPEG, WebP, or GIF.",
    );
  if (Number(file.size) > MAX_INLINE_BYTES)
    throw new AppError(
      413,
      "image_too_large",
      "Use a download link for images larger than 2 MiB.",
    );
  const buffer = await readFileBytes(file.pathname);
  if (!buffer) throw new AppError(404, "not_found", "Image unavailable.");
  return {
    type: "image" as const,
    mimeType: file.content_type,
    data: Buffer.from(buffer).toString("base64"),
  };
}
