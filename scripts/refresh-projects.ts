import { pool } from "../src/lib/db";
import { projects } from "../src/lib/projects";
import { SCOPES } from "../src/lib/config";

// Operator run of the Projects overview for one tenant, e.g. to check the model
// wiring from the app's own runtime:
//   npm run projects:refresh -- TENANT_ID [--force]
// The workspace owner must already have turned the overview on.
async function main() {
  const [tenantId, flag] = process.argv.slice(2);
  if (!tenantId)
    throw new Error("Usage: npm run projects:refresh -- TENANT_ID [--force]");
  const result = await projects.refresh(
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
      `${space.space}: ${space.projects.length} projects${space.error ? `, error: ${space.error}` : ""}${space.considered ? ` (from ${space.considered.topics} topics, ${space.considered.memories} memories)` : ""}`,
    );
}
main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
