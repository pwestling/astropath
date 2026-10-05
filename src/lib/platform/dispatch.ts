import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, forPrincipal, type Database, type Queryable } from "../db";
import { requireSpace, type Principal } from "../policy";
import { appUrl } from "../config";
import {
  argumentsHash,
  canonicalJson,
  schemaErrors,
  sha256,
  validator,
  type Contract,
} from "./contracts";
import {
  grantsFor,
  loadCatalog,
  permitted,
  registerPlatformOperation,
  resolve,
  type Catalog,
  type Entry,
  type Grants,
} from "./catalog";
import {
  PlatformError,
  platformErrorBody,
  type EffectState,
  type PlatformErrorBody,
} from "./errors";
import { delegatedToken } from "./signing";
// Registers platform.get_execution, so every entry point sees one catalog.
import "./execute";

export type ReceiptStatus =
  "succeeded" | "accepted" | "running" | "failed" | "unknown";
export interface Receipt {
  request_id: string;
  receipt_id: string | null;
  catalog_revision: string;
  operation: string;
  version: string;
  status: ReceiptStatus;
  result: unknown;
  error: PlatformErrorBody | null;
  replayed: boolean;
}

const spaceSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
const revision = z.string().regex(/^cat_[a-f0-9]{32}$/);
const idempotencyKey = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[\x21-\x7e]+$/, "Use printable ASCII without spaces.");

// The invocation chooses one space. With several eligible spaces, general is
// the default when the caller can use it.
function chooseSpace(principal: Principal, requested?: string) {
  if (requested) {
    requireSpace(principal, requested);
    return requested;
  }
  if (!principal.spaces || principal.spaces.includes("general"))
    return "general";
  if (principal.spaces.length === 1) return principal.spaces[0];
  throw new PlatformError(
    "INVALID_ARGUMENTS",
    "Choose a space: this connection can use several.",
  );
}
async function context(database: Database, principal: Principal) {
  const scoped = await forPrincipal(database, principal);
  return scoped.transaction(async (tx) => ({
    catalog: await loadCatalog(tx),
    grants: await grantsFor(tx, principal),
  }));
}

// ---------------------------------------------------------------- discover

export const discoverInput = z
  .object({
    query: z.string().trim().max(300).nullish(),
    namespace: z.string().max(40).nullish(),
    operation: z.string().max(105).nullish(),
    version: z.string().max(64).nullish(),
    catalog_revision: revision.nullish(),
    space: spaceSlug.nullish(),
    detail: z.enum(["summary", "full"]).nullish(),
    limit: z.number().int().min(1).max(20).nullish(),
    cursor: z.string().max(500).nullish(),
  })
  .strict();
const DISCOVERY_LIMIT = 128 * 1024;

const versionParts = (v: string) =>
  v
    .split("-")[0]
    .split(".")
    .map((part) => Number(part));
