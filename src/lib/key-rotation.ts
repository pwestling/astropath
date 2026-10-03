import type { Queryable } from "./db";
import {
  masterKey,
  open,
  previousMasterKey,
  wrapTenantKey,
} from "./encryption";

// Re-wrap every tenant key from ASTROPATH_PREVIOUS_MASTER_KEY to
// ASTROPATH_MASTER_KEY. Content is untouched: only the wrapped tenant keys
// change. Runs in the caller's transaction, verifies each result, and is
// repeatable: tenants already under the current key are skipped. Reports
// counts only; no key material leaves this function.
export async function rotateTenantKeys(tx: Queryable, apply: boolean) {
  const current = masterKey();
  const previous = previousMasterKey();
  if (!previous)
    throw new Error(
      "Set ASTROPATH_PREVIOUS_MASTER_KEY to the old key and ASTROPATH_MASTER_KEY to the new one.",
    );
  if (previous.equals(current))
    throw new Error(
      "ASTROPATH_PREVIOUS_MASTER_KEY and ASTROPATH_MASTER_KEY are the same key.",
    );
  const tenants = (
    await tx.query<{ id: string; wrapped_key: string }>(
      "SELECT id,wrapped_key FROM ap_tenants ORDER BY id FOR UPDATE",
    )
  ).rows;
  let rotated = 0;
  let already = 0;
  for (const tenant of tenants) {
    const context = `tenant-key:${tenant.id}`;
    try {
      open(current, context, tenant.wrapped_key);
      already++;
      continue;
    } catch {
      // Not yet under the current key.
    }
    let key: Buffer;
    try {
      key = open(previous, context, tenant.wrapped_key);
    } catch {
      throw new Error(
        `Tenant ${tenant.id} opens with neither the current nor the previous master key; nothing was changed.`,
      );
    }
    const rewrapped = wrapTenantKey(tenant.id, key, current);
    if (!open(current, context, rewrapped).equals(key))
      throw new Error(`Verification failed for tenant ${tenant.id}.`);
    if (apply)
      await tx.query("UPDATE ap_tenants SET wrapped_key=$2 WHERE id=$1", [
        tenant.id,
        rewrapped,
      ]);
    rotated++;
  }
  return { tenants: tenants.length, rotated, already, applied: apply };
}

// After a rotation: every tenant key must open with the current key alone,
// before ASTROPATH_PREVIOUS_MASTER_KEY is removed.
export async function verifyTenantKeys(tx: Queryable) {
  const current = masterKey();
  const tenants = (
    await tx.query<{ id: string; wrapped_key: string }>(
      "SELECT id,wrapped_key FROM ap_tenants ORDER BY id",
    )
  ).rows;
  const failing = tenants.filter((tenant) => {
    try {
      open(current, `tenant-key:${tenant.id}`, tenant.wrapped_key);
      return false;
    } catch {
      return true;
    }
  });
  return {
    tenants: tenants.length,
    failing: failing.map((tenant) => tenant.id),
  };
}
