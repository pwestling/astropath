import { systemDb } from "../db";
import {
  custodesAppId,
  custodesIssuer,
  custodesOrigin,
} from "../custodes/config";
import { createPermissionHandler } from "./adapter";
import { AstropathPermissions } from "./astropath";

/** The path Custodes is configured with (deploy/custodes-client.nix `management.url`). */
export const PERMISSIONS_PATH = "/_custodes/permissions";
const SECRET_NAME = "PERMISSIONS_ASTROPATH_SECRET";

type Env = Record<string, string | undefined>;
/** Returns the secret, or null (adapter disabled) when it is missing, short or reused. */
export function permissionsSecret(env: Env = process.env) {
  const secret = env[SECRET_NAME]?.trim();
  if (!secret) return { secret: null, reason: `${SECRET_NAME} is not set` };
  if (secret.length < 32)
    return {
      secret: null,
      reason: `${SECRET_NAME} must be at least 32 characters`,
    };
  for (const other of [
    "BETTER_AUTH_SECRET",
    "CUSTODES_CLIENT_SECRET",
    "ASTROPATH_MASTER_KEY",
  ])
    if (env[other]?.trim() === secret)
      return {
        secret: null,
        reason: `${SECRET_NAME} must differ from ${other}`,
      };
  if (!custodesOrigin(env))
    return {
      secret: null,
      reason: "CUSTODES_ORIGIN is not set to an https origin",
    };
  return { secret, reason: "" };
}

const state = globalThis as unknown as { astropathPermissionsWarned?: boolean };
let cached:
  | { key: string; handler: ((r: Request) => Promise<Response>) | null }
  | undefined;
export function permissionHandler(env: Env = process.env) {
  const { secret, reason } = permissionsSecret(env);
  const key = `${secret}|${custodesOrigin(env)}|${custodesAppId(env)}`;
  if (cached?.key === key) return cached.handler;
  let handler: ((r: Request) => Promise<Response>) | null = null;
  if (secret)
    handler = createPermissionHandler(
      {
        issuer: custodesOrigin(env)!,
        appId: custodesAppId(env),
        secret,
      },
      new AstropathPermissions(
        systemDb,
        custodesIssuer(env)!,
        custodesAppId(env),
      ),
      PERMISSIONS_PATH,
    );
  else if (!state.astropathPermissionsWarned) {
    state.astropathPermissionsWarned = true;
    console.warn(`Custodes permission adapter disabled: ${reason}.`);
  }
  cached = { key, handler };
  return handler;
}
