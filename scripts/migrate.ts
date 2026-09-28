import { readFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { getAuth } from "../src/lib/auth";
import { pool } from "../src/lib/db";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
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
    await client.query(rename);
    await client.query(schema);
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
