import { randomUUID } from "node:crypto";
import { z } from "zod";
import { systemDb } from "./db";
import { newTenantKey } from "./encryption";
import { AppError } from "./errors";
import { requireAccount, type Principal } from "./policy";

export function selectedTenant(headers: Headers) {
  const value =
    headers.get("x-astropath-tenant") ||
    headers.get("cookie")?.match(/(?:^|;\s*)astropath_tenant=([^;]+)/)?.[1];
  return value ? z.uuid().parse(value) : undefined;
}

export async function listTenants(principal: Principal) {
  const userId = requireAccount(principal);
  const result = await systemDb.query(
    `SELECT t.id,t.name,t.created_at,m.role FROM ap_tenants t JOIN ap_members m ON m.tenant_id=t.id
     WHERE m.user_id=$1 AND m.disabled_at IS NULL AND t.disabled_at IS NULL ORDER BY t.created_at,t.id`,
    [userId],
  );
  return {
    tenants: result.rows,
    active_tenant_id: principal.tenantId ?? null,
    platform_admin: !!principal.platformAdmin,
  };
}

export async function createTenant(principal: Principal, raw: unknown) {
  const userId = requireAccount(principal);
  const input = z
    .object({ name: z.string().trim().min(1).max(80) })
    .strict()
    .parse(raw);
  const id = randomUUID();
  await systemDb.transaction(async (tx) => {
    const user = (
      await tx.query<{ email: string; name: string }>(
        `SELECT email,name FROM "user" WHERE id=$1`,
        [userId],
      )
    ).rows[0];
    if (!user) throw new AppError(401, "unauthorized", "Sign in again.");
    await tx.query(
      "INSERT INTO ap_tenants(id,name,wrapped_key) VALUES($1,$2,$3)",
      [id, input.name, newTenantKey(id)],
    );
    await tx.query(
      "INSERT INTO ap_spaces(tenant_id,slug,name) VALUES($1,'general','General')",
      [id],
    );
    await tx.query(
      "INSERT INTO ap_members(id,tenant_id,email,name,user_id,spaces,role) VALUES($1,$2,$3,$4,$5,ARRAY['general'],'owner')",
      [randomUUID(), id, user.email.toLowerCase(), user.name, userId],
    );
    await tx.query(
      "INSERT INTO ap_platform_audit(user_id,tenant_id,action) VALUES($1,$2,'tenant.created')",
      [userId, id],
    );
  });
  return { tenant: { id, name: input.name, role: "owner" } };
}

export async function platformTenants(principal: Principal) {
  requireAccount(principal);
  if (!principal.platformAdmin)
    throw new AppError(
      403,
      "admin_required",
      "Platform administrator access required.",
    );
  return {
    tenants: (
      await systemDb.query(`SELECT t.id,t.name,t.created_at,t.disabled_at,
    (SELECT count(*)::integer FROM ap_members m WHERE m.tenant_id=t.id AND m.disabled_at IS NULL) AS members
    FROM ap_tenants t ORDER BY t.created_at`)
    ).rows,
  };
}

export async function setTenantDisabled(
  principal: Principal,
  id: string,
  raw: unknown,
) {
  const userId = requireAccount(principal);
  if (!principal.platformAdmin)
    throw new AppError(
      403,
      "admin_required",
      "Platform administrator access required.",
    );
  const { disabled } = z.object({ disabled: z.boolean() }).strict().parse(raw);
  z.uuid().parse(id);
  await systemDb.transaction(async (tx) => {
    const result = await tx.query(
      "UPDATE ap_tenants SET disabled_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1 RETURNING id",
      [id, disabled],
    );
    if (!result.rows.length)
      throw new AppError(404, "not_found", "Tenant not found.");
    await tx.query(
      "INSERT INTO ap_platform_audit(user_id,tenant_id,action) VALUES($1,$2,$3)",
      [userId, id, disabled ? "tenant.disabled" : "tenant.enabled"],
    );
  });
  return { id, disabled };
}

export async function assertTenantMember(userId: string, tenantId: string) {
  const result = await systemDb.query(
    `SELECT m.id FROM ap_members m JOIN ap_tenants t ON t.id=m.tenant_id
    WHERE m.user_id=$1 AND m.tenant_id=$2 AND m.disabled_at IS NULL AND t.disabled_at IS NULL`,
    [userId, tenantId],
  );
  if (!result.rows.length)
    throw new AppError(
      403,
      "tenant_forbidden",
      "You do not belong to this tenant.",
    );
  return true;
}
