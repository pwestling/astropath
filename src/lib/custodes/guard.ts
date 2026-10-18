import { passwordLoginEnabled } from "./config";

/**
 * Staged-cutover switch for the Better Auth catch-all. Returns a response to refuse the
 * request, or null to let Better Auth handle it. Astropath's own OAuth/MCP provider endpoints
 * are never touched here.
 */
export function authRouteGuard(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Response | null {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (
    !passwordLoginEnabled(env) &&
    /^\/api\/auth\/(sign-in|sign-up)\/email$/.test(path)
  )
    return Response.json(
      {
        error: {
          code: "password_login_disabled",
          message: "Password sign-in is turned off. Sign in with Custodes.",
        },
      },
      { status: 403 },
    );
  return null;
}
