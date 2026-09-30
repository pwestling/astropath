import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// Recompute template hashes after editing public/integrations. Bump a
// template's version (and its astropath-template marker) whenever its text
// changes, so installed copies can tell they are out of date.
const root = new URL("../public/integrations/", import.meta.url);
const manifestUrl = new URL("manifest.json", root);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
for (const [file, entry] of Object.entries<{ sha256: string }>(
  manifest.templates,
))
  entry.sha256 = createHash("sha256")
    .update(await readFile(new URL(file, root)))
    .digest("hex");
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
console.log("Updated public/integrations/manifest.json");
