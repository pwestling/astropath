import type { JWTPayload } from "jose";
import { getAuth } from "./auth";
import { systemDb as db } from "./db";
import { selectedTenant } from "./tenants";
import { appUrl } from "./config";
import { AppError } from "./errors";
import { oauthConnectionClaim } from "./identities";
import { z } from "zod";
import { userPrincipal, connectionSpaces } from "./access";

import { hash, type Principal } from "./policy";
export {
  hash,
  mintToken,
  requireScope,
  requireSpace,
  type Principal,
} from "./policy";

export function checkOrigin(request: Request) {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    request.headers.get("origin") !== appUrl()
  ) {
    throw new AppError(
      403,
      "invalid_origin",
      "This action must originate from Astropath.",
    );
  }
}

export async function sessionPrincipal(
  requestHeaders: Headers,
): Promise<Principal | null> {
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const selected = selectedTenant(requestHeaders);
  const principal = await userPrincipal(db, session.user.id, selected);
  if (principal || !selected) return principal;
  // A removed/disabled membership must not silently switch content tenants.
  // Keep account management accessible so the human can select another tenant.
  const account = await userPrincipal(db, session.user.id);
  return account
    ? { ...account, tenantId: undefined, owner: false, spaces: [] }
    : null;
}

export async function apiPrincipal(
  request: Request,
  options: { touch?: boolean } = {},
): Promise<Principal> {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer (ap_[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match)
      throw new AppError(
        401,
        "invalid_token",
        "Use Authorization: Bearer <Astropath token>.",
      );
    const result = await db.query<{
      id: string;
      name: string;
      scopes: string[];
      spaces: string[] | null;
      created_by_user_id: string | null;
      tenant_id: string;
    }>(
      options.touch === false
        ? `SELECT id,name,scopes,spaces,created_by_user_id,tenant_id FROM ap_connections WHERE token_hash=$1 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())`
        : `UPDATE ap_connections SET last_used_at = now() WHERE token_hash=$1 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now()) RETURNING id,name,scopes,spaces,created_by_user_id,tenant_id`,
      [hash(match[1])],
    );
    const connection = result.rows[0];
    if (!connection)
      throw new AppError(
        401,
        "invalid_token",
        "This token is invalid, expired, or revoked.",
      );
    const { created_by_user_id, tenant_id, ...identity } = connection;
    return {
      ...identity,
      tenantId: tenant_id,
      spaces: await connectionSpaces(
        db,
        identity.spaces,
        created_by_user_id,
        tenant_id,
      ),
      owner: false,
    };
  }
  const principal = await sessionPrincipal(request.headers);
  if (!principal)
    throw new AppError(401, "unauthorized", "Sign in or provide an API token.");
  checkOrigin(request);
  return principal;
}

export async function oauthPrincipal(
  claims: JWTPayload,
  options: { touch?: boolean } = {},
): Promise<Principal> {
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now())
    throw new AppError(
      401,
      "invalid_token",
      "This OAuth access token has expired.",
    );
  const clientId =
    typeof claims.client_id === "string"
      ? claims.client_id
      : typeof claims.azp === "string"
        ? claims.azp
        : null;
  if (!claims.sub || !clientId)
    throw new AppError(
      401,
      "invalid_identity",
      "OAuth token is missing its owner or client identity.",
    );
  const account = await userPrincipal(db, claims.sub);
  if (!account)
    throw new AppError(
      403,
      "access_revoked",
      "This account no longer has access.",
    );
  const connectionClaim = oauthConnectionClaim(claims);
  if (connectionClaim !== undefined) {
    const identityId = z.uuid().safeParse(connectionClaim);
    if (!identityId.success)
      throw new AppError(
        401,
        "invalid_identity",
        "Invalid connection identity.",
      );
    const named = await db.query<{
      id: string;
      name: string;
      spaces: string[] | null;
      scopes: string[];
      tenant_id: string;
    }>(
      options.touch === false
        ? `SELECT id,name,spaces,scopes,tenant_id FROM ap_connections WHERE id=$1 AND oauth_user_id=$2
       AND oauth_authorization_client_id=$3 AND kind='oauth' AND revoked_at IS NULL`
        : `UPDATE ap_connections SET last_used_at=now() WHERE id=$1 AND oauth_user_id=$2
       AND oauth_authorization_client_id=$3 AND kind='oauth' AND revoked_at IS NULL
       RETURNING id,name,spaces,scopes,tenant_id`,
      [identityId.data, claims.sub, clientId],
    );
    const identity = named.rows[0];
    if (!identity)
      throw new AppError(
        403,
        "connection_revoked",
        "This connection was revoked or no longer exists.",
      );
    const granted =
      typeof claims.scope === "string" ? claims.scope.split(" ") : [];
    return {
      ...identity,
      tenantId: identity.tenant_id,
      spaces: await connectionSpaces(
        db,
        identity.spaces,
        claims.sub,
        identity.tenant_id,
      ),
      owner: false,
      scopes: identity.scopes.filter((scope) => granted.includes(scope)),
    };
  }
  throw new AppError(
    403,
    "connection_revoked",
    "Reconnect this application to choose a tenant and named identity.",
  );
}

export async function rateLimit(principal: Principal) {
  const minute = Math.floor(Date.now() / 60000);
  const result = await db.query<{ count: number }>(
    `INSERT INTO ap_rate_limits(key,count,expires_at) VALUES ($1,1,now()+interval '2 minutes')
     ON CONFLICT(key) DO UPDATE SET count=ap_rate_limits.count+1 RETURNING count`,
    [`${principal.id}:${minute}`],
  );
  if (result.rows[0].count > 120)
    throw new AppError(
      429,
      "rate_limited",
      "Too many requests. Try again in a minute.",
    );
  if (Math.random() < 0.01)
    await db.query("DELETE FROM ap_rate_limits WHERE expires_at < now()");
}