function compareVersions(a: string, b: string) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  // A prerelease sorts before its release.
  return (a.includes("-") ? 0 : 1) - (b.includes("-") ? 0 : 1);
}
// Highest non-deprecated version per operation name; a deprecated-only
// operation still appears, marked deprecated.
function latest(entries: Entry[]) {
  const byName = new Map<string, Entry>();
  for (const entry of entries) {
    const best = byName.get(entry.contract.operation);
    const better =
      !best ||
      (!!best.contract.deprecated && !entry.contract.deprecated) ||
      (!!best.contract.deprecated === !!entry.contract.deprecated &&
        compareVersions(entry.contract.version, best.contract.version) > 0);
    if (better) byName.set(entry.contract.operation, entry);
  }
  return [...byName.values()];
}
function selectVersion(entries: Entry[], version?: string | null) {
  if (!version || version === "latest") return latest(entries);
  if (/^\d+$/.test(version))
    return latest(
      entries.filter(
        (entry) => entry.contract.version.split(".")[0] === version,
      ),
    );
  return entries.filter((entry) => entry.contract.version === version);
}
const tokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
function score(entry: Entry, query: string) {
  const q = query.toLowerCase();
  const c = entry.contract;
  if (c.operation === q || c.operation.split(".")[1] === q) return 1000;
  let total = 0;
  const name = tokens(c.operation.replace(".", " "));
  const summary = tokens(c.summary);
  const description = tokens(c.description);
  for (const token of tokens(query)) {
    if (name.includes(token)) total += 10;
    else if (name.some((n) => n.startsWith(token))) total += 6;
    if (summary.includes(token)) total += 4;
    if (description.includes(token)) total += 1;
  }
  return total;
}
const summaryOf = (contract: Contract) => ({
  operation: contract.operation,
  version: contract.version,
  summary: contract.summary,
  effect: contract.effect,
  execution: contract.execution,
  idempotency: contract.idempotency,
  sensitive: contract.sensitive,
  deprecated: contract.deprecated,
  ui_url: contract.ui_url,
});
function encodeCursor(offset: number, fingerprint: string) {
  return Buffer.from(JSON.stringify({ o: offset, f: fingerprint })).toString(
    "base64url",
  );
}
function decodeCursor(cursor: string, fingerprint: string) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      o: number;
      f: string;
    };
    if (parsed.f === fingerprint && Number.isInteger(parsed.o) && parsed.o >= 0)
      return parsed.o;
  } catch {}
  throw new PlatformError(
    "CURSOR_INVALID",
    "This cursor does not match the request or catalog. Start discovery again.",
    "none",
    "rediscover",
  );
}

