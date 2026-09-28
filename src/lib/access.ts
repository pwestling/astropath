import type { Queryable } from "./db";
import { ownerEmail, SCOPES } from "./config";
import { AppError } from "./errors";
import type { Principal } from "./policy";

export async function userPrincipal(
  database: Queryable,
  userId: string,
  tenantId?: string,
): Promise<Principal | null> {
  const user = (
    await database.query<{ id: string; name: string; email: string }>(
      'SELECT id,name,email FROM "user" WHERE id=$1',
      [userId],
    )
  ).rows[0];
  if (!user) return null;
  const platformAdmin =
    !!ownerEmail() && user.email.toLowerCase() === ownerEmail();
  const member = (
    await database.query<{ tenant_id: string; role: string; spaces: string[] }>(
      `SELECT m.tenant_id,m.role,m.spaces FROM ap_members m JOIN ap_tenants t ON t.id=m.tenant_id
     WHERE m.user_id=$1 AND m.disabled_at IS NULL AND t.disabled_at IS NULL
     AND ($2::uuid IS NULL OR m.tenant_id=$2) ORDER BY t.created_at,t.id LIMIT 1`,
      [userId, tenantId ?? null],
    )
  ).rows[0];
  if (!member && tenantId) return null;
  const owner = member?.role === "owner";
  return {
    // Preserve historical receipt/uploader identities. The prefix conveys no
    // permission: tenant membership and the separate owner flag decide access.
    id: `${platformAdmin ? "owner" : "member"}:${user.id}`,
    userId: user.id,
    name: user.name,
    owner,
    platformAdmin,
    tenantId: member?.tenant_id,
    scopes: [...SCOPES],
    spaces: owner ? null : (member?.spaces ?? []),
  };
}

export async function connectionSpaces(
  database: Queryable,
  spaces: string[] | null,
  userId: string | null,
  tenantId: string,
) {
  const account = userId
    ? await userPrincipal(database, userId, tenantId)
    : null;
  if (!account)
    throw new AppError(
      403,
      "access_revoked",
      "The account that authorized this connection no longer has access.",
    );
  if (account.owner) return spaces;
  const allowed =
    spaces?.filter((space) => account.spaces!.includes(space)) || [];
  if (!allowed.length)
    throw new AppError(
      403,
      "access_revoked",
      "This connection no longer has access to its spaces.",
    );
  return allowed;
}
