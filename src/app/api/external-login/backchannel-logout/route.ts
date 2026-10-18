import { systemDb } from "@/lib/db";
import { custodesConfig } from "@/lib/custodes/config";
import { handleBackchannelLogout } from "@/lib/custodes/logout";
import { accounts, custodesOidc } from "@/lib/custodes/runtime";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * OIDC back-channel logout. Authenticated only by the signature on the logout token. Ends the
 * matching local web sessions; Astropath's own OAuth/MCP tokens and connections are untouched.
 */
export async function POST(request: Request) {
  try {
    const config = custodesConfig();
    const oidc = custodesOidc();
    if (!config || !oidc)
      return Response.json(
        {
          error: {
            code: "not_configured",
            message: "Custodes sign-in is not configured.",
          },
        },
        { status: 501 },
      );
    const form = await request.formData().catch(() => null);
    const token = form?.get("logout_token");
    await handleBackchannelLogout(
      config,
      await oidc.keys(),
      accounts,
      systemDb,
      typeof token === "string" ? token : null,
    );
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
