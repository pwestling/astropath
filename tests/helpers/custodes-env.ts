import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose";
import { vi } from "vitest";
import type { QueryResultRow } from "pg";
import type { Database, Queryable } from "../../src/lib/db";
import { CustodesAccounts } from "../../src/lib/custodes/accounts";
import { custodesConfig } from "../../src/lib/custodes/config";
import { CustodesOidc } from "../../src/lib/custodes/oidc";
import { MemberStore } from "../../src/lib/members";
import { migrateTenancy, INITIAL_TENANT } from "../../src/lib/tenant-migration";
import { hash } from "../../src/lib/policy";

export { INITIAL_TENANT };
export const APP = "https://ap.test";
export const ORIGIN = "https://auth.test";
export const ISSUER = `${ORIGIN}/api/auth`;
export const CLIENT_ID = "client-1";
export const env = {
  CUSTODES_CLIENT_ID: CLIENT_ID,
  CUSTODES_CLIENT_SECRET: "client-secret",
  CUSTODES_ORIGIN: ORIGIN,
};
export const config = () => custodesConfig(env, APP)!;

function adapter(target: Pick<PGlite, "query" | "exec">): Queryable {
  return {
    query: async <T extends QueryResultRow>(
      sql: string,
      values?: unknown[],
    ) => {
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
      if (!values)
        return {
          rows: ((await target.exec(sql)).at(-1)?.rows as T[]) || [],
        };
      const r = await target.query<T>(sql, values);
      return { rows: r.rows, rowCount: r.affectedRows };
    },
  };
}

/**
 * A PGlite database with Astropath's real migrations (including the Custodes tables), an owner
 * (a password-era account that predates Custodes), and a second tenant member.
 */
export async function createEnv() {
  vi.stubEnv("OWNER_EMAIL", "owner@example.test");
  vi.stubEnv("APP_URL", APP);
  vi.stubEnv("ASTROPATH_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  const engine = new PGlite();
  const database: Database = {
    ...adapter(engine),
    transaction: (fn) => engine.transaction((tx) => fn(adapter(tx))),
  };
  await engine.exec(`
    CREATE TABLE "user"(id text PRIMARY KEY,name text NOT NULL,email text NOT NULL UNIQUE,"emailVerified" boolean NOT NULL DEFAULT false,
      "createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now());
    CREATE TABLE account(id text PRIMARY KEY,"accountId" text,"providerId" text,"userId" text,password text,"createdAt" timestamptz,"updatedAt" timestamptz);
    CREATE TABLE "session"(id text PRIMARY KEY,"userId" text NOT NULL,token text);`);
  await engine.exec(
    await readFile(
      new URL("../../src/lib/schema.sql", import.meta.url),
      "utf8",
    ),
  );
  await database.transaction(migrateTenancy);
  await engine.query("SELECT set_config('astropath.tenant_id',$1,false)", [
    INITIAL_TENANT,
  ]);
  await engine.exec(`
    INSERT INTO ap_spaces(slug,name) VALUES('personal','Personal'),('work','Work') ON CONFLICT DO NOTHING;`);
  const members = new MemberStore(database);
  const accounts = new CustodesAccounts(database, members);
  return { engine, database, members, accounts };
}
export type Env = Awaited<ReturnType<typeof createEnv>>;

/** Resets users, memberships, sessions and every Custodes table to a known fixture. */
export async function resetFixture(e: Env) {
  await e.engine.exec(`
    TRUNCATE ap_custodes_identities,ap_custodes_flows,ap_custodes_sessions,ap_custodes_jti,ap_permission_requests,ap_custodes_audit,ap_members,ap_connections,"session",account,"user" CASCADE;
    INSERT INTO "user"(id,name,email) VALUES('owner','Owner','owner@example.test'),('izzy','Izzy','izzy@example.test');
    INSERT INTO ap_members(id,tenant_id,email,name,user_id,spaces,role) VALUES
      ('${randomUUID()}','${INITIAL_TENANT}','owner@example.test','Owner','owner',ARRAY['general'],'owner'),
      ('${randomUUID()}','${INITIAL_TENANT}','izzy@example.test','Izzy','izzy',ARRAY['personal'],'member');
    INSERT INTO "session"(id,"userId",token) VALUES('legacy-owner','owner','t1'),('legacy-izzy','izzy','t2');`);
}

export async function signingKey() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA");
  const keys: JWTVerifyGetKey = async () => publicKey;
  return { publicKey, privateKey, keys, jwk: await exportJWK(publicKey) };
}
export type Signer = Awaited<ReturnType<typeof signingKey>>;

/** Signs a token the way Custodes does (EdDSA); claims override defaults. */
export async function sign(
  signer: Pick<Signer, "privateKey">,
  claims: Record<string, unknown>,
  options: {
    typ?: string;
    issuer?: string;
    audience?: string | string[];
    expires?: string | number;
    alg?: string;
  } = {},
) {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({
      alg: options.alg ?? "EdDSA",
      ...(options.typ ? { typ: options.typ } : {}),
    })
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(options.expires ?? "5m");
  if (options.audience !== undefined) jwt.setAudience(options.audience);
  return jwt.sign(signer.privateKey);
}

/** An OIDC client whose discovery and token endpoints are served by the test. */
export function fakeOidc(
  signer: Signer,
  token: () => Promise<{ id_token?: string } | null>,
) {
  const fetcher = (async (input: URL | string) => {
    const url = String(input);
    if (url.endsWith("/.well-known/oauth-authorization-server/api/auth"))
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: `${ISSUER}/oauth2/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    if (url === `${ISSUER}/oauth2/token`) {
      const body = await token();
      return body ? Response.json(body) : new Response("{}", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return new CustodesOidc(config(), { fetch: fetcher, keys: signer.keys });
}
export const linkRow = (e: Env, userId: string, subject: string) =>
  e.database.query(
    `INSERT INTO ap_custodes_identities(issuer,subject,user_id,linked_via) VALUES($1,$2,$3,'session')`,
    [ISSUER, subject, userId],
  );
export { hash };
