import { Pool, type QueryResultRow } from "pg";
import { z } from "zod";
import type { Principal } from "./policy";
import { AppError } from "./errors";
import {
  contentCipher,
  unwrapTenantKey,
  type ContentCipher,
} from "./encryption";

const globalDb = globalThis as typeof globalThis & { astropathPool?: Pool };
export const pool =
  globalDb.astropathPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
globalDb.astropathPool = pool;

export interface Queryable {
  tenantId?: string;
  cipher?: ContentCipher;
  query<T extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}
export interface Database extends Queryable {
  forTenant?(tenantId: string): Promise<Database>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}
// Only authentication, tenant directory and maintenance may use this handle.
export const systemDb: Database = {
  query: (text, values) => pool.query(text, values),
  async transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

export async function tenantDatabase(
  tenantId: string,
  directory: Database = systemDb,
): Promise<Database> {
  z.uuid().parse(tenantId);
  const result = await directory.query<{ wrapped_key: string }>(
    "SELECT wrapped_key FROM ap_tenants WHERE id=$1 AND disabled_at IS NULL",
    [tenantId],
  );
  if (!result.rows[0])
    throw new AppError(
      403,
      "tenant_unavailable",
      "This tenant is unavailable.",
    );
  const cipher = contentCipher(
    tenantId,
    unwrapTenantKey(tenantId, result.rows[0].wrapped_key),
  );
  const scoped: Database = {
    tenantId,
    cipher,
    forTenant: async (id) => {
      if (id !== tenantId)
        throw new Error("Cannot change a scoped database's tenant");
      return scoped;
    },
    query: (text, values) => scoped.transaction((tx) => tx.query(text, values)),
    transaction: (fn) =>
      directory.transaction(async (tx) => {
        await tx.query("SET LOCAL ROLE astropath_tenant");
        await tx.query("SELECT set_config('astropath.tenant_id',$1,true)", [
          tenantId,
        ]);
        return fn({ query: tx.query.bind(tx), tenantId, cipher });
      }),
  };
  return scoped;
}

// Fail closed if a content path forgets to choose a tenant. Injectable databases
// let the domain stores be exercised independently of the Postgres adapter.
export const db: Database = {
  forTenant: tenantDatabase,
  query: async () => {
    throw new Error("Content queries require a tenant");
  },
  transaction: async () => {
    throw new Error("Content transactions require a tenant");
  },
};
export async function forPrincipal(database: Database, principal: Principal) {
  if (!database.forTenant) return database;
  if (!principal.tenantId)
    throw new AppError(
      403,
      "tenant_required",
      "Choose a tenant you belong to.",
    );
  return database.forTenant(principal.tenantId);
}
