import { rateLimit } from "@/lib/security";
import { errorResponse, jsonBody } from "@/lib/errors";
import { publisherFor, publishRelease } from "@/lib/platform/apps";
import { PlatformError } from "@/lib/platform/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An app's deploy publishes its release here with its publisher key. The key
// can publish only its own namespace, and calls go only to the origin the
// workspace owner set for the app.
export async function POST(
  request: Request,
  context: { params: Promise<{ app: string }> },
) {
  try {
    const publisher = await publisherFor(request);
    if ((await context.params).app !== publisher.app)
      throw new PlatformError(
        "FORBIDDEN",
        "This publisher key belongs to a different app.",
      );
    await rateLimit({
      id: `publisher:${publisher.tenantId}:${publisher.app}`,
      name: publisher.app,
      owner: false,
      scopes: [],
      spaces: [],
    });
    const result = await publishRelease(
      publisher,
      await jsonBody(request, 1000000),
    );
    return Response.json(result, {
      status: result.replayed ? 200 : 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
