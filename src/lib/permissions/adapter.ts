// Router for the Custodes permission adapter contract version 1, adapted from Custodes
// src/permissions/adapter.ts at efd1b46. Astropath: framework-free (Request -> Response)
// instead of Hono, with the same routes, limits and error mapping.
import { z } from "zod";
import {
  canonical,
  catalogPageSchema,
  changeSchema,
  manifestSchema,
  PermissionError,
  stateSchema,
  targetSchema,
  validateChange,
  validateState,
  type CatalogPage,
  type Change,
  type Manifest,
  type State,
  type Target,
} from "./protocol";
import { verifyManagementRequest, type ManagementIdentity } from "./security";

export type Actor = { actor: string };
export interface PermissionAdapter {
  describe(actor: Actor): Promise<Manifest>;
  list(
    catalog: string,
    query: { q: string; cursor?: string },
    actor: Actor,
  ): Promise<CatalogPage>;
  read(target: Target, actor: Actor): Promise<State>;
  /** Return a durable original receipt, even after the manifest changes. Reject mismatched actor/payload. */
  replay(change: Change, actor: Actor): Promise<State | undefined>;
  /** Atomically: deduplicate (actor, requestId + full payload), check version/action eligibility,
   * validate domain rules, apply, audit, and store the original result. */
  apply(change: Change, actor: Actor): Promise<State>;
}

const MAX_BODY = 64 * 1024;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Handles one request under `basePath` (the exact configured management path). */
export function createPermissionHandler(
  identity: ManagementIdentity,
  adapter: PermissionAdapter,
  basePath: string,
) {
  async function manifest(actor: Actor) {
    const value = manifestSchema.parse(await adapter.describe(actor));
    if (value.appId !== identity.appId)
      throw new PermissionError("Adapter application mismatch", 503);
    return value;
  }
  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(basePath))
      throw new PermissionError("Not found", 404);
    const rest = url.pathname.slice(basePath.length);
    let body = "";
    if (request.method !== "GET") {
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > MAX_BODY)
        throw new PermissionError("Request too large", 400);
      body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_BODY)
        throw new PermissionError("Request too large", 400);
    }
    const actor = await verifyManagementRequest(identity, request, body);
    if (request.method === "GET" && rest === "/manifest")
      return json(await manifest(actor));
    const catalog = /^\/catalogs\/([a-z][a-z0-9-]{0,63})$/.exec(rest)?.[1];
    if (request.method === "GET" && catalog) {
      const description = await manifest(actor);
      if (!description.catalogs.some((v) => v.id === catalog))
        throw new PermissionError("Unknown catalog", 404);
      const query = z
        .object({
          q: z.string().max(200).default(""),
          cursor: z.string().max(256).optional(),
        })
        .parse(Object.fromEntries(url.searchParams));
      return json(
        catalogPageSchema.parse(await adapter.list(catalog, query, actor)),
      );
    }
    if (request.method === "GET" && rest === "/state") {
      const target = targetSchema.parse(Object.fromEntries(url.searchParams));
      const description = await manifest(actor);
      return json(
        validateState(description, target, await adapter.read(target, actor)),
      );
    }
    if (request.method === "POST" && rest === "/changes") {
      let change: Change;
      try {
        change = changeSchema.parse(JSON.parse(body));
      } catch {
        throw new PermissionError("Invalid management request", 422);
      }
      const previous = await adapter.replay(change, actor);
      if (previous) {
        const state = stateSchema.parse(previous);
        if (canonical(state.target) !== canonical(change.target))
          throw new PermissionError("Invalid original receipt", 503, "unknown");
        return json({ requestId: change.requestId, state });
      }
      const description = await manifest(actor);
      validateChange(description, change);
      const applied = await adapter.apply(change, actor);
      let state: State;
      try {
        state = validateState(description, change.target, applied);
      } catch {
        throw new PermissionError(
          "Application returned an invalid receipt",
          503,
          "unknown",
        );
      }
      return json({ requestId: change.requestId, state });
    }
    throw new PermissionError("Not found", 404);
  }
  return async (request: Request): Promise<Response> => {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof PermissionError)
        return json(
          { error: error.message, outcome: error.outcome },
          error.status,
        );
      // Validation of query/target input is a definite rejection (nothing was changed).
      if (error instanceof z.ZodError && request.method === "GET")
        return json(
          { error: "Invalid management request", outcome: "rejected" },
          422,
        );
      // A storage error may occur after commit. Never claim this operation was rejected.
      console.error(
        JSON.stringify({
          level: "error",
          event: "permissions.adapter_operation_failed",
          appId: identity.appId,
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : "unknown",
        }),
      );
      return json(
        { error: "Application operation failed", outcome: "unknown" },
        503,
      );
    }
  };
}
