import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import type { Queryable } from "../db";

// Delegated tokens tell an app who is calling and exactly what was approved.
// Each tenant has its own Ed25519 key, encrypted with the tenant key; apps
// verify against GET /api/platform/v1/jwks/{tenant}.
const cache = new Map<string, { kid: string; key: CryptoKey }>();

async function currentKey(tx: Queryable) {
  const tenant = tx.tenantId!;
  const cached = cache.get(tenant);
  if (cached) return cached;
  const row = (
    await tx.query<{ kid: string; encrypted_private_key: string }>(
      "SELECT kid,encrypted_private_key FROM ap_signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1",
    )
  ).rows[0];
  let entry: { kid: string; key: CryptoKey };
  if (row) {
    const jwk = tx.cipher!.decrypt<JWK>(
      `signing:${row.kid}`,
      row.encrypted_private_key,
    );
    entry = {
      kid: row.kid,
      key: (await importJWK(jwk, "EdDSA")) as CryptoKey,
    };
  } else {
    const kid = randomUUID();
    const pair = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const publicJwk = {
      ...(await exportJWK(pair.publicKey)),
      kid,
      alg: "EdDSA",
      use: "sig",
    };
    await tx.query(
      "INSERT INTO ap_signing_keys(kid,public_jwk,encrypted_private_key) VALUES($1,$2,$3)",
      [
        kid,
        JSON.stringify(publicJwk),
        tx.cipher!.encrypt(`signing:${kid}`, await exportJWK(pair.privateKey)),
      ],
    );
    // Not cached until read back, in case this transaction rolls back.
    return { kid, key: pair.privateKey };
  }
  cache.set(tenant, entry);
  return entry;
}

export async function publicKeys(tx: Queryable) {
  // Apps fetch keys before their first call; make sure one exists.
  await currentKey(tx);
  const rows = (
    await tx.query<{ public_jwk: JWK | string }>(
      "SELECT public_jwk FROM ap_signing_keys WHERE retired_at IS NULL ORDER BY created_at",
    )
  ).rows;
  return {
    keys: rows.map((row) =>
      typeof row.public_jwk === "string"
        ? (JSON.parse(row.public_jwk) as JWK)
        : row.public_jwk,
    ),
  };
}

export const audienceFor = (app: string) => `astropath-app:${app}`;

export async function delegatedToken(
  tx: Queryable,
  claims: {
    issuer: string;
    app: string;
    subject: string;
    name: string;
    space: string;
    operation: string;
    version: string;
    release: string;
    invocationId: string;
    argumentsSha256: string;
    idempotencyDigest: string | null;
    lifetimeSeconds: number;
  },
) {
  const { kid, key } = await currentKey(tx);
  return new SignJWT({
    tenant_id: tx.tenantId,
    name: claims.name,
    space: claims.space,
    operation: claims.operation,
    operation_version: claims.version,
    app_release: claims.release,
    invocation_id: claims.invocationId,
    arguments_sha256: claims.argumentsSha256,
    idempotency_digest: claims.idempotencyDigest,
  })
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "astropath-delegation+jwt" })
    .setIssuer(claims.issuer)
    .setAudience(audienceFor(claims.app))
    .setSubject(claims.subject)
    .setIssuedAt()
    .setExpirationTime(
      Math.floor(Date.now() / 1000) + Math.min(60, claims.lifetimeSeconds),
    )
    .setJti(randomUUID())
    .sign(key);
}
