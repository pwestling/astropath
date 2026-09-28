import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { getAuth } from "../src/lib/auth";
import { pool } from "../src/lib/db";
import { migrateTenancy, INITIAL_TENANT } from "../src/lib/tenant-migration";
import { masterKey } from "../src/lib/encryption";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  masterKey();
  const migrations = await getMigrations(getAuth().options);
  await migrations.runMigrations();
  const rename = await readFile(
    new URL("../src/lib/rename-schema.sql", import.meta.url),
    "utf8",
  );
  const schema = await readFile(
    new URL("../src/lib/schema.sql", import.meta.url),
    "utf8",
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('astropath.tenant_id',$1,true)", [
      INITIAL_TENANT,
    ]);
    await client.query(rename);
    await client.query(schema);
    await migrateTenancy(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log("Authentication and Astropath database schemas are ready.");
}
main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
