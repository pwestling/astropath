import { randomUUID, createHmac } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { putFile, readFileBytes } from "./storage";
import { db as rootDb, forPrincipal, systemDb } from "./db";
import { AppError } from "./errors";
import { appUrl, MAX_INLINE_BYTES } from "./config";
import { masterKey } from "./encryption";
import { userPrincipal, connectionSpaces } from "./access";
import { requireScope, requireSpace, type Principal } from "./policy";
import { rateLimit } from "./security";
import { fileInput } from "./validation";
import { store, decodeFile, type Attachment } from "./store";

function transferKey() {
  return createHmac("sha256", masterKey())
    .update("astropath-file-transfer-v1")
    .digest();
}
async function transferLink(
  principal: Principal,
  id: string,
  operation: "upload" | "download",
) {
  const seconds = operation === "upload" ? 900 : 300;
  const token = await new SignJWT({
    tenant: principal.tenantId,
    file: id,
    operation,
    user: principal.userId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("astropath")
    .setAudience("file-transfer")
    .setSubject(principal.id)
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .sign(transferKey());
  return {
    url: `${appUrl()}/api/transfers/${id}?token=${token}`,
    expires_at: new Date(Date.now() + seconds * 1000).toISOString(),
  };
}
async function reserve(principal: Principal, raw: unknown) {
  requireScope(principal, "astropath:write");
  const input = fileInput.parse(raw);
  input.space ??= principal.spaces?.[0] || "general";
  requireSpace(principal, input.space);
  const db = await forPrincipal(rootDb, principal);
  if (
    !(await db.query("SELECT slug FROM ap_spaces WHERE slug=$1", [input.space]))
      .rows.length
  )
    throw new AppError(404, "not_found", "Space not found.");
  const id = randomUUID();
  const pathname = `encrypted/${principal.tenantId}/${id}`;
  await db.query(
    `INSERT INTO ap_files(id,space,name,content_type,size,pathname,principal_id,encrypted_metadata,encrypted)
    VALUES($1,$2,'','application/octet-stream',$3,$4,$5,$6,true)`,
    [
      id,
      input.space,
      input.size,
      pathname,
      principal.id,
      db.cipher!.encrypt(`file-metadata:${id}`, {
        name: input.name,
        content_type: input.content_type,
      }),
    ],
  );
  return { id, pathname, ...input };
}
export async function createUpload(principal: Principal, raw: unknown) {
  const file = await reserve(principal, raw);
  const link = await transferLink(principal, file.id, "upload");
  return {
    file_id: file.id,
    upload_url: link.url,
    method: "PUT",
    headers: { "Content-Type": file.content_type },
    expires_at: link.expires_at,
    complete_url: `/api/v1/files/${file.id}/complete`,
  };
}
export async function completeUpload(principal: Principal, id: string) {
  requireScope(principal, "astropath:write");
  const db = await forPrincipal(rootDb, principal);
  const file = (
    await db.query<Attachment>(
      "SELECT * FROM ap_files WHERE id=$1 AND principal_id=$2",
      [id, principal.id],
    )
  ).rows[0];
  if (!file) throw new AppError(404, "not_found", "Upload not found.");
  requireSpace(principal, file.space);
  if (!file.encrypted || file.status !== "ready")
    throw new AppError(
      409,
      "upload_incomplete",
      "Upload the file through Astropath before completing it.",
    );
  return { file_id: id, status: "ready" };
}
async function saveBytes(principal: Principal, id: string, bytes: Buffer) {
  requireScope(principal, "astropath:write");
  const db = await forPrincipal(rootDb, principal);
  return db.transaction(async (tx) => {
    const file = (
      await tx.query<Attachment>(
        "SELECT * FROM ap_files WHERE id=$1 AND principal_id=$2 FOR UPDATE",
        [id, principal.id],
      )
    ).rows[0];
    if (!file) throw new AppError(404, "not_found", "Upload not found.");
    requireSpace(principal, file.space);
    if (Number(file.size) !== bytes.length)
      throw new AppError(
        400,
        "size_mismatch",
        "The uploaded bytes do not match the reserved size.",
      );
    if (file.status === "ready")
      throw new AppError(
        409,
        "upload_exists",
        "This upload is already complete.",
      );
    const encrypted = tx.cipher!.encryptBytes(`file:${id}`, bytes);
    // A retry after DB failure verifies the create-only object before marking ready.
    try {
      await putFile(
        {
          pathname: file.pathname,
          size: encrypted.length,
          contentType: "application/octet-stream",
        },
        encrypted,
      );
    } catch (error) {
      const existing = await readFileBytes(file.pathname);
      if (
        !existing ||
        !tx.cipher!.decryptBytes(`file:${id}`, existing).equals(bytes)
      )
        throw error;
    }
    await tx.query(
      "UPDATE ap_files SET status='ready',ready_at=now(),encrypted=true WHERE id=$1",
      [id],
    );
    return { file_id: id, status: "ready" };
  });
}
export async function uploadInline(
  principal: Principal,
  metadata: unknown,
  content: string,
) {
  if (
    !content ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      content,
    )
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
      "JSON uploads are limited to 2 MiB; use an upload URL.",
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
  return saveBytes(principal, file.id, bytes);
}
export async function downloadLink(principal: Principal, id: string) {
  const file = await store.file(principal, id);
  if (file.status !== "ready")
    throw new AppError(409, "upload_incomplete", "This upload is not ready.");
  return {
    ...(await transferLink(principal, id, "download")),
    name: file.name,
    content_type: file.content_type,
    size: Number(file.size),
  };
}
async function decryptedBytes(principal: Principal, file: Attachment) {
  if (!file.encrypted)
    throw new AppError(
      503,
      "migration_required",
      "This file is awaiting encryption migration.",
    );
  const db = await forPrincipal(rootDb, principal);
  const stored = await readFileBytes(file.pathname);
  if (!stored) throw new AppError(404, "not_found", "File unavailable.");
  return db.cipher!.decryptBytes(`file:${file.id}`, stored);
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
  return {
    type: "image" as const,
    mimeType: file.content_type,
    data: (await decryptedBytes(principal, file)).toString("base64"),
  };
}
export async function transfer(request: Request, id: string) {
  z.uuid().parse(id);
  let claims;
  try {
    claims = (
      await jwtVerify(
        new URL(request.url).searchParams.get("token") || "",
        transferKey(),
        {
          algorithms: ["HS256"],
          issuer: "astropath",
          audience: "file-transfer",
        },
      )
    ).payload;
  } catch {
    throw new AppError(
      401,
      "invalid_transfer",
      "This transfer link is invalid or expired.",
    );
  }
  const operation = request.method === "PUT" ? "upload" : "download";
  if (
    claims.file !== id ||
    claims.operation !== operation ||
    typeof claims.tenant !== "string" ||
    !claims.sub
  )
    throw new AppError(401, "invalid_transfer", "Invalid transfer permission.");
  let principal: Principal | null;
  if (typeof claims.user === "string") {
    principal = await userPrincipal(systemDb, claims.user, claims.tenant);
    if (principal?.id !== claims.sub) principal = null;
  } else {
    const connection = (
      await systemDb.query<{
        id: string;
        name: string;
        scopes: string[];
        spaces: string[] | null;
        created_by_user_id: string;
      }>(
        "SELECT id,name,scopes,spaces,created_by_user_id FROM ap_connections WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
        [z.uuid().parse(claims.sub), claims.tenant],
      )
    ).rows[0];
    principal = connection
      ? {
          ...connection,
          tenantId: claims.tenant,
          owner: false,
          spaces: await connectionSpaces(
            systemDb,
            connection.spaces,
            connection.created_by_user_id,
            claims.tenant,
          ),
        }
      : null;
  }
  if (!principal)
    throw new AppError(
      403,
      "access_revoked",
      "Transfer access has been revoked.",
    );
  await rateLimit(principal);
  if (operation === "download") {
    const file = await store.file(principal, id);
    if (file.status !== "ready")
      throw new AppError(409, "upload_incomplete", "This upload is not ready.");
    return new Response(new Uint8Array(await decryptedBytes(principal, file)), {
      headers: {
        "Content-Type": file.content_type,
        "Content-Length": String(file.size),
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  requireScope(principal, "astropath:write");
  const db = await forPrincipal(rootDb, principal);
  const stored = (
    await db.query<Attachment>(
      "SELECT * FROM ap_files WHERE id=$1 AND principal_id=$2",
      [id, principal.id],
    )
  ).rows[0];
  if (!stored) throw new AppError(404, "not_found", "Upload not found.");
  requireSpace(principal, stored.space);
  const file = decodeFile(db, stored);
  if (request.headers.get("content-type") !== file.content_type)
    throw new AppError(
      400,
      "content_type_mismatch",
      "Use the reserved content type.",
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError(400, "missing_body", "File bytes are required.");
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > Number(file.size)) {
      await reader.cancel();
      throw new AppError(
        413,
        "file_too_large",
        "The upload exceeds its reserved size.",
      );
    }
    parts.push(value);
  }
  return Response.json(await saveBytes(principal, id, Buffer.concat(parts)), {
    headers: { "Cache-Control": "no-store" },
  });
}