export async function discover(
  principal: Principal,
  raw: unknown,
  database: Database = db,
) {
  const input = discoverInput.parse(raw ?? {});
  chooseSpace(principal, input.space ?? undefined);
  const { catalog, grants } = await context(database, principal);
  if (input.catalog_revision && input.catalog_revision !== catalog.revision) {
    // Discovery always answers from the current catalog; a stale pin is
    // reported so the caller re-selects exact versions.
    const scoped = await forPrincipal(database, principal);
    const known = await scoped.query(
      "SELECT 1 FROM ap_catalogs WHERE revision=$1",
      [input.catalog_revision],
    );
    if (!known.rows.length)
      throw new PlatformError(
        "CATALOG_EXPIRED",
        "That catalog revision is unknown or expired. Discover without it.",
        "none",
        "rediscover",
      );
  }
  const visible = catalog.entries.filter((entry) =>
    permitted(principal, catalog, grants, entry),
  );
  const detail = input.detail ?? "summary";
  const limit = input.limit ?? 10;
  const fingerprint = sha256(
    canonicalJson({
      ...input,
      cursor: null,
      revision: catalog.revision,
      principal: principal.id,
      grants: [...grants.entries()].sort(),
    }),
  );
  const base = {
    catalog_revision: catalog.revision,
    space: chooseSpace(principal, input.space ?? undefined),
  };
  if (!input.query && !input.namespace && !input.operation) {
    const apps = new Map<
      string,
      { app: string; operations: number; groups: Map<string, number> }
    >();
    for (const entry of latest(visible)) {
      const app = apps.get(entry.app) ?? {
        app: entry.app,
        operations: 0,
        groups: new Map<string, number>(),
      };
      app.operations++;
      if (entry.group)
        app.groups.set(entry.group, (app.groups.get(entry.group) ?? 0) + 1);
      apps.set(entry.app, app);
    }
    return {
      ...base,
      apps: [...apps.values()].map(({ groups, ...app }) => {
        const info = catalog.apps.get(app.app);
        return {
          ...app,
          // Pass a group's namespace to list or search only that group.
          ...(groups.size
            ? {
                groups: [...groups.entries()]
                  .sort()
                  .map(([id, operations]) => ({
                    namespace: `${app.app}.${id}`,
                    name: info?.groups.get(id)?.name ?? id,
                    description: info?.groups.get(id)?.description ?? "",
                    operations,
                  })),
              }
            : {}),
          name: info?.name ?? (app.app === "core" ? "Astropath" : app.app),
          description:
            info?.description ??
            (app.app === "core"
              ? "Memory log, board, agents and skills."
              : "Receipts and platform inspection."),
          ui_url: info?.ui_url ?? null,
        };
      }),
      hint: "Pass namespace to list an app's operations (or a group's, such as app.group, alone or with query), query to search, or operation for one contract in full.",
      results: [],
      next_cursor: null,
    };
  }
  // A namespace is an app, or one group within it written app.group.
  const [scopeApp, scopeGroup] = input.namespace?.split(".", 2) ?? [];
  const inScope = (entry: Entry) =>
    !scopeApp ||
    (entry.app === scopeApp && (!scopeGroup || entry.group === scopeGroup));
  let candidates: Entry[];
  if (input.operation) {
    candidates = selectVersion(
      visible.filter((entry) => entry.contract.operation === input.operation),
      input.version,
    );
    if (
      input.namespace &&
      (input.operation.split(".")[0] !== scopeApp ||
        (candidates.length && !candidates.every(inScope)))
    )
      throw new PlatformError(
        "INVALID_ARGUMENTS",
        "operation is outside the given namespace.",
      );
  } else {
    if (input.version)
      throw new PlatformError(
        "INVALID_ARGUMENTS",
        "version can only be given with operation.",
      );
    candidates = latest(visible.filter(inScope));
    if (input.query) {
      const scored = candidates
        .map((entry) => ({ entry, score: score(entry, input.query!) }))
        .filter((item) => item.score > 0);
      scored.sort(
        (a, b) =>
          b.score - a.score ||
          (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : 0),
      );
      candidates = scored.map((item) => item.entry);
    }
  }
  const offset = input.cursor ? decodeCursor(input.cursor, fingerprint) : 0;
  const results: unknown[] = [];
  let size = 512;
  let index = offset;
  // An exact lookup always returns the whole contract, whatever detail says.
  const full = detail === "full" || !!input.operation;
  for (; index < candidates.length && results.length < limit; index++) {
    const item = full
      ? candidates[index].contract
      : summaryOf(candidates[index].contract);
    const itemSize = Buffer.byteLength(JSON.stringify(item));
    if (results.length && size + itemSize > DISCOVERY_LIMIT) break;
    size += itemSize;
    results.push(item);
  }
  return {
    ...base,
    results,
    next_cursor:
      index < candidates.length ? encodeCursor(index, fingerprint) : null,
  };
}

// ------------------------------------------------------------------ invoke

export const invokeInput = z
  .object({
    catalog_revision: revision.nullish(),
    operation: z.string().min(1).max(105),
    version: z.string().min(1).max(64),
    space: spaceSlug.nullish(),
    arguments: z.record(z.string(), z.unknown()).default({}),
    idempotency_key: idempotencyKey.nullish(),
  })
  .strict();

interface InvocationRow {
  id: string;
  args_hash: string;
  status: ReceiptStatus;
  effect_state: EffectState;
  encrypted_result: string | null;
  error: PlatformErrorBody | string | null;
  attempt: number;
  lease_expired: boolean;
  catalog_revision: string;
  operation: string;
  version: string;
  principal_id: string;
}
const parseError = (value: InvocationRow["error"]) =>
  typeof value === "string" ? (JSON.parse(value) as PlatformErrorBody) : value;

function receiptFrom(
  tx: Queryable,
  row: InvocationRow,
  requestId: string,
  replayed: boolean,
): Receipt {
  return {
    request_id: requestId,
    receipt_id: row.id,
    catalog_revision: row.catalog_revision,
    operation: row.operation,
    version: row.version,
    status: row.status,
    result: row.encrypted_result
      ? tx.cipher!.decrypt(`invocation:${row.id}:result`, row.encrypted_result)
      : null,
    error: parseError(row.error),
    replayed,
  };
}

