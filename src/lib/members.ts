import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { forPrincipal, type Database, type Queryable } from "./db";
import { appUrl } from "./config";
import { AppError } from "./errors";
import { hash, type Principal } from "./policy";
import { identityName, spaceSlug } from "./validation";

const spaceList = z
  .array(spaceSlug)
  .min(1)
  .max(50)
  .transform((values) => [...new Set(values)]);
const memberInput = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    name: identityName,
    spaces: spaceList,
  })
  .strict();
const columns =
  "id,email,name,user_id,spaces,role,disabled_at,created_at,invite_expires_at";
function ownerOnly(principal: Principal) {
  if (!principal.owner)
    throw new AppError(
      403,
      "owner_required",
      "Only the owner can manage members.",
    );
}
async function validateSpaces(tx: Queryable, spaces: string[]) {
  const found = await tx.query(
    "SELECT slug FROM ap_spaces WHERE slug=ANY($1::text[])",
    [spaces],
  );
  if (found.rows.length !== spaces.length)
    throw new AppError(400, "invalid_space", "Choose existing spaces.");
}
function invitation() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    invite_hash: hash(token),
    invite_url: `${appUrl()}/invite#token=${token}`,
  };
}
export class MemberStore {
  constructor(private database: Database) {}
  async list(principal: Principal) {
    ownerOnly(principal);
    const database = await forPrincipal(this.database, principal);
    return {
      members: (
        await database.query(
          `SELECT ${columns} FROM ap_members ORDER BY created_at`,
        )
      ).rows,
    };
  }
  async create(principal: Principal, raw: unknown) {
    ownerOnly(principal);
    const database = await forPrincipal(this.database, principal);
    const input = memberInput.parse(raw);
    const invite = invitation();
    return database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `member-email:${input.email}`,
      ]);
      await validateSpaces(tx, input.spaces);
      const existing = await tx.query(
        "SELECT email FROM ap_members WHERE email=$1",
        [input.email],
      );
      if (existing.rows.length)
        throw new AppError(
          409,
          "member_exists",
          "That email already has an account or invitation.",
        );
      const result = await tx.query(
        `INSERT INTO ap_members(id,email,name,spaces,invite_hash,invite_expires_at)
        VALUES($1,$2,$3,$4,$5,now()+interval '7 days') RETURNING ${columns}`,
        [
          randomUUID(),
          input.email,
          input.name,
          input.spaces,
          invite.invite_hash,
        ],
      );
      return { member: result.rows[0], invite_url: invite.invite_url };
    });
  }
  async update(principal: Principal, id: string, raw: unknown) {
    ownerOnly(principal);
    const database = await forPrincipal(this.database, principal);
    const input = z
      .object({
        spaces: spaceList.optional(),
        disabled: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    return database.transaction(async (tx) => {
      if (input.spaces) await validateSpaces(tx, input.spaces);
      const result = await tx.query<{ user_id: string | null }>(
        `UPDATE ap_members SET spaces=COALESCE($2,spaces),
        disabled_at=CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN now() ELSE NULL END,
        invite_hash=CASE WHEN $3 THEN NULL ELSE invite_hash END,
        invite_expires_at=CASE WHEN $3 THEN NULL ELSE invite_expires_at END
        WHERE id=$1 AND role='member' RETURNING ${columns}`,
        [z.uuid().parse(id), input.spaces ?? null, input.disabled ?? null],
      );
      if (!result.rows.length)
        throw new AppError(404, "not_found", "Member not found.");
      // Revocation is checked per tenant on every request, including active waits.
      // Sessions for the same person's other tenants remain valid.
      return { member: result.rows[0] };
    });
  }
  async reinvite(principal: Principal, id: string) {
    ownerOnly(principal);
    const database = await forPrincipal(this.database, principal);
    const invite = invitation();
    const result = await database.query(
      `UPDATE ap_members SET invite_hash=$2,invite_expires_at=now()+interval '7 days'
      WHERE id=$1 AND user_id IS NULL AND disabled_at IS NULL RETURNING id`,
      [z.uuid().parse(id), invite.invite_hash],
    );
    if (!result.rows.length)
      throw new AppError(
        409,
        "invite_unavailable",
        "Only pending, enabled members can receive a new invitation.",
      );
    return { invite_url: invite.invite_url };
  }
  private async pending(tx: Queryable, token: string, lock = false) {
    const result = await tx.query<{
      id: string;
      name: string;
      email: string;
      spaces: string[];
      tenant_id: string;
    }>(
      `SELECT id,name,email,spaces,tenant_id FROM ap_members
      WHERE invite_hash=$1 AND invite_expires_at>now() AND user_id IS NULL AND disabled_at IS NULL
      AND EXISTS(SELECT 1 FROM ap_tenants t WHERE t.id=tenant_id AND t.disabled_at IS NULL)${lock ? " FOR UPDATE" : ""}`,
      [
        hash(
          z
            .string()
            .regex(/^[A-Za-z0-9_-]{43}$/)
            .parse(token),
        ),
      ],
    );
    if (!result.rows.length)
      throw new AppError(
        400,
        "invalid_invite",
        "This invitation is invalid, expired, or already used. Ask the owner for a new link.",
      );
    return result.rows[0];
  }
  async inspect(token: string) {
    const member = await this.pending(this.database, token);
    const spaces = await this.database.query(
      "SELECT slug,name FROM ap_spaces WHERE slug=ANY($1::text[]) AND tenant_id=$2 ORDER BY name",
      [member.spaces, member.tenant_id],
    );
    return { name: member.name, email: member.email, spaces: spaces.rows };
  }
  async accept(token: string, password: string) {
    z.string().min(12).max(128).parse(password);
    return this.database.transaction(async (tx) => {
      const member = await this.pending(tx, token, true);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `account-email:${member.email}`,
      ]);
      const existing = await tx.query(
        'SELECT id FROM "user" WHERE lower(email)=$1',
        [member.email],
      );
      if (existing.rows.length)
        throw new AppError(
          409,
          "existing_account",
          "This email already has an account. Joining another tenant with an existing account is not available yet.",
        );
      const userId = randomUUID();
      // Use Better Auth's password format and atomically create its credential account with membership.
      // Public sign-up stays disabled; only a valid, single-use owner invitation reaches this code.
      const passwordHash = await hashPassword(password);
      await tx.query(
        `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())`,
        [userId, member.name, member.email],
      );
      await tx.query(
        `INSERT INTO account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES($1,$2,'credential',$2,$3,now(),now())`,
        [randomUUID(), userId, passwordHash],
      );
      await tx.query(
        "UPDATE ap_members SET user_id=$2,invite_hash=NULL,invite_expires_at=NULL WHERE id=$1",
        [member.id, userId],
      );
      return { email: member.email };
    });
  }
}
