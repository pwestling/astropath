import { appUrl } from "../config";

type Env = Record<string, string | undefined>;
export const DEFAULT_APP_ID = "astropath";

const off = new Set(["0", "false", "off", "no", "disabled"]);
/** Staged-cutover flags default to on; only an explicit off value disables them. */
function flag(name: string, env: Env) {
  const value = env[name]?.trim().toLowerCase();
  return value === undefined || value === "" ? true : !off.has(value);
}
/** Password sign-in (ASTROPATH_PASSWORD_LOGIN, default on). Turn off once people have linked Custodes. */
export const passwordLoginEnabled = (env: Env = process.env) =>
  flag("ASTROPATH_PASSWORD_LOGIN", env);

export interface CustodesConfig {
  /** Auth origin, no path or trailing slash. */
  origin: string;
  issuer: string;
  appId: string;
  clientId: string;
  clientSecret: string;
  /** Public Astropath origin. */
  appOrigin: string;
  /** Canonical MCP resource registered in Custodes. */
  resource: string;
  redirectUri: string;
  scope: string;
}

/** The Custodes application id this instance is registered as (default "astropath"). */
export const custodesAppId = (env: Env = process.env) =>
  env.CUSTODES_APP_ID?.trim() || DEFAULT_APP_ID;

/** Origin of the Custodes deployment, or null when CUSTODES_ORIGIN is unset or invalid. */
export function custodesOrigin(env: Env = process.env) {
  const value = env.CUSTODES_ORIGIN?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
export const custodesIssuer = (env: Env = process.env) => {
  const origin = custodesOrigin(env);
  return origin ? `${origin}/api/auth` : null;
};

/**
 * Returns null (Custodes sign-in disabled, behaviour exactly as before) unless the origin,
 * client id and client secret are all configured.
 */
export function custodesConfig(
  env: Env = process.env,
  app = appUrl(),
): CustodesConfig | null {
  const clientId = env.CUSTODES_CLIENT_ID?.trim();
  const clientSecret = env.CUSTODES_CLIENT_SECRET?.trim();
  const origin = custodesOrigin(env);
  if (!clientId || !clientSecret || !origin) return null;
  const appId = custodesAppId(env);
  return {
    origin,
    issuer: `${origin}/api/auth`,
    appId,
    clientId,
    clientSecret,
    appOrigin: app,
    resource: `${app}/mcp`,
    redirectUri: `${app}/api/auth/callback/custodes`,
    scope: `openid profile email offline_access app:${appId}`,
  };
}
