import { AppError } from "../errors";
import {
  REFUSALS,
  type CurrentSession,
  type CustodesAccounts,
} from "./accounts";
import type { CustodesIdentity } from "./oidc";

export const FLOW_COOKIE = "ap_custodes_flow";

export interface WebDeps {
  appOrigin: string;
  /** Null when the CUSTODES_* client settings are not configured. */
  oidc: {
    authorizationUrl(flow: {
      state: string;
      nonce: string;
      verifier: string;
    }): Promise<string>;
    exchange(
      code: string,
      flow: { verifier: string; nonce: string },
    ): Promise<CustodesIdentity>;
  } | null;
  accounts: CustodesAccounts;
  /** The Astropath web session the browser currently holds, if valid. */
  currentSession(
    headers: Headers,
  ): Promise<(CurrentSession & { token: string }) | null>;
  /** Creates a normal Astropath session; returns the response carrying its cookie. */
  createSession(input: {
    userId: string;
    issuer: string;
    subject: string;
    sid: string | null;
    oauth_query?: string;
    replace?: { sessionId: string; token: string };
  }): Promise<Response>;
  /** Checks an invitation token (throws AppError when unusable). */
  checkInvite(token: string): Promise<void>;
}

function cookie(deps: WebDeps, value: string, maxAge: number) {
  const secure = deps.appOrigin.startsWith("https:") ? "; Secure" : "";
  return `${FLOW_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function cookieValue(headers: Headers) {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === FLOW_COOKIE) return rest.join("=");
  }
  return undefined;
}
function redirect(
  deps: WebDeps,
  path: string,
  headers: [string, string][] = [],
) {
  const response = new Response(null, {
    status: 303,
    headers: {
      Location: `${deps.appOrigin}${path}`,
      "Cache-Control": "no-store",
    },
  });
  for (const [name, value] of headers) response.headers.append(name, value);
  return response;
}

/**
 * When Better Auth resumed an interrupted authorization, its reply carries the next URL (the
 * consent page or the client redirect). Only same-origin URLs are followed.
 */
async function resumeUrl(response: Response, appOrigin: string) {
  if (!response.ok) return null;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as {
    url?: unknown;
  } | null;
  if (typeof body?.url !== "string") return null;
  try {
    const target = new URL(body.url, appOrigin);
    return target.origin === appOrigin ? target.toString() : null;
  } catch {
    return null;
  }
}

/** Starts a Custodes authorization. Returns the Custodes URL and the cookie tying the reply to this browser. */
export async function beginFlow(
  deps: WebDeps,
  input:
    | { purpose: "login"; inviteToken?: string; oauthQuery?: string }
    | { purpose: "link"; userId: string; sessionId: string },
) {
  if (!deps.oidc)
    throw new AppError(
      503,
      "custodes_not_configured",
      REFUSALS.custodes_not_configured,
    );
  if (input.purpose === "login" && input.inviteToken)
    await deps.checkInvite(input.inviteToken);
  const flow = await deps.accounts.startFlow(input);
  return {
    location: await deps.oidc.authorizationUrl(flow),
    cookie: cookie(deps, flow.flowId, 600),
  };
}

/** GET /api/auth/callback/custodes */
export async function handleCallback(
  request: Request,
  deps: WebDeps,
): Promise<Response> {
  const clear = ["Set-Cookie", cookie(deps, "", 0)] as [string, string];
  const url = new URL(request.url);
  const fail = (purpose: "login" | "link", code: string) =>
    redirect(
      deps,
      purpose === "link"
        ? `/?custodes=${encodeURIComponent(code)}`
        : `/login?error=${encodeURIComponent(code)}`,
      [clear],
    );
  let purpose: "login" | "link" = "login";
  try {
    if (!deps.oidc)
      throw new AppError(
        503,
        "custodes_not_configured",
        REFUSALS.custodes_not_configured,
      );
    const flow = await deps.accounts.consumeFlow(
      cookieValue(request.headers),
      url.searchParams.get("state") ?? undefined,
    );
    purpose = flow.purpose;
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code)
      return fail(purpose, "custodes_denied");
    const identity = await deps.oidc.exchange(code, flow);
    const current =
      flow.purpose === "link"
        ? await deps.currentSession(request.headers)
        : null;
    const done = await deps.accounts.complete(identity, flow, current);
    const create = (oauthQuery?: string) =>
      deps.createSession({
        userId: done.userId,
        issuer: identity.issuer,
        subject: identity.subject,
        sid: identity.sid,
        ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        replace:
          flow.purpose === "link" && current
            ? { sessionId: current.sessionId, token: current.token }
            : undefined,
      });
    let session: Response;
    let resume: string | null = null;
    if (flow.purpose === "login" && flow.oauthQuery) {
      // Resume an interrupted MCP/OAuth authorization. If the signed query has expired or
      // fails verification, nothing was created; sign in normally instead.
      try {
        session = await create(flow.oauthQuery);
        resume = await resumeUrl(session, deps.appOrigin);
      } catch {
        session = await create();
      }
    } else session = await create();
    const headers: [string, string][] = [clear];
    for (const value of session.headers.getSetCookie())
      headers.push(["Set-Cookie", value]);
    if (done.tenantId) {
      // Land in the workspace the person just joined, as the password invitation flow does.
      const secure = deps.appOrigin.startsWith("https:") ? "; Secure" : "";
      headers.push([
        "Set-Cookie",
        `astropath_tenant=${done.tenantId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
      ]);
    }
    if (resume) {
      const response = redirect(deps, "/", headers);
      response.headers.set("Location", resume);
      return response;
    }
    return redirect(
      deps,
      flow.purpose === "link" ? "/?custodes=linked" : "/",
      headers,
    );
  } catch (error) {
    if (error instanceof AppError) return fail(purpose, error.code);
    console.error(
      "Custodes callback failed",
      error instanceof Error ? error.message : "Unknown error",
    );
    return fail(purpose, "custodes_unavailable");
  }
}
