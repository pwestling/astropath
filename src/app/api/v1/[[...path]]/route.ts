import { z } from "zod";
import { apiPrincipal, rateLimit, requireScope } from "@/lib/security";
import { store } from "@/lib/store";
import { AppError, errorResponse, jsonBody } from "@/lib/errors";
import {
  createUpload,
  completeUpload,
  downloadLink,
  uploadInline,
} from "@/lib/files";
import {
  createConnection,
  revokeConnection,
  listConnections,
  overview,
  listSpaces,
  createSpace,
} from "@/lib/admin";
import { fileInput } from "@/lib/validation";
import { MemberStore } from "@/lib/members";
import { db } from "@/lib/db";
import { chat } from "@/lib/chat";

const members = new MemberStore(db);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  try {
    const principal = await apiPrincipal(request);
    await rateLimit(principal);
    const path = (await context.params).path || [];
    const route = path.join("/");
    const url = new URL(request.url);
    const method = request.method;
    let result: unknown;
    let status = 200;
    if (route === "me" && method === "GET") result = { identity: principal };
    else if (route === "messages/wait" && method === "POST") {
      result = await chat.waitMessages(principal, await jsonBody(request), {
        authenticate: () => apiPrincipal(request, { touch: false }),
        signal: request.signal,
      });
    } else if (
      path[0] === "messages" &&
      path.length === 3 &&
      path[2] === "wait" &&
      method === "POST"
    ) {
      const input = z
        .record(z.string(), z.unknown())
        .parse(await jsonBody(request));
      result = await chat.waitReply(
        principal,
        { ...input, message_id: path[1] },
        {
          authenticate: () => apiPrincipal(request, { touch: false }),
          signal: request.signal,
        },
      );
    } else if (
      path[0] === "messages" &&
      path.length === 3 &&
      path[2] === "replies" &&
      method === "POST"
    ) {
      const input = z
        .record(z.string(), z.unknown())
        .parse(await jsonBody(request));
      result = await chat.reply(principal, {
        ...input,
        message_id: path[1],
        idempotency_key:
          request.headers.get("idempotency-key") || input.idempotency_key,
      });
      status = 201;
    } else if (
      path[0] === "messages" &&
      path.length === 3 &&
      path[2] === "thread" &&
      method === "GET"
    ) {
      result = await chat.thread(principal, {
        message_id: path[1],
        page: url.searchParams.get("page") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 20),
      });
    } else if (route === "messages" && method === "GET") {
      result = await store.list(principal, {
        space: url.searchParams.get("space") || undefined,
        q: url.searchParams.get("q") || undefined,
        recipient: url.searchParams.get("recipient") || undefined,
        unread: url.searchParams.get("unread") === "true",
        with_files: url.searchParams.get("with_files") === "true",
        archived: url.searchParams.get("archived") === "true",
        pinned: url.searchParams.get("pinned") === "true",
        limit: Number(url.searchParams.get("limit") || 30),
        cursor: url.searchParams.get("cursor") || undefined,
      });
    } else if (route === "messages" && method === "POST") {
      result = await store.create(
        principal,
        await jsonBody(request),
        request.headers.get("idempotency-key") || undefined,
      );
      status = 201;
    } else if (path[0] === "messages" && path.length === 2 && method === "GET")
      result = await store.detail(principal, path[1]);
    else if (path[0] === "messages" && path.length === 2 && method === "PATCH")
      result = await store.update(principal, path[1], await jsonBody(request));
    else if (
      path[0] === "messages" &&
      path.length === 3 &&
      path[2] === "acknowledge" &&
      method === "POST"
    )
      result = await store.acknowledge(principal, z.uuid().parse(path[1]));
    else if (route === "files/uploads" && method === "POST") {
      result = await createUpload(principal, await jsonBody(request));
      status = 201;
    } else if (route === "files/inline" && method === "POST") {
      const { content_base64, ...metadata } = fileInput
        .extend({ content_base64: z.string().max(2800000) })
        .parse(await jsonBody(request));
      result = await uploadInline(principal, metadata, content_base64);
      status = 201;
    } else if (
      path[0] === "files" &&
      path.length === 3 &&
      path[2] === "complete" &&
      method === "POST"
    )
      result = await completeUpload(principal, z.uuid().parse(path[1]));
    else if (
      path[0] === "files" &&
      path.length === 3 &&
      path[2] === "download" &&
      method === "GET"
    )
      result = await downloadLink(principal, z.uuid().parse(path[1]));
    else if (route === "connections" && method === "GET")
      result = await listConnections(principal);
    else if (route === "connections" && method === "POST") {
      result = await createConnection(principal, await jsonBody(request));
      status = 201;
    } else if (
      path[0] === "connections" &&
      path.length === 2 &&
      method === "DELETE"
    )
      result = await revokeConnection(principal, path[1]);
    else if (route === "members" && method === "GET")
      result = await members.list(principal);
    else if (route === "members" && method === "POST") {
      result = await members.create(principal, await jsonBody(request));
      status = 201;
    } else if (path[0] === "members" && path.length === 2 && method === "PATCH")
      result = await members.update(
        principal,
        path[1],
        await jsonBody(request),
      );
    else if (
      path[0] === "members" &&
      path.length === 3 &&
      path[2] === "invite" &&
      method === "POST"
    )
      result = await members.reinvite(principal, path[1]);
    else if (route === "overview" && method === "GET")
      result = await overview(principal);
    else if (route === "spaces" && method === "GET") {
      requireScope(principal, "astropath:read");
      result = await listSpaces(principal);
    } else if (route === "spaces" && method === "POST") {
      result = await createSpace(principal, await jsonBody(request));
      status = 201;
    } else throw new AppError(404, "not_found", "Endpoint not found.");
    return Response.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    if (response.status === 401)
      response.headers.set("WWW-Authenticate", 'Bearer realm="Astropath"');
    if (response.status === 429) response.headers.set("Retry-After", "60");
    return response;
  }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
