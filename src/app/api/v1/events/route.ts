import { apiPrincipal, rateLimit } from "@/lib/security";
import { db } from "@/lib/db";
import { errorResponse } from "@/lib/errors";
import { EventStore } from "@/lib/events";
import { eventResponse } from "@/lib/event-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const events = new EventStore(db);

export async function GET(request: Request) {
  try {
    const principal = await apiPrincipal(request);
    await rateLimit(principal);
    return await eventResponse(request, principal, events, () =>
      apiPrincipal(request, { touch: false }),
    );
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    if (response.status === 401)
      response.headers.set("WWW-Authenticate", 'Bearer realm="Astropath"');
    if (response.status === 429) response.headers.set("Retry-After", "60");
    return response;
  }
}

// Avoid Next's implicit HEAD invoking GET and starting a stream without a reader.
export function HEAD() {
  return new Response(null, { status: 405, headers: { Allow: "GET" } });
}
