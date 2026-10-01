import { pool, tenantDatabase } from "../src/lib/db";
import { importPublicObjects } from "../src/lib/public-files";

// Backfill objects published before uploads were recorded:
//   npm run public-files:import -- TENANT_ID SPACE
// Objects under uploads/ without a record are assigned to that tenant and space.
async function main() {
  const [tenant, space] = process.argv.slice(2);
  if (!tenant || !space)
    throw new Error("Usage: npm run public-files:import -- TENANT_ID SPACE");
  const database = await tenantDatabase(tenant);
  const imported = await database.transaction((tx) =>
    importPublicObjects(tx, space),
  );
  console.log(`Imported ${imported} public file(s) into ${space}.`);
}
main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
