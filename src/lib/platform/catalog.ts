import type { Queryable } from "../db";
import type { Principal } from "../policy";
import {
  canonicalJson,
  contractHash,
  contractOf,
  sha256,
  type AppManifest,
  type Contract,
} from "./contracts";
import { CORE_OPERATIONS, type LocalOperation } from "./core";
import { PlatformError } from "./errors";

export type Binding =
  | { kind: "local"; operation: LocalOperation }
  | {
      kind: "remote";
      origin: string;
      path: string;
      timeoutMs: number;
      deduplicates: boolean;
    };
export interface Entry {
  key: string;
  contract: Contract;
  contractHash: string;
  app: string;
  release: string;
  binding: Binding;
}
export interface AppRow {
  id: string;
  name: string;
  origin: string;
  grant_policy: "auto" | "explicit";
  active_release: string | null;
  disabled_at: string | null;
  disabled_operations: string[];
}
export interface Catalog {
  revision: string;
  entries: Entry[];
  byKey: Map<string, Entry>;
  apps: Map<string, AppRow & { description: string; ui_url: string | null }>;
}

// Platform operations are served by the dispatcher itself; they register
// here so the catalog, grants and discovery treat them like any other.
const platformOperations: LocalOperation[] = [];
let builtInGeneration = 0;
export function registerPlatformOperation(operation: LocalOperation) {
  builtInGeneration++;
  const key = `${operation.contract.operation}@${operation.contract.version}`;
  const index = platformOperations.findIndex(
    (op) => `${op.contract.operation}@${op.contract.version}` === key,
  );
  if (index >= 0) platformOperations[index] = operation;
  else platformOperations.push(operation);
}
// The release of built-in operations is the contract set itself, so an
// Astropath deploy that changes a core contract yields a new revision.
function builtIn(): Entry[] {
  return [...CORE_OPERATIONS, ...platformOperations].map((operation) => {
    const hash = contractHash(operation.contract);
    return {
      key: `${operation.contract.operation}@${operation.contract.version}`,
      contract: operation.contract,
      contractHash: hash,
      app: operation.contract.app,
      release: "builtin",
      binding: { kind: "local", operation },
    };
  });
}

// Releases are immutable, so a parsed manifest can be cached forever.
const manifests = new Map<string, AppManifest>();
const knownRevisions = new Set<string>();
// A catalog is a pure function of the app rows and the built-in set, so the
// last one built for a tenant is reused until either changes. Building one
// hashes every contract, which is too much to repeat on each request once an
// app publishes thousands of operations. Callers must not mutate a catalog.
const catalogs = new Map<string, { fingerprint: string; catalog: Catalog }>();

export async function loadCatalog(tx: Queryable): Promise<Catalog> {
  const apps = (
    await tx.query<AppRow>(
      "SELECT id,name,origin,grant_policy,active_release,disabled_at,disabled_operations FROM ap_apps ORDER BY id",
    )
  ).rows;
  const fingerprint = `${builtInGeneration}:${JSON.stringify(apps)}`;
  const tenant = tx.tenantId ?? "";
  const cached = catalogs.get(tenant);
  if (cached?.fingerprint === fingerprint) return cached.catalog;
  // A release row that cannot be read leaves its app out; never cache that.
  let complete = true;
  const entries = builtIn();
  const appInfo: Catalog["apps"] = new Map();
  for (const app of apps) {
    if (!app.active_release) {
      appInfo.set(app.id, { ...app, description: "", ui_url: null });
      continue;
    }
    const cacheKey = `${tx.tenantId}:${app.id}@${app.active_release}`;
    let manifest = manifests.get(cacheKey);
    if (!manifest) {
      const row = (
        await tx.query<{ manifest: AppManifest | string }>(
          "SELECT manifest FROM ap_app_releases WHERE app_id=$1 AND release=$2",
          [app.id, app.active_release],
        )
      ).rows[0];
      if (!row) {
        complete = false;
        continue;
      }
      manifest =
        typeof row.manifest === "string"
          ? (JSON.parse(row.manifest) as AppManifest)
          : row.manifest;
      manifests.set(cacheKey, manifest);
    }
    appInfo.set(app.id, {
      ...app,
      description: manifest.description,
      ui_url: manifest.ui?.url ?? null,
    });
    // Disabling blocks an app or operation everywhere, immediately.
    if (app.disabled_at) continue;
    const disabled = new Set(app.disabled_operations);
    for (const op of manifest.operations) {
      if (disabled.has(op.name)) continue;
      const contract = contractOf(app.id, op, manifest.ui?.url ?? null);
      entries.push({
        key: `${op.name}@${op.version}`,
        contract,
        contractHash: contractHash(contract),
        app: app.id,
        release: manifest.release,
        binding: {
          kind: "remote",
          origin: app.origin,
          path: op.route.path,
          timeoutMs: op.timeout_ms,
          deduplicates: op.deduplicates,
        },
      });
    }
  }
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const snapshot = Object.fromEntries(
    entries.map((entry) => [
      entry.key,
      {
        app: entry.app,
        release: entry.release,
        contract_hash: entry.contractHash,
      },
    ]),
  );
  const revision = `cat_${sha256(canonicalJson(snapshot)).slice(0, 32)}`;
  const known = `${tx.tenantId}:${revision}`;
  if (!knownRevisions.has(known)) {
    await tx.query(
      "INSERT INTO ap_catalogs(revision,entries) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [revision, JSON.stringify(snapshot)],
    );
    knownRevisions.add(known);
  }
  const catalog: Catalog = {
    revision,
    entries,
    byKey: new Map(entries.map((entry) => [entry.key, entry])),
    apps: appInfo,
  };
  if (complete) catalogs.set(tenant, { fingerprint, catalog });
  return catalog;
}

