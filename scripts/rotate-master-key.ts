import { pool, systemDb } from "../src/lib/db";
import { rotateTenantKeys, verifyTenantKeys } from "../src/lib/key-rotation";

// Master key rotation (docs/master-key-rotation.md). With
// ASTROPATH_PREVIOUS_MASTER_KEY (old) and ASTROPATH_MASTER_KEY (new) set:
//   npm run keys:rotate            dry run: report what would change
//   npm run keys:rotate -- --apply re-wrap every tenant key in one transaction
//   npm run keys:rotate -- --verify every tenant key opens with the new key alone
// Prints counts and tenant ids only, never key material.
async function main() {
  const mode = process.argv[2];
  if (mode === "--verify") {
    const result = await verifyTenantKeys(systemDb);
    console.log(
      `${result.tenants} tenant keys checked; ${result.failing.length} do not open with ASTROPATH_MASTER_KEY alone${result.failing.length ? `: ${result.failing.join(", ")}` : ""}.`,
    );
    if (result.failing.length) process.exitCode = 1;
    return;
  }
  if (mode && mode !== "--apply")
    throw new Error("Usage: npm run keys:rotate -- [--apply | --verify]");
  const result = await systemDb.transaction((tx) =>
    rotateTenantKeys(tx, mode === "--apply"),
  );
  console.log(
    `${result.tenants} tenants: ${result.rotated} ${result.applied ? "re-wrapped" : "to re-wrap (dry run)"}, ${result.already} already under the new key.`,
  );
}
main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
