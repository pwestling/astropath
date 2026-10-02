import { pool } from "../src/lib/db";
import { concerns } from "../src/lib/concerns";
import { SCOPES } from "../src/lib/config";

// Operator run of active concerns for one tenant, e.g. to check the model
// wiring from the app's own runtime:
//   npm run concerns:refresh -- TENANT_ID [--force]
// The workspace owner must already have turned concerns on.
async function main() {
  const [tenantId, flag] = process.argv.slice(2);
  if (!tenantId)
    throw new Error("Usage: npm run concerns:refresh -- TENANT_ID [--force]");
  const result = await concerns.refresh(
    {
      id: "operator:cli",
      userId: "operator",
      name: "Operator",
      owner: true,
      tenantId,
      spaces: null,
      scopes: [...SCOPES],
    },
    { force: flag === "--force" },
  );
  for (const space of result.spaces)
    console.log(
      `${space.space}: ${space.concerns.length} concerns${space.error ? `, error: ${space.error}` : ""}${space.considered ? ` (from ${space.considered.topics} topics, ${space.considered.memories} memories)` : ""}`,
    );
}
main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