// Pinning a revision pins contracts, never authorization. An older revision
// is honoured while the exact operation version is still served with the
// same contract; otherwise the call fails explicitly and never falls forward.
export async function resolve(
  tx: Queryable,
  catalog: Catalog,
  revision: string | undefined,
  operation: string,
  version: string,
): Promise<Entry> {
  const key = `${operation}@${version}`;
  const current = catalog.byKey.get(key);
  if (!revision || revision === catalog.revision) {
    if (!current)
      throw new PlatformError(
        "NOT_AVAILABLE",
        "No such operation version is available to you.",
        "none",
        "rediscover",
      );
    return current;
  }
  const row = (
    await tx.query<{
      entries: Record<string, { contract_hash: string }> | string;
    }>("SELECT entries FROM ap_catalogs WHERE revision=$1", [revision])
  ).rows[0];
  if (!row)
    throw new PlatformError(
      "CATALOG_EXPIRED",
      "That catalog revision is unknown or expired. Discover again.",
      "none",
      "rediscover",
    );
  const entries =
    typeof row.entries === "string"
      ? (JSON.parse(row.entries) as Record<string, { contract_hash: string }>)
      : row.entries;
  const pinned = entries[key];
  if (!pinned)
    throw new PlatformError(
      "NOT_AVAILABLE",
      "No such operation version is available to you.",
      "none",
      "rediscover",
    );
  if (!current)
    throw new PlatformError(
      "OPERATION_RETIRED",
      `${key} is no longer served. Discover again and choose a supported version.`,
      "none",
      "rediscover",
    );
  if (current.contractHash !== pinned.contract_hash)
    throw new PlatformError(
      "CATALOG_EXPIRED",
      `${key} changed since that catalog revision. Discover again.`,
      "none",
      "rediscover",
    );
  return current;
}

export type Grants = Map<string, "include" | "exclude">;
export async function grantsFor(tx: Queryable, principal: Principal) {
  const rows = (
    await tx.query<{ app_id: string; mode: "include" | "exclude" }>(
      "SELECT app_id,mode FROM ap_app_grants WHERE connection_id=$1",
      [principal.id],
    )
  ).rows;
  return new Map(rows.map((row) => [row.app_id, row.mode])) as Grants;
}
const isOwner = (principal: Principal) => principal.owner && !!principal.userId;

// Whether this caller may see and call an entry. Hidden and absent are
// indistinguishable to the caller.
export function permitted(
  principal: Principal,
  catalog: Catalog,
  grants: Grants,
  entry: Entry,
) {
  const scope =
    entry.contract.effect === "read" ? "astropath:read" : "astropath:write";
  if (!principal.scopes.includes(scope)) return false;
  if (entry.binding.kind === "local") return true;
  if (isOwner(principal)) return true;
  const app = catalog.apps.get(entry.app);
  if (!app) return false;
  const grant = grants.get(entry.app);
  if (grant === "exclude") return false;
  if (app.grant_policy === "explicit" || entry.contract.sensitive)
    return grant === "include";
  return true;
}
