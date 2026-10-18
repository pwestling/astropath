import { jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Database } from "../db";
import { AppError } from "../errors";
import type { CustodesAccounts } from "./accounts";
import type { CustodesConfig } from "./config";

const EVENT = "http://schemas.openid.net/event/backchannel-logout";
const bad = (message: string) =>
  new AppError(400, "invalid_logout_token", message);

/**
 * Validates a Custodes back-channel logout token (OIDC Back-Channel Logout 1.0 as issued by
 * Custodes) and ends the matching local sessions. The signature is the only authentication.
 */
export async function handleBackchannelLogout(
  config: CustodesConfig,
  keys: JWTVerifyGetKey,
  accounts: CustodesAccounts,
  database: Database,
  logoutToken: string | null,
) {
  if (!logoutToken) throw bad("logout_token is required.");
  let payload;
  try {
    ({ payload } = await jwtVerify(logoutToken, keys, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ["EdDSA"],
      typ: "logout+jwt",
      requiredClaims: ["iat", "exp", "jti", "events"],
      maxTokenAge: "5m",
    }));
  } catch {
    throw bad("The logout token was not valid.");
  }
  const events = payload.events as Record<string, unknown> | undefined;
  if (
    !events ||
    typeof events !== "object" ||
    !(EVENT in events) ||
    "nonce" in payload ||
    typeof payload.jti !== "string"
  )
    throw bad("The logout token was not valid.");
  const sid =
    typeof payload.sid === "string" && payload.sid ? payload.sid : undefined;
  const subject =
    typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
  if (!sid && !subject)
    throw bad("The logout token names no session or subject.");
  const first = await database.query(
    "INSERT INTO ap_custodes_jti(jti,expires_at) VALUES($1,to_timestamp($2)) ON CONFLICT DO NOTHING RETURNING jti",
    [payload.jti, (payload.exp ?? 0) + 60],
  );
  if (!first.rows.length) throw bad("The logout token was already used.");
  if (Math.random() < 0.05)
    await database.query("DELETE FROM ap_custodes_jti WHERE expires_at<now()");
  return accounts.endSessions(config.issuer, { sid, subject });
}
