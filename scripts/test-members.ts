import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { decodeJwt } from "jose";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { pool } from "../src/lib/db";
import { oauthPrincipal } from "../src/lib/security";
import { CONNECTION_CLAIM } from "../src/lib/identities";

const base = process.env.APP_URL!;
const suffix = randomUUID().slice(0, 8);
const space = `member-${suffix}`;
const nextSpace = `moved-${suffix}`;
const email = `member-${suffix}@example.com`;
const password = randomBytes(24).toString("base64url");
async function request(
  path: string,
  cookie = "",
  body?: unknown,
  expected = 200,
  method = body ? "POST" : "GET",
  token?: string,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      Cookie: cookie,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const data = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${response.status} ${data.error?.message || data.message || ""}`,
  );
  return { response, data };
}
async function login(email: string, password: string) {
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ email, password }),
    });
    if (response.status !== 429 || attempt === 2) break;
    await setTimeout(
      Math.min(60, Number(response.headers.get("retry-after")) || 11) * 1000 +
        100,
    );
  }
  assert.equal(response.status, 200, "Test account sign-in");
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
async function main() {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  assert.ok(
    ["localhost", "127.0.0.1"].includes(
      new URL(process.env.DATABASE_URL!).hostname,
    ),
    "Use a disposable local database",
  );
  assert.match(process.env.OWNER_EMAIL!, /^identity-test-/);
  const owner = await login(
    process.env.OWNER_EMAIL!,
    process.env.OWNER_PASSWORD!,
  );
  await request(
    "/api/v1/spaces",
    owner,
    { slug: space, name: "Member Personal" },
    201,
  );
  await request(
    "/api/v1/spaces",
    owner,
    { slug: nextSpace, name: "Member Moved" },
    201,
  );
  const privateMessage = (
    await request(
      "/api/v1/messages",
      owner,
      {
        title: `Owner secret ${suffix}`,
        body: "Not shared with member",
        space: "general",
      },
      201,
    )
  ).data.message;
  const ownerToken = (
    await request(
      "/api/v1/connections",
      owner,
      {
        name: `Owner Secret App ${suffix}`,
        scopes: ["astropath:read", "astropath:write"],
      },
      201,
    )
  ).data;
  const invite = (
    await request(
      "/api/v1/members",
      owner,
      { name: "Test Member", email, spaces: [space] },
      201,
    )
  ).data;
  const token = new URLSearchParams(
    new URL(invite.invite_url).hash.slice(1),
  ).get("token")!;
  const inspected = (
    await request("/api/invitations", "", { action: "inspect", token })
  ).data;
  assert.deepEqual(
    inspected.spaces.map((item: { slug: string }) => item.slug),
    [space],
  );
  await request(
    "/api/invitations",
    "",
    { action: "accept", token, password, spaces: ["general"] },
    400,
  );
  const accept = () =>
    fetch(`${base}/api/invitations`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "accept", token, password }),
    });
  const accepted = await Promise.all([accept(), accept()]);
  assert.deepEqual(accepted.map((r) => r.status).sort(), [200, 400]);
  await request("/api/invitations", "", { action: "inspect", token }, 400);
  let member = await login(email, password);
  const identity = (await request("/api/v1/me", member)).data.identity;
  assert.equal(identity.owner, false);
  assert.deepEqual(identity.spaces, [space]);
  assert.deepEqual(
    (await request("/api/v1/spaces", member)).data.spaces.map(
      (item: { slug: string }) => item.slug,
    ),
    [space],
  );
  await request("/api/v1/members", member, undefined, 403);
  await request(
    "/api/v1/spaces",
    member,
    { slug: `denied-${suffix}`, name: "Denied" },
    403,
  );
  await request(
    "/api/v1/connections",
    member,
    {
      name: `Denied ${suffix}`,
      scopes: ["astropath:read"],
      spaces: ["general"],
    },
    404,
  );
  const memberToken = (
    await request(
      "/api/v1/connections",
      member,
      {
        name: `Member App ${suffix}`,
        scopes: ["astropath:read", "astropath:write"],
        spaces: null,
      },
      201,
    )
  ).data;
  assert.deepEqual(
    (await request("/api/v1/me", "", undefined, 200, "GET", memberToken.token))
      .data.identity.spaces,
    [space],
  );
  await request(
    "/api/v1/connections",
    "",
    undefined,
    403,
    "GET",
    memberToken.token,
  );
  await request(
    "/api/v1/connections",
    "",
    { name: "Forbidden delegation", scopes: ["astropath:read"] },
    403,
    "POST",
    memberToken.token,
  );
  await request(
    `/api/v1/connections/${ownerToken.id}`,
    member,
    undefined,
    404,
    "DELETE",
  );
  assert.deepEqual(
    (await request("/api/v1/connections", member)).data.connections.map(
      (item: { id: string }) => item.id,
    ),
    [memberToken.id],
  );
  const ownMessage = (
    await request(
      "/api/v1/messages",
      "",
      { title: "Member default space" },
      201,
      "POST",
      memberToken.token,
    )
  ).data.message;
  assert.equal(ownMessage.space, space);
  await request(`/api/v1/messages/${privateMessage.id}`, member, undefined, 404);
  await request(
    `/api/v1/messages/${privateMessage.id}`,
    member,
    { pinned: true },
    404,
    "PATCH",
  );
  await request(
    `/api/v1/messages/${ownMessage.id}`,
    member,
    { pinned: true },
    200,
    "PATCH",
  );
  await request(
    "/api/v1/files/uploads",
    member,
    {
      name: "denied.txt",
      content_type: "text/plain",
      size: 3,
      space: "general",
    },
    404,
  );
  const privateFile = randomUUID();
  await pool.query(
    "INSERT INTO ap_files(id,space,name,content_type,size,pathname,principal_id,status,message_id) VALUES($1,'general','private.txt','text/plain',3,$2,'owner:test','ready',$3)",
    [privateFile, `test/${privateFile}`, privateMessage.id],
  );
  await request(
    `/api/v1/files/${privateFile}/download`,
    member,
    undefined,
    404,
  );
  const overview = (await request("/api/v1/overview", member)).data;
  assert.equal(overview.total, 1);
  assert.equal(overview.files, 0);
  assert.ok(!JSON.stringify(overview).includes(`Owner secret ${suffix}`));
  assert.ok(!JSON.stringify(overview).includes(`Owner Secret App ${suffix}`));
  console.log(
    "PASS: single-use invitations, member login, scoped UI/API data, default space, private files, and connection-management boundaries.",
  );

  const metadata = await (
    await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)
  ).json();
  const redirectUri = "http://127.0.0.1:3100/member-test-callback";
  const registration = (
    await request(
      "/api/auth/oauth2/register",
      owner,
      {
        client_name: `Shared member regression ${suffix}`,
        application_type: "native",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    )
  ).data;
  const clientId = registration.client_id;
  async function authorize(cookie: string, name: string) {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid offline_access astropath:read astropath:write",
      resource: `${base}/mcp`,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: randomUUID(),
    });
    const response = await fetch(
      `${metadata.authorization_endpoint}?${query}`,
      { headers: { Cookie: cookie }, redirect: "manual" },
    );
    const location =
      response.headers.get("location") || (await response.json()).url;
    const consent = new URL(location, base);
    assert.equal(consent.pathname, "/consent");
    const approved = (
      await request("/api/auth/oauth2/consent", cookie, {
        accept: true,
        identity_name: name,
        oauth_query: consent.search.slice(1),
        spaces: null,
      })
    ).data;
    const code = new URL(approved.url).searchParams.get("code")!;
    const tokens = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
        resource: `${base}/mcp`,
      }),
    });
    assert.equal(tokens.status, 200);
    return tokens.json();
  }
  const ownerOAuth = await authorize(owner, `Owner OAuth ${suffix}`);
  const memberOAuth = await authorize(member, `Member OAuth ${suffix}`);
  const principal = await oauthPrincipal(decodeJwt(memberOAuth.access_token));
  assert.deepEqual(principal.spaces, [space]);
  assert.equal(principal.userId, undefined);
  assert.notEqual(
    decodeJwt(ownerOAuth.access_token)[CONNECTION_CLAIM],
    principal.id,
  );
  const client = new Client({ name: "Member boundary test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${memberOAuth.access_token}` },
        },
      }),
    );
    const spaces = await client.callTool({
      name: "list_spaces",
      arguments: {},
    });
    assert.ok(JSON.stringify(spaces).includes(space));
    assert.ok(!JSON.stringify(spaces).includes('"slug":"general"'));
    const denied = await client.callTool({
      name: "read_message",
      arguments: { id: privateMessage.id },
    });
    assert.equal(denied.isError, true);
    const note = await client.callTool({
      name: "send_message",
      arguments: { title: "Member MCP default" },
    });
    assert.notEqual(note.isError, true);
  } finally {
    await client.close();
  }
  const refresh = async (refreshToken: string) =>
    fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: `${base}/mcp`,
      }),
    });
  const renewed = await refresh(memberOAuth.refresh_token);
  assert.equal(renewed.status, 200);
  const refreshed = await renewed.json();
  assert.deepEqual(
    (await oauthPrincipal(decodeJwt(refreshed.access_token))).spaces,
    [space],
  );
  console.log(
    "PASS: member OAuth, PKCE, shared client IDs, MCP data isolation, and scoped refresh tokens.",
  );
  await request(
    `/api/v1/members/${invite.member.id}`,
    owner,
    { spaces: [nextSpace] },
    200,
    "PATCH",
  );
  await request("/api/v1/spaces", "", undefined, 403, "GET", memberToken.token);
  await assert.rejects(
    oauthPrincipal(decodeJwt(refreshed.access_token)),
    /access/,
  );
  const deniedRefresh = await refresh(refreshed.refresh_token);
  assert.ok(deniedRefresh.status >= 400);
  assert.equal(
    (await oauthPrincipal(decodeJwt(ownerOAuth.access_token))).spaces,
    null,
  );
  await request(
    `/api/v1/members/${invite.member.id}`,
    owner,
    { disabled: true },
    200,
    "PATCH",
  );
  await request("/api/v1/me", member, undefined, 401);
  await request("/api/auth/sign-in/email", "", { email, password }, 403);
  await request("/api/v1/me", "", undefined, 403, "GET", memberToken.token);
  await request("/api/v1/me", owner);
  console.log(
    "PASS: changed membership limits existing tokens, disabled members lose sessions and login, owner connections remain unaffected.",
  );
  if (process.env.MEMBER_BROWSER_CHECK === "1") {
    await request(
      `/api/v1/members/${invite.member.id}`,
      owner,
      { spaces: [space], disabled: false },
      200,
      "PATCH",
    );
    member = await login(email, password);
    for (const [kind, cookie] of [
      ["owner", owner],
      ["member", member],
    ]) {
      const cookies = cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        domain: "localhost",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
        expires: -1,
      }));
      await writeFile(
        `.env.members-browser-${kind}.json`,
        JSON.stringify({ cookies, origins: [] }),
        { mode: 0o600 },
      );
    }
    const browserInvite = (
      await request(
        "/api/v1/members",
        owner,
        {
          name: "Browser Member",
          email: `browser-${suffix}@example.com`,
          spaces: [space],
        },
        201,
      )
    ).data;
    await writeFile(".env.members-browser-invite", browserInvite.invite_url, {
      mode: 0o600,
    });
    console.log("Private browser fixtures saved.");
  }
}
main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
