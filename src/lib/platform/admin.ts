import { z } from "zod";
import type { Contract } from "./contracts";
import { registerPlatformOperation } from "./catalog";
import type { LocalOperation } from "./core";
import { createAppInput, setGrantInput, updateAppInput } from "./app-inputs";

// The store imports the dispatcher, which imports this module, so it is
// loaded when an operation runs rather than when this module is evaluated.
const store = async () => (await import("./apps")).apps;

// App management for agents. Every operation that changes something is named
// platform.sensitive_* and carries sensitive: true, so the name is visible in
// the invoke or execute call itself and a client's approval policy can stop
// for a person before it runs. Astropath does not ask anyone: the check is
// the caller's. The owner-only HTTP routes are unchanged.
const WARNING =
  "Sensitive: this changes which apps exist, where agents' calls and arguments are sent, or who may call them. Get the workspace owner's explicit confirmation for this specific call before invoking it.";

function operation(
  name: string,
  summary: string,
  effect: Contract["effect"],
  input: z.ZodObject,
  handler: LocalOperation["handler"],
) {
  const sensitive = effect !== "read";
  registerPlatformOperation({
    input: input.strict(),
    handler,
    contract: {
      operation: `platform.${name}`,
      version: "1.0.0",
      app: "platform",
      summary: sensitive ? `Sensitive: ${summary}` : summary,
      description: sensitive ? WARNING : "",
      effect,
      execution: "sync",
      idempotency: effect === "read" ? "optional" : "required",
      sensitive,
      deprecated: null,
      input_schema: z.toJSONSchema(input.strict(), {
        io: "input",
        unrepresentable: "any",
        target: "draft-2020-12",
      }) as Record<string, unknown>,
      output_schema: { type: "object" },
      examples: [],
      ui_url: null,
    },
  });
}
const app = z.object({ app: z.string().min(1).max(40) });

operation(
  "list_apps",
  "List apps with their origins, grant policies, grants and operations.",
  "read",
  z.object({}),
  async (principal) => (await store()).list(principal, "operation"),
);
operation(
  "sensitive_create_app",
  "register a new app and the origin Astropath sends its calls to. Returns the publisher key once.",
  "write",
  createAppInput,
  async (principal, args) =>
    (await store()).create(principal, args, "operation"),
);
operation(
  "sensitive_update_app",
  "change an app's name, origin or grant policy, or disable it or some of its operations.",
  "write",
  app.extend(updateAppInput.shape),
  async (principal, { app: id, ...changes }) =>
    (await store()).update(principal, String(id), changes, "operation"),
);
operation(
  "sensitive_rotate_app_key",
  "replace an app's publisher key; the old key stops working. Returns the new key once.",
  "write",
  app,
  async (principal, args) =>
    (await store()).rotateKey(principal, String(args.app), "operation"),
);
operation(
  "sensitive_set_app_grant",
  "include a connection in an app (sensitive operations too), exclude it, or clear its grant.",
  "write",
  app.extend(setGrantInput.shape),
  async (principal, { app: id, ...grant }) =>
    (await store()).setGrant(principal, String(id), grant, "operation"),
);
