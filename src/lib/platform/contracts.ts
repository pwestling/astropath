import { createHash } from "node:crypto";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import { z } from "zod";
import { AppError } from "../errors";

// RFC 8785 canonical JSON: sorted keys (UTF-16 order, as Array.sort does) and
// ECMAScript number formatting. Request fingerprints and digests use it.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new AppError(400, "INVALID_ARGUMENTS", "Numbers must be finite.");
    if (value === undefined)
      throw new AppError(400, "INVALID_ARGUMENTS", "Undefined is not JSON.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const argumentsHash = (args: unknown) => sha256(canonicalJson(args));

const RESERVED = new Set(["then", "constructor", "prototype", "__proto__"]);
// Namespaces Astropath serves itself; apps cannot claim them.
export const BUILT_IN_NAMESPACES = new Set(["core", "platform"]);
const ident = (max: number) =>
  z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(max)
    .refine((value) => !RESERVED.has(value), "This name is reserved.");
export const appId = ident(40).refine(
  (value) => !BUILT_IN_NAMESPACES.has(value),
  "This namespace is reserved.",
);
const version = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/,
    "Use an exact semantic version such as 1.0.0.",
  )
  .max(64);
const routePath = z
  .string()
  .max(300)
  .regex(/^\/[A-Za-z0-9._~\-/]*$/, "Use an origin-relative path.")
  .refine(
    (path) =>
      !path.includes("//") &&
      path.split("/").every((part) => part !== "." && part !== ".."),
    "Use a path without empty, dot or parent segments.",
  );
const jsonSchema = z.record(z.string(), z.unknown());

export const operationManifest = z
  .object({
    name: z.string().max(105),
    version,
    summary: z.string().trim().min(1).max(300),
    description: z.string().max(4000).default(""),
    effect: z.enum(["read", "write", "external"]),
    execution: z.enum(["sync", "async"]).default("sync"),
    // The app deduplicates by the Idempotency-Key header, so Astropath may
    // retry a call whose outcome is unknown with the same key.
    deduplicates: z.boolean().default(false),
    // Not granted automatically; each connection must be included.
    sensitive: z.boolean().default(false),
    deprecated: z
      .object({
        replacement: z.string().max(140).optional(),
        retire_after: z.iso.date().optional(),
      })
      .strict()
      .optional(),
    input_schema: jsonSchema,
    output_schema: jsonSchema,
    examples: z.array(z.record(z.string(), z.unknown())).max(5).default([]),
    timeout_ms: z.number().int().min(1000).max(30000).default(10000),
    route: z.object({ path: routePath }).strict(),
    // Files the operation under <app>.<group> for discovery. It is not part
    // of the contract: regrouping never changes an operation version.
    group: ident(40).optional(),
  })
  .strict();
const groupManifest = z
  .object({
    id: ident(40),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(300).default(""),
  })
  .strict();
export const appManifest = z
  .object({
    format: z.literal("astropath.app/v1"),
    app: appId,
    release: z
      .string()
      .regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/)
      .max(64),
    description: z.string().max(2000).default(""),
    ui: z
      .object({ url: z.url({ protocol: /^https$/ }).max(500) })
      .strict()
      .optional(),
    // Optional names and descriptions for the groups operations refer to.
    groups: z.array(groupManifest).optional(),
    operations: z.array(operationManifest),
  })
  .strict();
export type OperationManifest = z.infer<typeof operationManifest>;
export type AppManifest = z.infer<typeof appManifest>;

// What discovery shows. Bindings (route, timeout) stay private.
export interface Contract {
  operation: string;
  version: string;
  app: string;
  summary: string;
  description: string;
  effect: "read" | "write" | "external";
  execution: "sync" | "async";
  idempotency: "required" | "optional";
  sensitive: boolean;
  deprecated: { replacement?: string; retire_after?: string } | null;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  examples: Record<string, unknown>[];
  ui_url: string | null;
}
export const CONTRACT_LIMIT = 32 * 1024;

export function contractOf(
  app: string,
  op: OperationManifest,
  uiUrl: string | null,
): Contract {
  return {
    operation: op.name,
    version: op.version,
    app,
    summary: op.summary,
    description: op.description,
    effect: op.effect,
    execution: op.execution,
    idempotency: op.effect === "read" ? "optional" : "required",
    sensitive: op.sensitive,
    deprecated: op.deprecated ?? null,
    input_schema: op.input_schema,
    output_schema: op.output_schema,
    examples: op.examples,
    ui_url: uiUrl,
  };
}
export const contractHash = (contract: Contract) =>
  sha256(canonicalJson(contract));

