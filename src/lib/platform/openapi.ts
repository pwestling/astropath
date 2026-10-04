import { z } from "zod";
import { discoverInput, executeInput, invokeInput } from "./dispatch";

// The tool platform over HTTP: the same three calls as the MCP tools.
export function platformPaths() {
  const body = (schema: z.ZodType) => ({
    required: true,
    content: { "application/json": { schema: z.toJSONSchema(schema) } },
  });
  const receipt = {
    "200": { description: "Receipt: status succeeded, result in result" },
    "202": { description: "Receipt: status accepted, a job handle in result" },
    "400": { description: "INVALID_ARGUMENTS or missing idempotency_key" },
    "404": { description: "NOT_AVAILABLE: absent or not granted to you" },
    "409": {
      description: "IDEMPOTENCY_CONFLICT: key reused with other arguments",
    },
    "410": {
      description: "CATALOG_EXPIRED or OPERATION_RETIRED: discover again",
    },
    "502": {
      description: "The app failed or is unreachable; see retry_advice",
    },
    "504": {
      description:
        "OUTCOME_UNKNOWN: retry with the same key or check the receipt",
    },
  };
  return {
    "/discover": {
      post: {
        operationId: "discoverOperations",
        summary:
          "Requires astropath:read. Find tools that apps publish. No fields lists apps; namespace lists one app's operations; query searches; operation (optionally with version) returns its full contract and input_schema. Returns catalog_revision and exact versions for invoke.",
        requestBody: body(discoverInput),
        responses: { "200": { description: "Apps or matching operations" } },
      },
    },
    "/invoke": {
      post: {
        operationId: "invokeOperation",
        summary:
          "Call one discovered operation by exact operation and version, with arguments matching its input_schema. Operations that change state need an idempotency_key; reuse it only to retry the same call. Errors carry effect_state and retry_advice.",
        requestBody: body(invokeInput),
        responses: receipt,
      },
    },
    "/execute": {
      post: {
        operationId: "executeProgram",
        summary:
          "Run a short program composing discovered operations. Not yet enabled: returns NOT_AVAILABLE.",
        requestBody: body(executeInput),
        responses: { "404": { description: "NOT_AVAILABLE" } },
      },
    },
    "/changes": {
      get: {
        operationId: "listChanges",
        summary:
          "Requires astropath:read. Topics, replies and memories created or updated since a cursor, with content, in spaces you can read. Pass the returned cursor as after; continue while has_more. Memories appear about 5 seconds after they are written.",
        parameters: [
          { name: "after", in: "query", schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 200 },
          },
          { name: "space", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "changes, cursor and has_more" } },
      },
    },
    "/invocations/{id}": {
      get: {
        operationId: "getReceipt",
        summary:
          "The recorded outcome of an earlier state-changing invocation, for its caller or the workspace owner.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": { description: "Receipt" },
          "404": { description: "NOT_AVAILABLE" },
        },
      },
    },
  };
}
