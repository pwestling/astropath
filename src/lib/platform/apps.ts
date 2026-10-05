import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, forPrincipal, systemDb, type Database } from "../db";
import { AppError } from "../errors";
import { hash, type Principal } from "../policy";
import {
  appId,
  canonicalJson,
  contractHash,
  validateManifest,
} from "./contracts";
import { loadCatalog, type AppRow } from "./catalog";
import { PlatformError } from "./errors";
import { publicKeys } from "./signing";
import "./dispatch";

// Only the workspace owner, signed in, creates apps and sets where their
// calls go. Agent connections never can.
function requireOwner(principal: Principal) {
  if (!principal.owner || !principal.userId)
    throw new AppError(
      403,
      "owner_required",
      "Only the workspace owner can manage apps.",
    );
}
// The origin is where every call to this app goes. http is allowed for apps
// on the same host or tailnet; there is no path, query or credential.
const origin = z
  .url({ protocol: /^https?$/ })
  .max(300)
  .transform((value, ctx) => {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Use a bare origin such as https://app.example.com.",
      });
      return z.NEVER;
    }
    return url.origin;
  });
export const createAppInput = z
  .object({
    id: appId,
    name: z.string().trim().min(1).max(100),
    origin,
    grant_policy: z.enum(["auto", "explicit"]).default("auto"),
  })
  .strict();
export const updateAppInput = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    origin: origin.optional(),
    grant_policy: z.enum(["auto", "explicit"]).optional(),
    disabled: z.boolean().optional(),
    disabled_operations: z.array(z.string().max(105)).optional(),
  })
  .strict();
export const setGrantInput = z
  .object({
    connection_id: z.string().min(1).max(200),
    mode: z.enum(["include", "exclude"]).nullable(),
  })
  .strict();

function mintPublisherKey() {
  const key = `apk_${randomBytes(32).toString("base64url")}`;
  return { key, keyHash: hash(key), prefix: key.slice(0, 12) };
}
const PUBLISHER_KEY = /^apk_[A-Za-z0-9_-]{43}$/;

export class AppStore {
  constructor(private database: Database = db) {}

  async list(principal: Principal) {
    requireOwner(principal);
    const scoped = await forPrincipal(this.database, principal);
    return scoped.transaction(async (tx) => {
      const catalog = await loadCatalog(tx);
      const apps = (
        await tx.query<
          AppRow & {
            publisher_key_prefix: string | null;
            created_at: string;
            updated_at: string;
          }
        >(
          `SELECT id,name,origin,grant_policy,active_release,disabled_at,disabled_operations,publisher_key_prefix,created_at,updated_at
           FROM ap_apps ORDER BY id`,
        )
      ).rows;
      const grants = (
        await tx.query<{ app_id: string; connection_id: string; mode: string }>(
          "SELECT app_id,connection_id,mode FROM ap_app_grants ORDER BY set_at",
        )
      ).rows;
      const connections = (
        await tx.query<{ id: string; name: string; scopes: string[] }>(
          "SELECT id::text AS id,name,scopes FROM ap_connections WHERE revoked_at IS NULL ORDER BY name",
        )
      ).rows;
      const recent = (
        await tx.query<{
          id: string;
          principal_id: string;
          principal_name: string;
          operation: string;
          version: string;
          status: string;
          effect_state: string;
          app_id: string;
          created_at: string;
        }>(
          `SELECT id,principal_id,principal_name,operation,version,status,effect_state,app_id,created_at
           FROM ap_invocations ORDER BY created_at DESC LIMIT 50`,
        )
      ).rows;
      const names = new Map(connections.map((c) => [c.id, c.name]));
      return {
        catalog_revision: catalog.revision,
        apps: apps.map((app) => ({
          ...app,
          description: catalog.apps.get(app.id)?.description ?? "",
          ui_url: catalog.apps.get(app.id)?.ui_url ?? null,
          operations: catalog.entries
            .filter((entry) => entry.app === app.id)
            .map((entry) => ({
              ...entry.contract,
              disabled: false,
            })),
          grants: grants.filter((grant) => grant.app_id === app.id),
        })),
        built_in: catalog.entries
          .filter((entry) => entry.binding.kind === "local")
          .map((entry) => ({
            operation: entry.contract.operation,
            version: entry.contract.version,
            summary: entry.contract.summary,
            effect: entry.contract.effect,
          })),
        connections,
        recent: recent.map((row) => ({
          ...row,
          caller:
            names.get(row.principal_id) ??
            (row.principal_name || row.principal_id),
        })),
      };
    });
  }