interface Outcome {
  status: ReceiptStatus;
  effect: EffectState;
  result: unknown;
  error: PlatformErrorBody | null;
}
const failure = (error: PlatformError): Outcome => ({
  status: error.effectState === "unknown" ? "unknown" : "failed",
  effect: error.effectState,
  result: null,
  error: error.body(),
});

const RESPONSE_LIMIT = 1024 * 1024;
async function readLimited(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("response too large");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

// Forward one call to an app. Astropath picks the destination; the caller
// supplies only validated arguments. Credentials never pass through.
async function forward(
  database: Database,
  principal: Principal,
  entry: Entry,
  binding: Extract<Entry["binding"], { kind: "remote" }>,
  call: {
    invocationId: string;
    space: string;
    args: Record<string, unknown>;
    argsHash: string;
    idempotencyDigest: string | null;
  },
): Promise<Outcome> {
  const mutating = entry.contract.effect !== "read";
  const scoped = await forPrincipal(database, principal);
  const token = await scoped.transaction((tx) =>
    delegatedToken(tx, {
      issuer: appUrl(),
      app: entry.app,
      subject: principal.id,
      name: principal.name,
      space: call.space,
      operation: entry.contract.operation,
      version: entry.contract.version,
      release: entry.release,
      invocationId: call.invocationId,
      argumentsSha256: call.argsHash,
      idempotencyDigest: call.idempotencyDigest,
      lifetimeSeconds: Math.ceil(binding.timeoutMs / 1000) + 5,
    }),
  );
  const origin = new URL(binding.origin);
  const url = new URL(binding.path, origin);
  if (url.origin !== origin.origin)
    throw new PlatformError(
      "DEPENDENCY_UNAVAILABLE",
      "The app's route is misconfigured.",
    );
  const unknownAfterDispatch = (message: string) =>
    failure(
      mutating
        ? new PlatformError(
            "OUTCOME_UNKNOWN",
            message,
            "unknown",
            binding.deduplicates ? "same_key" : "reconcile",
          )
        : new PlatformError(
            "DEPENDENCY_UNAVAILABLE",
            message,
            "none",
            "same_key",
          ),
    );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Astropath-Invocation-Id": call.invocationId,
        "Astropath-Operation": entry.key,
        ...(call.idempotencyDigest
          ? { "Idempotency-Key": call.idempotencyDigest }
          : {}),
      },
      body: JSON.stringify(call.args),
      signal: AbortSignal.timeout(binding.timeoutMs),
    });
  } catch (error) {
    // Connection refusals happen before the app could act.
    const refused =
      error instanceof TypeError &&
      /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(error.cause ?? ""));
    if (refused)
      return failure(
        new PlatformError(
          "DEPENDENCY_UNAVAILABLE",
          `The ${entry.app} app is unreachable.`,
          "none",
          "same_key",
        ),
      );
    return unknownAfterDispatch(`The ${entry.app} app did not answer in time.`);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return failure(
      new PlatformError(
        "DEPENDENCY_UNAVAILABLE",
        "The app answered with a redirect, which Astropath does not follow.",
      ),
    );
  }
  let text: string;
  let body: unknown;
  try {
    text = await readLimited(response);
    body = text ? JSON.parse(text) : null;
  } catch {
    return response.ok
      ? failure(
          new PlatformError(
            "OUTPUT_VALIDATION_FAILED",
            "The app's response was not valid JSON within 1 MiB.",
            mutating ? "committed" : "none",
          ),
        )
      : unknownAfterDispatch(`The ${entry.app} app failed.`);
  }
  if (response.ok) {
    const validate = validator(entry.contract.output_schema);
    if (!validate(body))
      return failure(
        new PlatformError(
          "OUTPUT_VALIDATION_FAILED",
          `The app's result does not match its contract: ${schemaErrors(validate)}`,
          mutating ? "committed" : "none",
          mutating ? "reconcile" : "do_not_retry",
        ),
      );
    return {
      status:
        response.status === 202 && entry.contract.execution === "async"
          ? "accepted"
          : "succeeded",
      effect: mutating ? "committed" : "none",
      result: body,
      error: null,
    };
  }
  const appError = (
    body && typeof body === "object" && "error" in body
      ? (body as { error: unknown }).error
      : null
  ) as { code?: unknown; message?: unknown; details?: unknown } | null;
  const code =
    typeof appError?.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,63}$/.test(appError.code)
      ? appError.code
      : response.status === 429
        ? "RATE_LIMITED"
        : "APP_ERROR";
  const message =
    typeof appError?.message === "string"
      ? appError.message.slice(0, 1000)
      : `The ${entry.app} app returned HTTP ${response.status}.`;
  if (response.status >= 500) return unknownAfterDispatch(message);
  // A 4xx means the app rejected the call before acting.
  return failure(
    new PlatformError(
      code,
      message,
      "none",
      response.status === 429 ? "same_key" : "do_not_retry",
      appError?.details && typeof appError.details === "object"
        ? (appError.details as Record<string, unknown>)
        : undefined,
    ),
  );
}

