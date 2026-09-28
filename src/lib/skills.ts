import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, forPrincipal, type Database } from "./db";
import { AppError } from "./errors";
import { hash, requireScope, requireSpace, type Principal } from "./policy";
import { spaceSlug } from "./validation";

const skillPath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !/[:\\\x00-\x1f\x7f]/.test(path) &&
      path.split("/").every((part) => !!part && part !== "." && part !== ".."),
    "Use a relative path without empty, dot, parent, or control-character segments.",
  );
export const publishSkillInput = z
  .object({
    space: spaceSlug.default("general"),
    slug: spaceSlug,
    description: z.string().trim().max(2000).default(""),
    files: z
      .record(skillPath, z.string().max(1000000))
      .refine(
        (files) =>
          Object.keys(files).length <= 100 &&
          typeof files["SKILL.md"] === "string" &&
          files["SKILL.md"].trim().length > 0,
        "Include a nonempty SKILL.md and at most 100 text files.",
      ),
  })
  .strict();
export const listSkillsInput = z
  .object({
    space: spaceSlug.optional(),
    include_deprecated: z.boolean().default(false),
    after: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export const pullSkillInput = z
  .object({
    space: spaceSlug.default("general"),
    slug: spaceSlug,
    revision_id: z.uuid().optional(),
  })
  .strict();
export const deprecateSkillInput = z
  .object({
    space: spaceSlug.default("general"),
    slug: spaceSlug,
    deprecated: z.boolean().default(true),
    reason: z.string().trim().max(2000).default(""),
  })
  .strict();
export const skillHistoryInput = z
  .object({
    space: spaceSlug.default("general"),
    slug: spaceSlug,
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();

interface Revision {
  id: string;
  space: string;
  slug: string;
  revision: number;
  content_hash: string;
  created_at: string;
}
interface SkillContent {
  description: string;
  files: Record<string, string>;
}

export class SkillStore {
  constructor(private database: Database) {}

  async publish(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:write");
    const input = publishSkillInput.parse(raw);
    requireSpace(principal, input.space);
    // Stable encoding makes retries return the same immutable revision.
    const entries = Object.entries(input.files).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const files = Object.fromEntries(entries);
    const content = { description: input.description, files };
    // Serialize entries explicitly: JSON.stringify(object) otherwise moves
    // integer-looking file names ahead of lexicographically sorted names.
    const canonical = `{"description":${JSON.stringify(input.description)},"files":{${entries.map(([path, text]) => `${JSON.stringify(path)}:${JSON.stringify(text)}`).join(",")}}`;
    if (Buffer.byteLength(canonical) > 2 * 1024 * 1024)
      throw new AppError(
        413,
        "skill_too_large",
        "A skill revision is limited to 2 MiB of UTF-8 text.",
      );
    const contentHash = hash(canonical);
    const database = await forPrincipal(this.database, principal);
    if (!database.cipher)
      throw new Error("Skill storage requires tenant encryption");
    return database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `skill:${principal.tenantId}:${input.space}:${input.slug}`,
      ]);
      const space = await tx.query("SELECT slug FROM ap_spaces WHERE slug=$1", [
        input.space,
      ]);
      if (!space.rows.length)
        throw new AppError(404, "not_found", "Space not found.");
      await tx.query(
        "INSERT INTO ap_skills(space,slug) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [input.space, input.slug],
      );
      const skill = (
        await tx.query<{ deprecated_at: string | null }>(
          "SELECT deprecated_at FROM ap_skills WHERE space=$1 AND slug=$2",
          [input.space, input.slug],
        )
      ).rows[0];
      if (skill.deprecated_at)
        throw new AppError(
          409,
          "skill_deprecated",
          "Restore this skill before publishing new revisions.",
        );
      const prior = (
        await tx.query<Revision>(
          "SELECT id,space,slug,revision,content_hash,created_at FROM ap_skill_revisions WHERE space=$1 AND slug=$2 AND content_hash=$3",
          [input.space, input.slug, contentHash],
        )
      ).rows[0];
      if (prior)
        return {
          ...prior,
          space: input.space,
          slug: input.slug,
          replayed: true,
        };
      const id = randomUUID();
      const result = await tx.query<Revision>(
        `INSERT INTO ap_skill_revisions(id,space,slug,revision,content_hash,encrypted_content,principal_id)
        SELECT $1,$2,$3,COALESCE(max(revision),0)+1,$4,$5,$6 FROM ap_skill_revisions WHERE space=$2 AND slug=$3
        RETURNING id,space,slug,revision,content_hash,created_at`,
        [
          id,
          input.space,
          input.slug,
          contentHash,
          database.cipher!.encrypt(`skill:${id}`, content),
          principal.id,
        ],
      );
      return { ...result.rows[0], replayed: false };
    });
  }

  async list(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:read");
    const input = listSkillsInput.parse(raw);
    if (input.space) requireSpace(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    let after: [string, string] | undefined;
    if (input.after) {
      try {
        after = z
          .tuple([spaceSlug, spaceSlug])
          .parse(
            JSON.parse(Buffer.from(input.after, "base64url").toString("utf8")),
          );
      } catch {
        throw new AppError(400, "invalid_cursor", "Invalid skills cursor.");
      }
    }
    const rows = (
      await database.query(
        `SELECT DISTINCT ON(r.slug,r.space) r.id,r.space,r.slug,r.revision,r.content_hash,r.created_at,s.deprecated_at
      FROM ap_skill_revisions r JOIN ap_skills s USING(tenant_id,space,slug)
      WHERE ($1::text[] IS NULL OR r.space=ANY($1)) AND ($2::text IS NULL OR r.space=$2)
      AND ($3::boolean OR s.deprecated_at IS NULL) AND ($4::text IS NULL OR (r.slug,r.space)>($4,$5))
      ORDER BY r.slug,r.space,r.revision DESC LIMIT $6`,
        [
          principal.spaces,
          input.space ?? null,
          input.include_deprecated,
          after?.[0] ?? null,
          after?.[1] ?? null,
          input.limit + 1,
        ],
      )
    ).rows;
    const more = rows.length > input.limit;
    const skills = rows.slice(0, input.limit);
    return {
      skills,
      next_cursor: more
        ? Buffer.from(
            JSON.stringify([skills.at(-1)!.slug, skills.at(-1)!.space]),
          ).toString("base64url")
        : null,
    };
  }

  async pull(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:read");
    const input = pullSkillInput.parse(raw);
    requireSpace(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    const row = (
      await database.query<
        Revision & {
          tenant_id: string;
          encrypted_content: string;
          deprecated_at: string | null;
          deprecation_reason: string | null;
        }
      >(
        `SELECT r.*,s.deprecated_at,s.deprecation_reason FROM ap_skill_revisions r JOIN ap_skills s USING(tenant_id,space,slug)
       WHERE r.space=$1 AND r.slug=$2 AND ($3::uuid IS NULL OR r.id=$3) ORDER BY r.revision DESC LIMIT 1`,
        [input.space, input.slug, input.revision_id ?? null],
      )
    ).rows[0];
    if (!row) throw new AppError(404, "not_found", "Skill revision not found.");
    if (row.deprecated_at && !input.revision_id)
      throw new AppError(
        409,
        "skill_deprecated",
        "This skill is deprecated. Pull an exact revision ID if it is still needed.",
      );
    const {
      encrypted_content,
      deprecation_reason,
      tenant_id: _tenant,
      ...metadata
    } = row;
    return {
      ...metadata,
      ...database.cipher!.decrypt<SkillContent>(
        `skill:${row.id}`,
        encrypted_content,
      ),
      deprecation_reason: deprecation_reason
        ? database.cipher!.decrypt<string>(
            `skill-status:${input.space}:${input.slug}`,
            deprecation_reason,
          )
        : null,
    };
  }

  async history(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:read");
    const input = skillHistoryInput.parse(raw);
    requireSpace(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    const rows = (
      await database.query<Revision>(
        `SELECT id,space,slug,revision,content_hash,created_at FROM ap_skill_revisions
      WHERE space=$1 AND slug=$2 AND ($3::integer IS NULL OR revision<$3) ORDER BY revision DESC LIMIT $4`,
        [input.space, input.slug, input.before ?? null, input.limit + 1],
      )
    ).rows;
    const revisions = rows.slice(0, input.limit);
    return {
      revisions,
      next_before:
        rows.length > input.limit ? revisions.at(-1)!.revision : null,
    };
  }

  async deprecate(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:write");
    const input = deprecateSkillInput.parse(raw);
    requireSpace(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    return database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `skill:${principal.tenantId}:${input.space}:${input.slug}`,
      ]);
      const result = await tx.query(
        `UPDATE ap_skills SET deprecated_at=CASE WHEN $3 THEN COALESCE(deprecated_at,now()) ELSE NULL END,
        deprecation_reason=$4 WHERE space=$1 AND slug=$2 RETURNING space,slug,deprecated_at`,
        [
          input.space,
          input.slug,
          input.deprecated,
          input.deprecated
            ? database.cipher!.encrypt(
                `skill-status:${input.space}:${input.slug}`,
                input.reason,
              )
            : null,
        ],
      );
      if (!result.rows.length)
        throw new AppError(404, "not_found", "Skill not found.");
      return result.rows[0];
    });
  }
}
export const skills = new SkillStore(db);