  async create(principal: Principal, raw: unknown) {
    requireOwner(principal);
    const input = createAppInput.parse(raw);
    const key = mintPublisherKey();
    const scoped = await forPrincipal(this.database, principal);
    await scoped.transaction(async (tx) => {
      const exists = await tx.query("SELECT 1 FROM ap_apps WHERE id=$1", [
        input.id,
      ]);
      if (exists.rows.length)
        throw new AppError(409, "app_exists", "An app with this ID exists.");
      await tx.query(
        `INSERT INTO ap_apps(id,name,origin,grant_policy,publisher_key_hash,publisher_key_prefix,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.id,
          input.name,
          input.origin,
          input.grant_policy,
          key.keyHash,
          key.prefix,
          principal.id,
        ],
      );
    });
    return {
      app: { ...input, active_release: null },
      // Shown once. It can publish this app's releases and nothing else.
      publisher_key: key.key,
      publish_url: `/api/platform/v1/apps/${input.id}/releases`,
      jwks_url: `/api/platform/v1/jwks/${principal.tenantId}`,
      audience: `astropath-app:${input.id}`,
    };
  }

  async update(principal: Principal, id: string, raw: unknown) {
    requireOwner(principal);
    const input = updateAppInput.parse(raw);
    const scoped = await forPrincipal(this.database, principal);
    const updated = await scoped.query<{ id: string }>(
      `UPDATE ap_apps SET name=coalesce($2,name),origin=coalesce($3,origin),grant_policy=coalesce($4,grant_policy),
         disabled_at=CASE WHEN $5::boolean IS NULL THEN disabled_at WHEN $5 THEN coalesce(disabled_at,now()) ELSE NULL END,
         disabled_operations=coalesce($6,disabled_operations),updated_at=now()
       WHERE id=$1 RETURNING id`,
      [
        id,
        input.name ?? null,
        input.origin ?? null,
        input.grant_policy ?? null,
        input.disabled ?? null,
        input.disabled_operations ?? null,
      ],
    );
    if (!updated.rows.length)
      throw new AppError(404, "not_found", "App not found.");
    return this.list(principal);
  }

  async rotateKey(principal: Principal, id: string) {
    requireOwner(principal);
    const key = mintPublisherKey();
    const scoped = await forPrincipal(this.database, principal);
    const updated = await scoped.query(
      "UPDATE ap_apps SET publisher_key_hash=$2,publisher_key_prefix=$3,updated_at=now() WHERE id=$1 RETURNING id",
      [id, key.keyHash, key.prefix],
    );
    if (!updated.rows.length)
      throw new AppError(404, "not_found", "App not found.");
    return { publisher_key: key.key };
  }

  async setGrant(principal: Principal, id: string, raw: unknown) {
    requireOwner(principal);
    const input = setGrantInput.parse(raw);
    const scoped = await forPrincipal(this.database, principal);
    await scoped.transaction(async (tx) => {
      const app = await tx.query("SELECT 1 FROM ap_apps WHERE id=$1", [id]);
      if (!app.rows.length)
        throw new AppError(404, "not_found", "App not found.");
      if (input.mode === null)
        await tx.query(
          "DELETE FROM ap_app_grants WHERE app_id=$1 AND connection_id=$2",
          [id, input.connection_id],
        );
      else
        await tx.query(
          `INSERT INTO ap_app_grants(app_id,connection_id,mode,set_by) VALUES($1,$2,$3,$4)
           ON CONFLICT(tenant_id,app_id,connection_id) DO UPDATE SET mode=excluded.mode,set_by=excluded.set_by,set_at=now()`,
          [id, input.connection_id, input.mode, principal.id],
        );
    });
    return this.list(principal);
  }
}
export const apps = new AppStore();

// ---------------------------------------------------------------- publish

export const publishInput = z
  .object({
    manifest: z.unknown(),
    expected_catalog_revision: z
      .string()
      .regex(/^cat_[a-f0-9]{32}$/)
      .optional(),
  })
  .strict();

export interface Publisher {
  tenantId: string;
  app: string;
}
export async function publisherFor(request: Request): Promise<Publisher> {
  const match = /^Bearer (\S+)$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match || !PUBLISHER_KEY.test(match[1]))
    throw new PlatformError(
      "UNAUTHENTICATED",
      "Use Authorization: Bearer <publisher key>.",
    );
  const row = (
    await systemDb.query<{ tenant_id: string; id: string }>(
      "SELECT tenant_id,id FROM ap_apps WHERE publisher_key_hash=$1",
      [hash(match[1])],
    )
  ).rows[0];
  if (!row)
    throw new PlatformError(
      "UNAUTHENTICATED",
      "This publisher key is invalid or was rotated.",
    );
  return { tenantId: row.tenant_id, app: row.id };
}

export type Probe = (
  origin: string,
) => Promise<{ app?: unknown; release?: unknown } | null>;
// Before a release goes live, ask the deployed app which release it serves,
// so the catalog never points at code that is not running.
export const probeApp: Probe = async (appOrigin) => {
  try {
    const response = await fetch(
      new URL("/.well-known/astropath-app", appOrigin),
      {
        redirect: "manual",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as { app?: unknown; release?: unknown };
  } catch {
    return null;
  }
};

export async function publishRelease(
  publisher: Publisher,
  raw: unknown,
  options: { database?: Database; probe?: Probe } = {},
) {
  const input = publishInput.parse(raw);
  const { manifest, contracts, digest } = validateManifest(
    input.manifest,
    publisher.app,
  );
  const directory = options.database ?? db;
  const scoped = await directory.forTenant!(publisher.tenantId);
  const app = (
    await scoped.query<{ origin: string; disabled_at: string | null }>(
      "SELECT origin,disabled_at FROM ap_apps WHERE id=$1",
      [publisher.app],
    )
  ).rows[0];
  if (!app || app.disabled_at)
    throw new PlatformError(
      "FORBIDDEN",
      "This app is disabled; the workspace owner can re-enable it.",
    );
  const served = await (options.probe ?? probeApp)(app.origin);
  if (
    !served ||
    served.app !== manifest.app ||
    served.release !== manifest.release
  )
    throw new PlatformError(
      "DEPENDENCY_UNAVAILABLE",
      `Deploy first: ${app.origin}/.well-known/astropath-app must report {"app":"${manifest.app}","release":"${manifest.release}"} before this release can be published.`,
      "none",
      "same_key",
    );
  return scoped.transaction(async (tx) => {
    const locked = (
      await tx.query<{ active_release: string | null }>(
        "SELECT active_release FROM ap_apps WHERE id=$1 FOR UPDATE",
        [publisher.app],
      )
    ).rows[0];
    const before = await loadCatalog(tx);
    if (
      input.expected_catalog_revision &&
      input.expected_catalog_revision !== before.revision
    )
      throw new PlatformError(
        "CATALOG_CONFLICT",
        `The catalog changed (now ${before.revision}). Rebase and publish again.`,
        "none",
        "rediscover",
        { catalog_revision: before.revision },
      );
    const existing = (
      await tx.query<{ digest: string }>(
        "SELECT digest FROM ap_app_releases WHERE app_id=$1 AND release=$2",
        [publisher.app, manifest.release],
      )
    ).rows[0];
    if (existing && existing.digest !== digest)
      throw new PlatformError(
        "RELEASE_CONFLICT",
        `Release ${manifest.release} was already published with different content. Give changed content a new release ID.`,
      );
    // An exact operation version is an immutable contract.
    for (const contract of contracts) {
      const current = before.byKey.get(
        `${contract.operation}@${contract.version}`,
      );
      if (
        current &&
        current.app === publisher.app &&
        current.contractHash !== contractHash(contract)
      )
        throw new PlatformError(
          "INVALID_MANIFEST",
          `${contract.operation}@${contract.version} is already published with a different contract. Change its version.`,
        );
    }
    if (!existing)
      await tx.query(
        "INSERT INTO ap_app_releases(app_id,release,digest,manifest,published_by) VALUES($1,$2,$3,$4,$5)",
        [
          publisher.app,
          manifest.release,
          digest,
          canonicalJson(manifest),
          `publisher:${publisher.app}`,
        ],
      );
    await tx.query(
      "UPDATE ap_apps SET active_release=$2,updated_at=now() WHERE id=$1",
      [publisher.app, manifest.release],
    );
    const after = await loadCatalog(tx);
    return {
      app: publisher.app,
      release: manifest.release,
      digest,
      operations: contracts.length,
      previous_release: locked.active_release,
      catalog_revision: after.revision,
      replayed: !!existing && locked.active_release === manifest.release,
    };
  });
}

export async function jwksFor(tenantId: string, database: Database = db) {
  const id = z.uuid().safeParse(tenantId);
  if (!id.success) throw new AppError(404, "not_found", "Not found.");
  const scoped = await database.forTenant!(id.data);
  return scoped.transaction((tx) => publicKeys(tx));
}
