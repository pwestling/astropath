// A minimal Astropath app: it serves operations over HTTP, verifies the
// delegated token Astropath sends with every call, and publishes its manifest
// on deploy (see publish.mjs). Use it as a template for real apps.
import { createHash } from "node:crypto";
import { jwtVerify } from "jose";

export const RELEASE = process.env.ECHO_RELEASE ?? "0.1.0";

export function manifest(release = RELEASE, extra = []) {
  return {
    format: "astropath.app/v1",
    app: "echo",
    release,
    description: "Example app: echoes text and keeps a counter.",
    operations: [
      {
        name: "echo.say",
        version: "1.0.0",
        summary: "Echo text back, with who called.",
        effect: "read",
        input_schema: {
          type: "object",
          properties: { text: { type: "string", maxLength: 1000 } },
          required: ["text"],
          additionalProperties: false,
        },
        output_schema: {
          type: "object",
          properties: {
            text: { type: "string" },
            caller: { type: "string" },
          },
          required: ["text", "caller"],
          additionalProperties: false,
        },
        examples: [{ text: "hello" }],
        route: { path: "/ops/say/v1" },
      },
      {
        name: "echo.counter_add",
        version: "1.0.0",
        summary: "Add to a shared counter and return the new total.",
        effect: "write",
        deduplicates: true,
        input_schema: {
          type: "object",
          properties: { amount: { type: "integer", minimum: 1, maximum: 100 } },
          required: ["amount"],
          additionalProperties: false,
        },
        output_schema: {
          type: "object",
          properties: { total: { type: "integer" } },
          required: ["total"],
          additionalProperties: false,
        },
        route: { path: "/ops/counter-add/v1" },
      },
      ...extra,
    ],
  };
}

// RFC 8785 canonical JSON, matching Astropath's arguments_sha256 claim.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// jwks: a jose key resolver, e.g.
// createRemoteJWKSet(new URL(`${astropath}/api/platform/v1/jwks/${tenant}`)).
export function createEchoApp({
  issuer,
  jwks,
  release = RELEASE,
  routes = {},
}) {
  let total = 0;
  const seen = new Map(); // Idempotency-Key -> response, for safe retries
  const handlers = {
    "/ops/say/v1": async (args, claims) => ({
      text: args.text,
      caller: claims.name,
    }),
    "/ops/counter-add/v1": async (args) => {
      total += args.amount;
      return { total };
    },
    ...routes,
  };
  const operations = new Map(
    manifest(release).operations.map((op) => [
      op.route.path,
      `${op.name}@${op.version}`,
    ]),
  );
  return {
    get total() {
      return total;
    },
    async handle(request) {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        url.pathname === "/.well-known/astropath-app"
      )
        return Response.json({ app: "echo", release });
      const handler = handlers[url.pathname];
      if (request.method !== "POST" || !handler)
        return Response.json(
          { error: { code: "NOT_FOUND", message: "No such route." } },
          { status: 404 },
        );
      const token = /^Bearer (.+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      let claims;
      try {
        ({ payload: claims } = await jwtVerify(token ?? "", jwks, {
          issuer,
          audience: "astropath-app:echo",
          algorithms: ["EdDSA"],
        }));
      } catch {
        return Response.json(
          {
            error: { code: "UNAUTHENTICATED", message: "Invalid delegation." },
          },
          { status: 401 },
        );
      }
      const text = await request.text();
      const args = JSON.parse(text);
      const key = request.headers.get("idempotency-key");
      // The token is bound to this exact operation, arguments and key.
      const expected =
        operations.get(url.pathname) ??
        request.headers.get("astropath-operation");
      if (
        `${claims.operation}@${claims.operation_version}` !== expected ||
        claims.arguments_sha256 !== sha256(canonical(args)) ||
        (claims.idempotency_digest ?? null) !== (key ?? null)
      )
        return Response.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Token does not match this call.",
            },
          },
          { status: 403 },
        );
      if (key && seen.has(key)) return Response.json(seen.get(key));
      const result = await handler(args, claims);
      if (key) seen.set(key, result);
      return Response.json(result);
    },
  };
}
