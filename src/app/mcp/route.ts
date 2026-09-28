import { requireMcpAuth } from "@better-auth/mcp";
import { getAuth } from "@/lib/auth";
import { appUrl } from "@/lib/config";
import { apiPrincipal, oauthPrincipal, rateLimit } from "@/lib/security";
import { errorResponse } from "@/lib/errors";
import { mcpFor } from "@/lib/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function oauthHandler(request: Request) {
  return requireMcpAuth(
    getAuth(),
    async (request, claims) => {
      const principal = await oauthPrincipal(claims);
      await rateLimit(principal);
      return mcpFor(principal, {
        authenticate: () => oauthPrincipal(claims, { touch: false }),
        signal: request.signal,
      }).fetch(request);
    },
    {
      resource: `${appUrl()}/mcp`,
      challengeScopes: ["astropath:read", "astropath:write"],
    },
  )(request);
}

async function handle(request: Request) {
  try {
    if (request.headers.get("authorization")?.startsWith("Bearer ap_")) {
      const principal = await apiPrincipal(request);
      await rateLimit(principal);
      return await mcpFor(principal, {
        authenticate: () => apiPrincipal(request, { touch: false }),
        signal: request.signal,
      }).fetch(request);
    }
    return await oauthHandler(request);
  } catch (error) {
    return errorResponse(error);
  }
}
export { handle as POST, handle as GET, handle as DELETE };
