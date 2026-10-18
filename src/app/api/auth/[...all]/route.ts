import { getAuth } from "@/lib/auth";
import { authRouteGuard } from "@/lib/custodes/guard";
import { handleNamedConsent } from "@/lib/oauth-identities";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return authRouteGuard(request) ?? getAuth().handler(request);
}
export async function POST(request: Request) {
  return (
    authRouteGuard(request) ??
    handleNamedConsent(request, (incoming) => getAuth().handler(incoming))
  );
}
