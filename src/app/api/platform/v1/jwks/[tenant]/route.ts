import { errorResponse } from "@/lib/errors";
import { jwksFor } from "@/lib/platform/apps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public keys that verify delegated tokens Astropath sends to apps.
export async function GET(
  _request: Request,
  context: { params: Promise<{ tenant: string }> },
) {
  try {
    return Response.json(await jwksFor((await context.params).tenant), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
