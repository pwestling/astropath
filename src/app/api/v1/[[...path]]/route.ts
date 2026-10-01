import { z } from "zod";
import { apiPrincipal, rateLimit, requireScope } from "@/lib/security";
import { store } from "@/lib/store";
import { AppError, errorResponse, jsonBody } from "@/lib/errors";
import {
  createUpload,
  completeUpload,
  downloadLink,
  uploadInline,
} from "@/lib/file-transfers";
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
import { skills } from "@/lib/skills";
import {
  listTenants,
  createTenant,
  platformTenants,
  setTenantDisabled,
  assertTenantMember,
} from "@/lib/tenants";
import { requireAccount } from "@/lib/policy";
import { memory } from "@/lib/memory";
import { currentGuidance } from "@/lib/guidance";
import {
  createPublicUpload,
  listPublicFiles,
  publicUploadStatus,
} from "@/lib/public-files";

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
    else if (route === "tenants" && method === "GET")
      result = await listTenants(principal);
    else if (route === "tenants" && method === "POST") {
      result = await createTenant(principal, await jsonBody(request));
      status = 201;
    } else if (route === "tenants/select" && method === "POST") {
      const { tenant_id } = z
        .object({ tenant_id: z.uuid() })
        .strict()
        .parse(await jsonBody(request));
      await assertTenantMember(requireAccount(principal), tenant_id);
      return Response.json(
        { tenant_id },
        {
          headers: {
            "Cache-Control": "no-store",
            "Set-Cookie": `astropath_tenant=${tenant_id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${url.protocol === "https:" ? "; Secure" : ""}`,
          },
        },
      );
    } else if (route === "admin/tenants" && method === "GET")
      result = await platformTenants(principal);
    else if (
      path[0] === "admin" &&
      path[1] === "tenants" &&
      path.length === 3 &&
      method === "PATCH"
    )
      result = await setTenantDisabled(
        principal,
        path[2],
        await jsonBody(request),
      );
    else if (route === "public-files/config" && method === "GET") {
      requireScope(principal, "astropath:read");
      result = publicUploadStatus();
    } else if (route === "public-files" && method === "GET")
      result = await listPublicFiles(principal, {
        space: url.searchParams.get("space") ?? undefined,
        before: url.searchParams.get("before") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 30),
      });
    else if (route === "public-files/uploads" && method === "POST") {
      result = await createPublicUpload(principal, await jsonBody(request));
      status = 201;
    } else if (route === "guidance" && method === "GET")
      result = currentGuidance(principal);
    else if (route === "memories" && method === "POST") {
      const saved = await memory.remember(principal, await jsonBody(request));
      result = saved;
      status = saved.replayed ? 200 : 201;
    } else if (route === "memories" && method === "GET")
      result = await memory.recall(principal, {
        space: url.searchParams.get("space") ?? undefined,
        q: url.searchParams.get("q") ?? undefined,
        session_key: url.searchParams.get("session_key") ?? undefined,
        session_id: url.searchParams.get("session_id") ?? undefined,
        principal_id: url.searchParams.get("principal_id") ?? undefined,
        no_session: url.searchParams.get("no_session") === "true",
        before: url.searchParams.get("before") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 30),
      });
    else if (route === "memory-sessions" && method === "GET")
      result = await memory.sessions(principal, {
        space: url.searchParams.get("space") ?? undefined,
        principal_id: url.searchParams.get("principal_id") ?? undefined,
        before: url.searchParams.get("before") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 30),
      });
    else if (route === "work-notes" && method === "POST") {
      const recorded = await memory.recordWorkNote(
        principal,
        await jsonBody(request),
      );
      result = recorded;
      status = recorded.replayed ? 200 : 201;
    } else if (["topics", "topic-notes", "agent-sessions"].includes(path[0]))
      throw new AppError(
        410,
        "retired",
        "Topics were replaced by the memory log. Save with POST /api/v1/memories and search with GET /api/v1/memories.",
      );
    else if (route === "skills" && method === "GET")
      result = await skills.list(principal, {
        space: url.searchParams.get("space") ?? undefined,
        include_deprecated:
          url.searchParams.get("include_deprecated") === "true",
        after: url.searchParams.get("after") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? 30),
      });
    else if (route === "skills" && method === "POST") {
      result = await skills.publish(principal, await jsonBody(request));
      status = 201;
    } else if (path[0] === "skills" && path.length === 2 && method === "GET")
      result = await skills.pull(principal, {
        slug: path[1],
        space: url.searchParams.get("space") ?? "general",
        revision_id: url.searchParams.get("revision_id") ?? undefined,
      });
    else if (path[0] === "skills" && path.length === 2 && method === "PATCH") {
      const input = z
        .record(z.string(), z.unknown())
        .parse(await jsonBody(request));
      result = await skills.deprecate(principal, { ...input, slug: path[1] });
    } else if (
      path[0] === "skills" &&
      path.length === 3 &&
      path[2] === "revisions" &&
      method === "GET"
    )
      result = await skills.history(principal, {
        slug: path[1],
        space: url.searchParams.get("space") ?? "general",
        before: url.searchParams.has("before")
          ? Number(url.searchParams.get("before"))
          : undefined,
        limit: Number(url.searchParams.get("limit") ?? 30),
      });
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
