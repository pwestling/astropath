import { permissionHandler } from "@/lib/permissions/runtime";

// Served at /_custodes/permissions (the %5F folder name is how Next.js spells a leading
// underscore). Authenticated only by Custodes' signed management token; there is no session or
// CSRF layer here, and no redirect to the sign-in page.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  const handler = permissionHandler();
  if (!handler)
    return Response.json(
      { error: "Permission management is not configured", outcome: "rejected" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  return handler(request);
}
export { handle as GET, handle as POST };
