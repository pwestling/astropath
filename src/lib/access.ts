import type { Queryable } from "./db";
import { ownerEmail, SCOPES } from "./config";
import { AppError } from "./errors";
import type { Principal } from "./policy";

export async function userPrincipal(
  database: Queryable,
  userId: string,
): Promise<Principal | null> {
  const result = await database.query<{
    id: string;
    name: string;
    email: string;
    member_id: string | null;
    spaces: string[] | null;
    disabled_at: Date | null;
  }>(
    `SELECT u.id,u.name,u.email,m.id AS member_id,m.spaces,m.disabled_at
      FROM "user" u LEFT JOIN ap_members m ON m.user_id=u.id WHERE u.id=$1`,
    [userId],
  );
  const user = result.rows[0];
  if (!user) return null;
  const owner = !!ownerEmail() && user.email.toLowerCase() === ownerEmail();
  if (!owner && (!user.member_id || user.disabled_at || !user.spaces?.length))
    return null;
  return {
    id: `${owner ? "owner" : "member"}:${user.id}`,
    userId: user.id,
    name: user.name,
    owner,
    scopes: [...SCOPES],
    spaces: owner ? null : user.spaces,
  };
}

export async function connectionSpaces(
  database: Queryable,
  spaces: string[] | null,
  userId: string | null,
) {
  // Credentials created before member accounts were all issued by the owner.
  if (!userId) return spaces;
  const account = await userPrincipal(database, userId);
  if (!account)
    throw new AppError(
      403,
      "access_revoked",
      "The account that authorized this connection no longer has access.",
    );
  if (account.owner) return spaces;
  // A member connection can never acquire unrestricted access, including after a membership edit.
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