const ajv = new Ajv2020({
  strict: false,
  validateFormats: false,
  allErrors: false,
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: false,
});
const compiled = new Map<string, ValidateFunction>();
export function validator(schema: Record<string, unknown>) {
  const key = canonicalJson(schema);
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(key, validate);
    if (compiled.size > 2000) compiled.delete(compiled.keys().next().value!);
  }
  return validate;
}
export function schemaErrors(validate: ValidateFunction) {
  return (validate.errors ?? [])
    .slice(0, 5)
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}

// Schemas must be self-contained: local references only, no identifiers that
// change the base URI, nothing fetched at validation time.
function checkSelfContained(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      const problem = checkSelfContained(item, `${path}/${index}`);
      if (problem) return problem;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  for (const [key, value] of Object.entries(node)) {
    if (["$id", "$dynamicRef", "$recursiveRef", "$dynamicAnchor"].includes(key))
      return `${path}/${key} is not supported; keep schemas self-contained.`;
    if (key === "$ref" && (typeof value !== "string" || !value.startsWith("#")))
      return `${path}/$ref must be a local reference starting with #.`;
    const problem = checkSelfContained(value, `${path}/${key}`);
    if (problem) return problem;
  }
  return null;
}
function checkSchema(schema: Record<string, unknown>, where: string) {
  const problem = checkSelfContained(schema, where);
  if (problem) return problem;
  if (!ajv.validateSchema(schema))
    return `${where} is not a valid JSON Schema 2020-12 document: ${ajv.errorsText(ajv.errors)}`;
  try {
    validator(schema);
  } catch (error) {
    return `${where} does not compile: ${error instanceof Error ? error.message : "invalid"}`;
  }
  return null;
}

// Validate a release manifest. Returns the parsed manifest and its public
// contracts, or throws INVALID_MANIFEST listing every problem found.
export function validateManifest(raw: unknown, expectedApp: string) {
  const parsed = appManifest.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      400,
      "INVALID_MANIFEST",
      parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  const manifest = parsed.data;
  const problems: string[] = [];
  if (manifest.app !== expectedApp)
    problems.push(
      `app must be ${expectedApp}, the namespace this key publishes.`,
    );
  const seen = new Set<string>();
  const contracts: Contract[] = [];
  for (const [index, op] of manifest.operations.entries()) {
    const where = `operations.${index}`;
    const [namespace, leaf, ...rest] = op.name.split(".");
    if (
      namespace !== manifest.app ||
      rest.length ||
      !leaf ||
      !ident(64).safeParse(leaf).success
    )
      problems.push(
        `${where}.name must be ${manifest.app}.<name> using lowercase letters, digits and underscores.`,
      );
    const id = `${op.name}@${op.version}`;
    if (seen.has(id)) problems.push(`${where}: ${id} appears twice.`);
    seen.add(id);
    if (op.execution === "async" && op.effect === "read")
      problems.push(`${where}: async operations must be write or external.`);
    if (op.input_schema.type !== "object")
      problems.push(`${where}.input_schema must have type "object".`);
    let schemasValid = true;
    for (const key of ["input_schema", "output_schema"] as const) {
      const problem = checkSchema(op[key], `${where}.${key}`);
      if (problem) {
        problems.push(problem);
        schemasValid = false;
      }
    }
    if (schemasValid) {
      const validate = validator(op.input_schema);
      for (const [n, example] of op.examples.entries())
        if (!validate(example))
          problems.push(
            `${where}.examples.${n} does not match input_schema: ${schemaErrors(validate)}`,
          );
    }
    const contract = contractOf(manifest.app, op, manifest.ui?.url ?? null);
    if (Buffer.byteLength(canonicalJson(contract)) > CONTRACT_LIMIT)
      problems.push(`${where}: the contract is over 32 KiB.`);
    contracts.push(contract);
  }
  if (problems.length)
    throw new AppError(
      400,
      "INVALID_MANIFEST",
      problems.slice(0, 20).join(" "),
    );
  return { manifest, contracts, digest: sha256(canonicalJson(manifest)) };
}
