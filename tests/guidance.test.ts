import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import manifest from "../public/integrations/manifest.json";
import { currentGuidance, GUIDANCE_VERSION } from "../src/lib/guidance";
import type { Principal } from "../src/lib/policy";

const root = new URL("../public/integrations/", import.meta.url);

it("keeps every install template's hash and version marker in the manifest", async () => {
  for (const [file, entry] of Object.entries(manifest.templates)) {
    const text = await readFile(new URL(file, root), "utf8");
    expect(
      createHash("sha256").update(text).digest("hex"),
      `${file} changed: bump its version and marker, then run npm run integrations:manifest`,
    ).toBe(entry.sha256);
    expect(text).toContain(`astropath-template: ${file} ${entry.version}`);
    expect(text).toContain("get_guidance");
  }
});

it("serves the current policy and template versions to readers only", () => {
  const reader: Principal = {
    id: "reader",
    name: "Reader",
    owner: false,
    spaces: ["general"],
    scopes: ["astropath:read"],
  };
  const result = currentGuidance(reader);
  expect(result.version).toBe(GUIDANCE_VERSION);
  expect(result.guidance).toContain("remember");
  expect(result.templates.map((item) => item.file)).toEqual(
    Object.keys(manifest.templates),
  );
  expect(result.templates[0].url).toMatch(/\/integrations\/policy\.md$/);
  expect(() => currentGuidance({ ...reader, scopes: [] })).toThrow();
});