async function run(
  database: Database,
  principal: Principal,
  entry: Entry,
  call: {
    invocationId: string | null;
    requestId: string;
    space: string;
    args: Record<string, unknown>;
    argsHash: string;
    idempotencyDigest: string | null;
  },
): Promise<Outcome> {
  const binding = entry.binding;
  if (binding.kind === "remote")
    return forward(database, principal, entry, binding, {
      ...call,
      invocationId: call.invocationId ?? call.requestId,
    });
  try {
    const result = await binding.operation.handler(principal, call.args, {
      invocationId: call.invocationId,
      idempotencyKey: call.invocationId ? `inv:${call.invocationId}` : null,
      space: call.space,
    });
    return {
      status: "succeeded",
      effect: entry.contract.effect === "read" ? "none" : "committed",
      result: result ?? null,
      error: null,
    };
  } catch (error) {
    return {
      status: "failed",
      effect: "none",
      result: null,
      error: platformErrorBody(error),
    };
  }
}

function validateArguments(entry: Entry, args: Record<string, unknown>) {
  if (entry.binding.kind === "local") {
    const parsed = entry.binding.operation.input.safeParse(args);
    if (!parsed.success)
      throw new PlatformError(
        "INVALID_ARGUMENTS",
        parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join(".") || "/"}: ${issue.message}`)
          .join("; "),
      );
    return;
  }
  const validate = validator(entry.contract.input_schema);
  if (!validate(args))
    throw new PlatformError(
      "INVALID_ARGUMENTS",
      `arguments do not match the contract: ${schemaErrors(validate)}`,
    );
}

const LEASE_GRACE_MS = 30000;
const leaseMs = (entry: Entry) =>
  (entry.binding.kind === "remote" ? entry.binding.timeoutMs : 30000) +
  LEASE_GRACE_MS;
// Built-in writes dedupe in their stores by the derived invocation key.
const deduplicates = (entry: Entry) =>
  entry.binding.kind === "local" || entry.binding.deduplicates;

export async function invoke(
  principal: Principal,
  raw: unknown,
  database: Database = db,
): Promise<Receipt> {
  const input = invokeInput.parse(raw);
  const requestId = `req_${randomUUID()}`;
  const space = chooseSpace(principal, input.space ?? undefined);
  const scoped = await forPrincipal(database, principal);
  const { catalog, grants, entry } = await scoped.transaction(async (tx) => {
    const catalog = await loadCatalog(tx);
    const grants = await grantsFor(tx, principal);
    const entry = await resolve(
      tx,
      catalog,
      input.catalog_revision ?? undefined,
      input.operation,
      input.version,
    );
    return { catalog, grants, entry };
  });
  authorize(principal, catalog, grants, entry);
  const args = input.arguments;
  validateArguments(entry, args);
  const argsHash = argumentsHash(args);
  const revisionUsed = input.catalog_revision ?? catalog.revision;
  const base = {
    request_id: requestId,
    catalog_revision: revisionUsed,
    operation: entry.contract.operation,
    version: entry.contract.version,
  };
  if (entry.contract.effect === "read") {
    const outcome = await run(database, principal, entry, {
      invocationId: null,
      requestId,
      space,
      args,
      argsHash,
      idempotencyDigest: null,
    });
    return {
      ...base,
      receipt_id: null,
      status: outcome.status,
      result: outcome.result,
      error: outcome.error,
      replayed: false,
    };
  }
  if (!input.idempotency_key)
    throw new PlatformError(
      "INVALID_ARGUMENTS",
      "This operation changes state: pass an idempotency_key, and reuse it only to retry this exact call.",
    );
  const key = input.idempotency_key;
  const idempotencyDigest = sha256(
    canonicalJson([
      scoped.tenantId ?? principal.tenantId ?? "",
      principal.id,
      space,
      entry.contract.operation,
      entry.contract.version,
      key,
    ]),
  );
  // Reserve the logical invocation before any effect can begin.
  const reservation = await scoped.transaction(async (tx) => {
    const id = randomUUID();
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO ap_invocations(id,principal_id,space,operation,version,catalog_revision,app_id,app_release,idempotency_key,args_hash,status,encrypted_arguments,lease_until,principal_name)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running',$11,now()+make_interval(secs=>$12),$13)
       ON CONFLICT (tenant_id,principal_id,space,operation,version,idempotency_key) DO NOTHING RETURNING id`,
      [
        id,
        principal.id,
        space,
        entry.contract.operation,
        entry.contract.version,
        revisionUsed,
        entry.app,
        entry.release,
        key,
        argsHash,
        tx.cipher!.encrypt(`invocation:${id}:arguments`, args),
        leaseMs(entry) / 1000,
        principal.name,
      ],
    );
    if (inserted.rows.length)
      return { kind: "dispatch" as const, id, attempt: 1 };
    const existing = (
      await tx.query<InvocationRow>(
        `SELECT id,args_hash,status,effect_state,encrypted_result,error,attempt,catalog_revision,operation,version,principal_id,
          (lease_until IS NULL OR lease_until < now()) AS lease_expired
         FROM ap_invocations WHERE principal_id=$1 AND space=$2 AND operation=$3 AND version=$4 AND idempotency_key=$5 FOR UPDATE`,
        [
          principal.id,
          space,
          entry.contract.operation,
          entry.contract.version,
          key,
        ],
      )
    ).rows[0];
    if (existing.args_hash !== argsHash)
      throw new PlatformError(
        "IDEMPOTENCY_CONFLICT",
        "This idempotency_key was already used for a different request. Use a new key for a new action.",
      );
    const settled =
      existing.status === "succeeded" ||
      existing.status === "accepted" ||
      existing.status === "failed" ||
      (existing.status === "running" && !existing.lease_expired);
    if (settled || !deduplicates(entry))
      return {
        kind: "replay" as const,
        receipt: unsettled(receiptFrom(tx, existing, requestId, true)),
      };
    // Running past its lease, or unknown, and the handler dedupes by this
    // key: a fenced new attempt can safely finish the same invocation.
    const taken = await tx.query<{ attempt: number }>(
      `UPDATE ap_invocations SET attempt=attempt+1,status='running',lease_until=now()+make_interval(secs=>$3)
       WHERE id=$1 AND attempt=$2 RETURNING attempt`,
      [existing.id, existing.attempt, leaseMs(entry) / 1000],
    );
    return {
      kind: "dispatch" as const,
      id: existing.id,
      attempt: taken.rows[0].attempt,
    };
  });
  if (reservation.kind === "replay") return reservation.receipt;
  const outcome = await run(database, principal, entry, {
    invocationId: reservation.id,
    requestId,
    space,
    args,
    argsHash,
    idempotencyDigest,
  });
  const finalized = await scoped.transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE ap_invocations SET status=$3,effect_state=$4,encrypted_result=$5,error=$6,
         lease_until=NULL,finished_at=CASE WHEN $3 IN ('succeeded','accepted','failed') THEN now() ELSE NULL END
       WHERE id=$1 AND attempt=$2 RETURNING id`,
      [
        reservation.id,
        reservation.attempt,
        outcome.status,
        outcome.effect,
        outcome.result === null || outcome.result === undefined
          ? null
          : tx.cipher!.encrypt(
              `invocation:${reservation.id}:result`,
              outcome.result,
            ),
        outcome.error ? JSON.stringify(outcome.error) : null,
      ],
    );
    return updated.rows.length > 0;
  });
  // A newer attempt took over this invocation; its receipt is authoritative.
  if (!finalized) return getReceipt(principal, reservation.id, database);
  return {
    ...base,
    receipt_id: reservation.id,
    status: outcome.status,
    result: outcome.result,
    error: outcome.error,
    replayed: false,
  };
}

// A replayed running or unknown receipt explains what the caller should do.
function unsettled(receipt: Receipt): Receipt {
  if (receipt.status === "running")
    return {
      ...receipt,
      error: {
        code: "OUTCOME_UNKNOWN",
        message:
          "This invocation is still running. Check its receipt later instead of submitting it again.",
        effect_state: "unknown",
        retry_advice: "reconcile",
      },
    };
  if (receipt.status === "unknown" && receipt.error)
    return {
      ...receipt,
      error: { ...receipt.error, retry_advice: "reconcile" },
    };
  return receipt;
}

function authorize(
  principal: Principal,
  catalog: Catalog,
  grants: Grants,
  entry: Entry,
) {
  if (!permitted(principal, catalog, grants, entry))
    throw new PlatformError(
      "NOT_AVAILABLE",
      "No such operation version is available to you.",
      "none",
      "rediscover",
    );
}

// ----------------------------------------------------------------- receipts

export async function getReceipt(
  principal: Principal,
  receiptId: string,
  database: Database = db,
): Promise<Receipt> {
  const id = z.uuid().safeParse(receiptId);
  const scoped = await forPrincipal(database, principal);
  const receipt = id.success
    ? await scoped.transaction(async (tx) => {
        const row = (
          await tx.query<InvocationRow & { space: string }>(
            `SELECT id,args_hash,status,effect_state,encrypted_result,error,attempt,catalog_revision,operation,version,principal_id,space,
              (lease_until IS NULL OR lease_until < now()) AS lease_expired
             FROM ap_invocations WHERE id=$1`,
            [id.data],
          )
        ).rows[0];
        if (!row) return null;
        const mine = row.principal_id === principal.id;
        const owner = principal.owner && !!principal.userId;
        if (!mine && !owner) return null;
        if (principal.spaces && !principal.spaces.includes(row.space))
          return null;
        // An abandoned running attempt is reported as unknown.
        if (row.status === "running" && row.lease_expired)
          row.status = "unknown";
        return unsettled(receiptFrom(tx, row, `req_${randomUUID()}`, true));
      })
    : null;
  if (!receipt)
    throw new PlatformError(
      "NOT_AVAILABLE",
      "No such receipt is available to you.",
    );
  return receipt;
}

registerPlatformOperation({
  input: z.object({ receipt_id: z.string().max(100) }).strict(),
  handler: (principal, args) => getReceipt(principal, String(args.receipt_id)),
  contract: {
    operation: "platform.get_receipt",
    version: "1.0.0",
    app: "platform",
    summary:
      "Look up the recorded outcome of an earlier invocation by its receipt_id.",
    description:
      "Use this after a timeout, a lost response, or an unknown outcome, instead of submitting the action again.",
    effect: "read",
    execution: "sync",
    idempotency: "optional",
    sensitive: false,
    deprecated: null,
    input_schema: {
      type: "object",
      properties: { receipt_id: { type: "string", maxLength: 100 } },
      required: ["receipt_id"],
      additionalProperties: false,
    },
    output_schema: { type: "object" },
    examples: [],
    ui_url: null,
  },
});
