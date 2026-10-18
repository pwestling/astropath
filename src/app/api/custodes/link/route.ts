import { getAuth } from "@/lib/auth";
import { webDeps } from "@/lib/custodes/deps";
import { beginFlow } from "@/lib/custodes/web";
import { errorResponse, AppError } from "@/lib/errors";
import { checkOrigin } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Starts "Link Custodes account" for the user holding the current Astropath session. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });
    if (!session)
      throw new AppError(401, "unauthorized", "Sign in to Astropath first.");
    const { location, cookie } = await beginFlow(webDeps(), {
      purpose: "link",
      userId: session.user.id,
      sessionId: session.session.id,
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
    return errorResponse(error);
  }
}
