import { z } from "zod";
import { systemDb as db } from "@/lib/db";
import { MemberStore } from "@/lib/members";
import { getAuth } from "@/lib/auth";
import { checkOrigin, rateLimit, hash } from "@/lib/security";
import { AppError, errorResponse, jsonBody } from "@/lib/errors";

export const runtime = "nodejs";
const members = new MemberStore(db);
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    await rateLimit({
      id: `invite:${hash(request.headers.get("x-forwarded-for")?.split(",")[0] || "unknown")}`,
      name: "Invitation",
      owner: false,
      scopes: [],
      spaces: [],
    });
    const body = z
      .discriminatedUnion("action", [
        z
          .object({ action: z.literal("inspect"), token: z.string().max(100) })
          .strict(),
        z
          .object({
            action: z.literal("accept"),
            token: z.string().max(100),
            password: z.string().min(12).max(128),
          })
          .strict(),
        z
          .object({
            action: z.literal("accept_existing"),
            token: z.string().max(100),
          })
          .strict(),
      ])
      .parse(await jsonBody(request, 8000));
    let result;
    if (body.action === "inspect") result = await members.inspect(body.token);
    else if (body.action === "accept")
      result = await members.accept(body.token, body.password);
    else {
      const session = await getAuth().api.getSession({
        headers: request.headers,
      });
      if (!session)
        throw new AppError(
          401,
          "sign_in_required",
          "Sign in to accept this invitation.",
        );
      result = await members.acceptExisting(body.token, session.user.id);
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
