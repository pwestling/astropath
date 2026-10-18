import { webDeps } from "@/lib/custodes/deps";
import { handleCallback } from "@/lib/custodes/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handleCallback(request, webDeps());
}
