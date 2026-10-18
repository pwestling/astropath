import { z } from "zod";
import { webDeps } from "@/lib/custodes/deps";
import { beginFlow } from "@/lib/custodes/web";
import { errorResponse, jsonBody } from "@/lib/errors";
import { checkOrigin, hash, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const limit = (request: Request) =>
  rateLimit({
    id: `custodes-login:${hash(request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown")}`,
    name: "Custodes sign-in",
    owner: false,
    scopes: [],
    spaces: [],
  });
/** Plain sign-in: a link from the login page. */
export async function GET(request: Request) {
  const deps = webDeps();
  try {
    await limit(request);
    const oauthQuery =
      new URL(request.url).searchParams.get("oauth_query") ?? undefined;
    const { location, cookie } = await beginFlow(deps, {
      purpose: "login",
      oauthQuery:
        oauthQuery && oauthQuery.length <= 4096 ? oauthQuery : undefined,
    });
    return new Response(null, {
      status: 303,
      headers: {
        Location: location,
        "Set-Cookie": cookie,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const code = (error as { code?: string }).code ?? "custodes_unavailable";
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${deps.appOrigin}/login?error=${encodeURIComponent(code)}`,
        "Cache-Control": "no-store",
      },
    });
  }
}
/** Sign-in to accept an invitation. The token never travels in a URL. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await limit(request);
    const input = z
      .object({ invite: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(await jsonBody(request, 2000));
    const { location, cookie } = await beginFlow(webDeps(), {
      purpose: "login",
      inviteToken: input.invite,
    });
    return Response.json(
      { location },
      { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
