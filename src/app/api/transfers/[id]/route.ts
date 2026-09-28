import { transfer } from "@/lib/file-transfers";
import { errorResponse } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return await transfer(request, (await context.params).id);
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
export { handle as GET, handle as PUT };
