// Vendored from Custodes (github.com/pwestling/custodes) src/permissions/security.ts at efd1b46, permission adapter contract version 1.
// Keep in step with that revision rather than editing here; local changes are marked 'Astropath:'.
import { createHash, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { PermissionError } from "./protocol";

export type ManagementIdentity = {
  issuer: string;
  appId: string;
  secret: string;
};
// Astropath: a token is single-use. Custodes signs a fresh one per request, so a repeated jti
// is a replay. Entries are kept for the 60-second token lifetime plus a clock-tolerance margin.
// Shared through globalThis so every route bundle in this process sees the same set.
const store = globalThis as unknown as {
  astropathPermissionJti?: Map<string, number>;
};
const seen = (store.astropathPermissionJti ??= new Map<string, number>());
function firstUse(jti: string, expires: number) {
  const now = Date.now();
  for (const [id, until] of seen) if (until < now) seen.delete(id);
  if (seen.has(jti)) return false;
  seen.set(jti, Math.max(expires * 1000, now) + 5000);
  return true;
}
export function digest(body: string) {
  return createHash("sha256").update(body).digest("hex");
}
function key(identity: ManagementIdentity) {
  if (identity.secret.length < 32)
    throw new Error("Management secrets must have at least 32 characters");
  return new TextEncoder().encode(identity.secret);
}
export async function signManagementRequest(
  identity: ManagementIdentity,
  actor: string,
  method: string,
  url: URL,
  body: string,
) {
  return new SignJWT({
    actor,
    method,
    path: url.pathname + url.search,
    bodyHash: digest(body),
  })
    .setProtectedHeader({ alg: "HS256", typ: "permission-admin+jwt" })
    .setIssuer(identity.issuer)
    .setAudience(identity.appId)
    .setIssuedAt()
    .setExpirationTime("60s")
    .setJti(randomUUID())
    .sign(key(identity));
}
export async function verifyManagementRequest(
  identity: ManagementIdentity,
  request: Request,
  body: string,
) {
  const token = /^Bearer (\S+)$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!token)
    throw new PermissionError("Management authentication required", 401);
  try {
    const { payload } = await jwtVerify(token, key(identity), {
      issuer: identity.issuer,
      audience: identity.appId,
      algorithms: ["HS256"],
      typ: "permission-admin+jwt",
      requiredClaims: ["iat", "exp", "jti"],
      maxTokenAge: "60s",
    });
    const claims = z
      .object({
        actor: z.string().min(1).max(320),
        method: z.string(),
        path: z.string(),
        bodyHash: z.string(),
      })
      .parse(payload);
    const url = new URL(request.url);
    if (
      claims.method !== request.method ||
      claims.path !== url.pathname + url.search ||
      claims.bodyHash !== digest(body)
    )
      throw new Error("Request mismatch");
    // Astropath: consume the jti only after the signature and request binding are proven, so
    // a forged or tampered request cannot burn a legitimate token's id.
    if (!payload.jti || !firstUse(payload.jti, payload.exp ?? 0))
      throw new Error("Replayed token");
    return { actor: claims.actor };
  } catch {
    throw new PermissionError("Invalid management authentication", 401);
  }
}
