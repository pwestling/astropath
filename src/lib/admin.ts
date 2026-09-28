import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db as rootDb, forPrincipal } from "./db";
import { AppError } from "./errors";
import { mintToken, requireScope, type Principal } from "./security";
import { connectionInput, spaceSlug } from "./validation";
import { store } from "./store";
import { reserveIdentityName } from "./identities";
import { requireAccount, requireSpace } from "./policy";

export function requireOwner(principal: Principal) {
  if (!principal.owner)
    throw new AppError(
      403,
      "owner_required",
      "This action requires the owner account.",
    );
}
export async function overview(principal: Principal) {
  const db = await forPrincipal(rootDb, principal);
  const userId = requireAccount(principal);
  const [counts, connections, activity] = await Promise.all([
    db.query(
      `SELECT count(*) FILTER (WHERE archived_at IS NULL AND parent_id IS NULL)::integer AS total,
      count(*) FILTER (WHERE pinned AND archived_at IS NULL)::integer AS pinned,
      (SELECT count(*)::integer FROM ap_files WHERE status='ready' AND ($2::text[] IS NULL OR space=ANY($2))) AS files,
      (SELECT COALESCE(sum(size),0)::text FROM ap_files WHERE status='ready' AND ($2::text[] IS NULL OR space=ANY($2))) AS storage_bytes,
      count(*) FILTER (WHERE parent_id IS NULL AND archived_at IS NULL AND principal_id<>$1 AND NOT EXISTS (SELECT 1 FROM ap_receipts r WHERE r.message_id=ap_messages.id AND r.principal_id=$1))::integer AS unread
      FROM ap_messages WHERE $2::text[] IS NULL OR space=ANY($2)`,
      [principal.id, principal.spaces],
    ),
    listConnections(principal),
    db.query(
      `SELECT a.* FROM ap_activity a WHERE $1::boolean
      OR EXISTS(SELECT 1 FROM ap_messages d WHERE d.id::text=a.target_id AND d.space=ANY($2::text[]))
      OR EXISTS(SELECT 1 FROM ap_connections c WHERE c.id::text=a.target_id AND c.created_by_user_id=$3)
      ORDER BY a.id DESC LIMIT 20`,
      [principal.owner, principal.spaces, userId],
    ),
  ]);
  return {
    ...counts.rows[0],
    connections: connections.connections,
    activity: activity.rows.map(({ encrypted_detail, ...row }) => ({
      ...row,
      detail:
        encrypted_detail && db.cipher
          ? db.cipher.decrypt<string>(
              `activity:${row.id}`,
              String(encrypted_detail),
            )
          : row.detail,
    })),
  };
}

export async function listConnections(principal: Principal) {
  const db = await forPrincipal(rootDb, principal);
  const userId = requireAccount(principal);
  const result = await db.query(
    `SELECT id,name,kind,token_prefix,scopes,spaces,created_at,last_used_at,expires_at,revoked_at FROM ap_connections
     WHERE $1::boolean OR created_by_user_id=$2 ORDER BY created_at DESC`,
    [principal.owner, userId],
  );
  return {
    connections: result.rows.map((row) => ({
      ...row,
      spaces: principal.owner
        ? row.spaces
        : (row.spaces as string[] | null)?.filter((space) =>
            principal.spaces!.includes(space),
          ) || [],
    })),
  };
}

export async function createConnection(principal: Principal, raw: unknown) {
  const db = await forPrincipal(rootDb, principal);
  const userId = requireAccount(principal);
  const input = connectionInput.parse(raw);
  input.spaces ??= principal.spaces;
  for (const space of input.spaces || []) requireSpace(principal, space);
  if (input.spaces) {
    const spaces = await db.query(
      "SELECT slug FROM ap_spaces WHERE slug=ANY($1::text[])",
      [input.spaces],
    );
    if (spaces.rows.length !== new Set(input.spaces).size)
      throw new AppError(400, "invalid_space", "Choose existing spaces.");
  }
  const { token, tokenHash, prefix } = mintToken();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + input.expires_in_days * 86400000);
  await db.transaction(async (tx) => {
    await reserveIdentityName(tx, input.name);
    await tx.query(
      `INSERT INTO ap_connections(id,name,kind,token_hash,token_prefix,scopes,spaces,expires_at,created_by_user_id)
    VALUES($1,$2,'token',$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.name,
        tokenHash,
        prefix,
        input.scopes,
        input.spaces,
        expiresAt,
        userId,
      ],
    );
  });
  await store.activity(principal.name, "connected", id, input.name, db);
  return { id, name: input.name, token, expires_at: expiresAt.toISOString() };
}

export async function revokeConnection(principal: Principal, id: string) {
  const db = await forPrincipal(rootDb, principal);
  const userId = requireAccount(principal);
  const result = await db.query<{ name: string }>(
    "UPDATE ap_connections SET revoked_at=now() WHERE id=$1 AND ($2::boolean OR created_by_user_id=$3) RETURNING name",
    [z.uuid().parse(id), principal.owner, userId],
  );
  if (!result.rows[0])
    throw new AppError(404, "not_found", "Connection not found.");
  await store.activity(principal.name, "revoked", id, result.rows[0].name, db);
  return { revoked: true };
}

export async function listSpaces(principal: Principal) {
  const db = await forPrincipal(rootDb, principal);
  requireScope(principal, "astropath:read");
  const result = await db.query(
    "SELECT * FROM ap_spaces WHERE $1::text[] IS NULL OR slug=ANY($1::text[]) ORDER BY name",
    [principal.spaces],
  );
  return { spaces: result.rows };
}
export async function createSpace(principal: Principal, raw: unknown) {
  const db = await forPrincipal(rootDb, principal);
  requireOwner(principal);
  const input = z
    .object({ slug: spaceSlug, name: z.string().trim().min(1).max(80) })
    .strict()
    .parse(raw);
  const result = await db.query(
    "INSERT INTO ap_spaces(slug,name) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING *",
    [input.slug, input.name],
  );
  if (!result.rows[0])
    throw new AppError(409, "space_exists", "This space already exists.");
  return { space: result.rows[0] };
}
