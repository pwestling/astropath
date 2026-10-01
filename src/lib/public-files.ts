import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { appUrl } from "./config";
import { AppError } from "./errors";
import { db, forPrincipal, type Database, type Queryable } from "./db";
import { requireScope, requireSpace, type Principal } from "./policy";
import { fileInput, spaceSlug } from "./validation";

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

export const listPublicFilesInput = z
  .object({
    space: spaceSlug.optional(),
    before: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();

type PublicConfig = ReturnType<typeof publicStorage>;
function publicClient(config: PublicConfig) {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.account}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}
function publicUrl(config: PublicConfig, key: string) {
  return `${config.origin}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// Direct uploads bypass the app, so a listing confirms pending uploads against
// the bucket. Replaceable so tests need no network.
export const publicObjects = {
  async head(key: string): Promise<{ size: number } | null> {
    const config = publicStorage();
    const client = publicClient(config);
    try {
      const head = await client.send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      return { size: Number(head.ContentLength ?? 0) };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    } finally {
      client.destroy();
    }
  },
};

interface PublicFileMetadata {
  key: string;
  name: string;
  content_type: string;
  public_url: string;
  uploaded_by: string;
}
interface PublicFileRow {
  id: string;
  sequence: string;
  space: string;
  size: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
  encrypted_metadata: string;
}
export interface PublicFile {
  id: string;
  sequence: string;
  space: string;
  name: string;
  content_type: string;
  size: number;
  public_url: string;
  uploaded_by: string;
  created_at: string;
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
  const client = publicClient(config);
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
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const url = publicUrl(config, key);
    // Recorded before the client uploads; listings confirm it in the bucket.
    await database.query(
      `INSERT INTO ap_public_files(id,space,key_hash,encrypted_metadata,size,created_by,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        id,
        space,
        database.cipher!.fingerprint("public-file-key", key),
        database.cipher!.encrypt(`public-file:${id}`, {
          key,
          name: input.name,
          content_type: input.content_type,
          public_url: url,
          uploaded_by: principal.name,
        } satisfies PublicFileMetadata),
        input.size,
        principal.id,
        expiresAt,
      ],
    );
    return {
      id,
      upload_url: uploadUrl,
      method: "PUT" as const,
      headers,
      expires_at: expiresAt,
      public_url: url,
      name: input.name,
      size: input.size,
      visibility: "public" as const,
    };
  } finally {
    client.destroy();
  }
}

export async function listPublicFiles(
  principal: Principal,
  raw: unknown,
  database: Database = db,
) {
  requireScope(principal, "astropath:read");
  const input = listPublicFilesInput.parse(raw);
  if (input.space) requireSpace(principal, input.space);
  const scoped = await forPrincipal(database, principal);
  const files: PublicFile[] = [];
  let before = input.before;
  // Pending rows are confirmed (or retired once their ticket has expired) as
  // they are listed, so a page may need more than one batch.
  while (files.length <= input.limit) {
    const rows = (
      await scoped.query<PublicFileRow>(
        `SELECT f.*,f.sequence::text AS sequence,f.size::text AS size FROM ap_public_files f
        WHERE ($1::text[] IS NULL OR f.space=ANY($1)) AND ($2::text IS NULL OR f.space=$2)
        AND f.abandoned_at IS NULL AND ($3::bigint IS NULL OR f.sequence<$3)
        ORDER BY f.sequence DESC LIMIT 100`,
        [principal.spaces, input.space ?? null, before ?? null],
      )
    ).rows;
    for (const row of rows) {
      const meta = scoped.cipher!.decrypt<PublicFileMetadata>(
        `public-file:${row.id}`,
        row.encrypted_metadata,
      );
      if (!row.completed_at) {
        let found: { size: number } | null;
        try {
          found = await publicObjects.head(meta.key);
        } catch {
          // Storage is unreachable: leave it pending and check next time.
          continue;
        }
        if (found && found.size === Number(row.size))
          await scoped.query(
            "UPDATE ap_public_files SET completed_at=now() WHERE id=$1",
            [row.id],
          );
        else {
          if (new Date(row.expires_at) < new Date())
            await scoped.query(
              "UPDATE ap_public_files SET abandoned_at=now() WHERE id=$1",
              [row.id],
            );
          continue;
        }
      }
      files.push({
        id: row.id,
        sequence: String(row.sequence),
        space: row.space,
        name: meta.name,
        content_type: meta.content_type,
        size: Number(row.size),
        public_url: meta.public_url,
        uploaded_by: meta.uploaded_by,
        created_at: row.created_at,
      });
      if (files.length > input.limit) break;
    }
    if (rows.length < 100) break;
    before = String(rows.at(-1)!.sequence);
  }
  const page = files.slice(0, input.limit);
  return {
    files: page,
    next_before: files.length > input.limit ? page.at(-1)!.sequence : null,
  };
}

// Operator backfill for objects uploaded before uploads were recorded. Every
// object under uploads/ that has no row is assigned to the given space.
export async function importPublicObjects(tx: Queryable, space: string) {
  const config = publicStorage();
  const client = publicClient(config);
  let imported = 0;
  try {
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: "uploads/",
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) {
        const key = object.Key!;
        const keyHash = tx.cipher!.fingerprint("public-file-key", key);
        if (
          (
            await tx.query("SELECT id FROM ap_public_files WHERE key_hash=$1", [
              keyHash,
            ])
          ).rows.length
        )
          continue;
        const head = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        const id = randomUUID();
        const created = (object.LastModified ?? new Date()).toISOString();
        await tx.query(
          `INSERT INTO ap_public_files(id,space,key_hash,encrypted_metadata,size,created_by,created_at,expires_at,completed_at)
          VALUES($1,$2,$3,$4,$5,import,$6,$6,$6)`,
          [
            id,
            space,
            keyHash,
            tx.cipher!.encrypt(`public-file:${id}`, {
              key,
              name: key.split("/").slice(2).join("/"),
              content_type: head.ContentType ?? "application/octet-stream",
              public_url: publicUrl(config, key),
              uploaded_by: "Imported",
            } satisfies PublicFileMetadata),
            object.Size ?? 0,
            created,
          ],
        );
        imported++;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } finally {
    client.destroy();
  }
  return imported;
}
