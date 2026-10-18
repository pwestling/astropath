import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  custodesConfig,
  passwordLoginEnabled,
} from "../src/lib/custodes/config";
import {
  beginFlow,
  handleCallback,
  FLOW_COOKIE,
  type WebDeps,
} from "../src/lib/custodes/web";
import { authRouteGuard } from "../src/lib/custodes/guard";
import {
  APP,
  CLIENT_ID,
  createEnv,
  fakeOidc,
  hash,
  INITIAL_TENANT,
  ISSUER,
  linkRow,
  resetFixture,
  sign,
  signingKey,
  type Env,
  type Signer,
} from "./helpers/custodes-env";

let env: Env, signer: Signer, other: Signer;
let claims: Record<string, unknown> | null,
  signWith: Signer,
  idOptions: Parameters<typeof sign>[2];
let created: Parameters<WebDeps["createSession"]>[0][];
let session: { sessionId: string; userId: string; token: string } | null;
let lastNonce = "";
let failFirstResume = false;

function deps(): WebDeps {
  const oidc = fakeOidc(signer, async () => {
    if (!claims) return null;
    return {
      id_token: await sign(
        signWith,
        { nonce: lastNonce, ...claims },
        { audience: CLIENT_ID, ...idOptions },
      ),
    };
  });
  return {
    appOrigin: APP,
    oidc,
    accounts: env.accounts,
    currentSession: async () => session,
    createSession: async (input) => {
      created.push(input);
      if (input.oauth_query && failFirstResume)
        throw new Error("signed query expired");
      return input.oauth_query
        ? Response.json(
            { redirect: true, url: `${APP}/consent?client_id=c1` },
            {
              headers: {
                "Set-Cookie": "better-auth.session_token=fresh; Path=/",
              },
            },
          )
        : new Response(null, {
            headers: {
              "Set-Cookie": "better-auth.session_token=fresh; Path=/",
            },
          });
    },
    checkInvite: async (token) => void (await env.members.inspect(token)),
  };
}
async function begin(
  options: Parameters<typeof beginFlow>[1] = { purpose: "login" },
) {
  const { location, cookie } = await beginFlow(deps(), options);
  const url = new URL(location);
  lastNonce = url.searchParams.get("nonce")!;
  return {
    url,
    cookie: cookie.split(";")[0],
    state: url.searchParams.get("state")!,
  };
}
const callback = (cookie: string | null, params: Record<string, string>) =>
  handleCallback(
    new Request(
      `${APP}/api/auth/callback/custodes?${new URLSearchParams(params)}`,
      { headers: cookie ? { cookie } : {} },
    ),
    deps(),
  );
const where = (r: Response) => r.headers.get("location")!.replace(APP, "");
const identities = async () =>
  (
    await env.database.query<{ subject: string; user_id: string }>(
      "SELECT subject,user_id FROM ap_custodes_identities ORDER BY subject",
    )
  ).rows;

beforeAll(async () => {
  env = await createEnv();
  signer = await signingKey();
  other = await signingKey();
});
afterAll(() => env.engine.close());
beforeEach(async () => {
  await resetFixture(env);
  await linkRow(env, "owner", "sub-owner");
  claims = {
    sub: "sub-owner",
    email: "owner@example.test",
    email_verified: true,
    name: "Owner",
    sid: "sid-1",
  };
  signWith = signer;
  idOptions = {};
  created = [];
  session = null;
  failFirstResume = false;
});

it("redirects to Custodes with PKCE, state, nonce, app scope and the MCP resource", async () => {
  const { url, cookie } = await begin();
  expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth2/authorize`);
  const q = url.searchParams;
  expect(q.get("response_type")).toBe("code");
  expect(q.get("client_id")).toBe(CLIENT_ID);
  expect(q.get("redirect_uri")).toBe(`${APP}/api/auth/callback/custodes`);
  expect(q.get("code_challenge_method")).toBe("S256");
  expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(q.get("scope")).toBe(
    "openid profile email offline_access app:astropath",
  );
  expect(q.get("resource")).toBe(`${APP}/mcp`);
  expect(cookie.startsWith(`${FLOW_COOKIE}=`)).toBe(true);
  expect(url.toString()).not.toContain("verifier");
});

it("signs a linked user in: creates a local session and records the Custodes sid", async () => {
  const { cookie, state } = await begin();
  const response = await callback(cookie, { code: "c", state });
  expect(response.status).toBe(303);
  expect(where(response)).toBe("/");
  expect(response.headers.getSetCookie().join("\n")).toContain(
    "better-auth.session_token=fresh",
  );
  expect(created).toEqual([
    {
      userId: "owner",
      issuer: ISSUER,
      subject: "sub-owner",
      sid: "sid-1",
      replace: undefined,
    },
  ]);
  const row = (
    await env.database.query<{ last_login_at: Date | null }>(
      "SELECT last_login_at FROM ap_custodes_identities WHERE subject='sub-owner'",
    )
  ).rows[0];
  expect(row.last_login_at).not.toBeNull();
});

it("resumes an interrupted MCP authorization, and falls back when the signed query is unusable", async () => {
  const query = "client_id=c1&response_type=code&sig=abc&exp=123";
  let r = await begin({ purpose: "login", oauthQuery: query });
  let response = await callback(r.cookie, { code: "c", state: r.state });
  expect(created[0].oauth_query).toBe(query);
  expect(response.headers.get("location")).toBe(`${APP}/consent?client_id=c1`);
  failFirstResume = true;
  created = [];
  r = await begin({ purpose: "login", oauthQuery: query });
  response = await callback(r.cookie, { code: "c", state: r.state });
  expect(created.map((c) => !!c.oauth_query)).toEqual([true, false]);
  expect(where(response)).toBe("/");
});

it("validates state, flow cookie, single use and expiry", async () => {
  let r = await begin();
  expect(where(await callback(r.cookie, { code: "c", state: "wrong" }))).toBe(
    "/login?error=custodes_flow_invalid",
  );
  // The failed attempt consumed the flow, so even the right state cannot be replayed.
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/login?error=custodes_flow_invalid",
  );
  r = await begin();
  expect(where(await callback(null, { code: "c", state: r.state }))).toBe(
    "/login?error=custodes_flow_invalid",
  );
  r = await begin();
  expect((await callback(r.cookie, { code: "c", state: r.state })).status).toBe(
    303,
  );
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/login?error=custodes_flow_invalid",
  );
  r = await begin();
  await env.engine.exec(
    "UPDATE ap_custodes_flows SET expires_at=now()-interval '1 second'",
  );
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/login?error=custodes_flow_invalid",
  );
  expect(created).toHaveLength(1); // only the one valid, unreplayed attempt
});

it("rejects wrong nonce, issuer, audience, expiry, signature and algorithm", async () => {
  const cases: [string, () => void][] = [
    ["nonce", () => (claims = { ...claims, nonce: "other" })],
    ["issuer", () => (idOptions = { issuer: "https://evil.test/api/auth" })],
    ["audience", () => (idOptions = { audience: "someone-else" })],
    [
      "expiry",
      () => (idOptions = { expires: Math.floor(Date.now() / 1000) - 120 }),
    ],
    ["signature", () => (signWith = other)],
    ["subject", () => (claims = { ...claims, sub: "" })],
  ];
  for (const [name, mutate] of cases) {
    claims = {
      sub: "sub-owner",
      email: "owner@example.test",
      email_verified: true,
      name: "Owner",
    };
    signWith = signer;
    idOptions = {};
    mutate();
    const r = await begin();
    const response = await callback(r.cookie, { code: "c", state: r.state });
    expect(where(response), name).toMatch(
      /^\/login\?error=custodes_(rejected|unavailable)$/,
    );
  }
  expect(created).toHaveLength(0);
});

it("surfaces a denial or missing code without creating a session", async () => {
  const r = await begin();
  expect(
    where(await callback(r.cookie, { error: "access_denied", state: r.state })),
  ).toBe("/login?error=custodes_denied");
  expect(created).toHaveLength(0);
});

it("refuses an unmapped Custodes account even when its verified email matches a local user", async () => {
  claims = {
    sub: "stranger",
    email: "izzy@example.test",
    email_verified: true,
    name: "Izzy",
  };
  const r = await begin();
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/login?error=custodes_unlinked",
  );
  expect(created).toHaveLength(0);
  expect((await identities()).map((i) => i.subject)).toEqual(["sub-owner"]);
});

it("refuses a linked account that no longer has workspace access", async () => {
  await linkRow(env, "izzy", "sub-izzy");
  await env.engine.exec(
    "UPDATE ap_members SET disabled_at=now() WHERE user_id='izzy'",
  );
  claims = {
    sub: "sub-izzy",
    email: "izzy@example.test",
    email_verified: true,
    name: "Izzy",
  };
  const r = await begin();
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/login?error=custodes_no_access",
  );
  expect(created).toHaveLength(0);
});

// ---- linking ----
const linkFlow = async (userId: string, sessionId: string) =>
  begin({ purpose: "link", userId, sessionId });

it("links only while the browser holds the session that started the flow", async () => {
  claims = {
    sub: "sub-izzy",
    email: "x@example.test",
    email_verified: true,
    name: "I",
    sid: "s9",
  };
  // No session at all.
  let r = await linkFlow("izzy", "legacy-izzy");
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/?custodes=custodes_link_session",
  );
  // A different user's session.
  session = { sessionId: "legacy-owner", userId: "owner", token: "t1" };
  r = await linkFlow("izzy", "legacy-izzy");
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/?custodes=custodes_link_session",
  );
  // A different session of the same user (not the one that started it).
  session = { sessionId: "other", userId: "izzy", token: "t3" };
  r = await linkFlow("izzy", "legacy-izzy");
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/?custodes=custodes_link_session",
  );
  expect((await identities()).map((i) => i.subject)).toEqual(["sub-owner"]);
  // The right session links, records audit fields, rotates the session.
  session = { sessionId: "legacy-izzy", userId: "izzy", token: "t2" };
  r = await linkFlow("izzy", "legacy-izzy");
  const response = await callback(r.cookie, { code: "c", state: r.state });
  expect(where(response)).toBe("/?custodes=linked");
  expect(created.at(-1)).toMatchObject({
    userId: "izzy",
    subject: "sub-izzy",
    sid: "s9",
    replace: { sessionId: "legacy-izzy", token: "t2" },
  });
  const row = (
    await env.database.query<Record<string, unknown>>(
      "SELECT user_id,linked_via,linked_email,linked_session_id FROM ap_custodes_identities WHERE subject='sub-izzy'",
    )
  ).rows[0];
  expect(row).toMatchObject({
    user_id: "izzy",
    linked_via: "session",
    linked_email: "x@example.test",
    linked_session_id: "legacy-izzy",
  });
  const audit = await env.database.query(
    "SELECT 1 FROM ap_custodes_audit WHERE action='link_custodes'",
  );
  expect(audit.rows).toHaveLength(1);
  // The linked person can now sign in with Custodes alone.
  session = null;
  const login = await begin();
  expect(
    where(await callback(login.cookie, { code: "c", state: login.state })),
  ).toBe("/");
  expect(created.at(-1)).toMatchObject({ userId: "izzy" });
});

it("never moves a Custodes identity or a local user between links", async () => {
  session = { sessionId: "legacy-izzy", userId: "izzy", token: "t2" };
  // sub-owner already belongs to owner.
  claims = { sub: "sub-owner", name: "x" };
  let r = await linkFlow("izzy", "legacy-izzy");
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/?custodes=custodes_already_linked",
  );
  // owner is already linked to a different Custodes account.
  session = { sessionId: "legacy-owner", userId: "owner", token: "t1" };
  claims = { sub: "sub-second", name: "x" };
  r = await linkFlow("owner", "legacy-owner");
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/?custodes=custodes_user_linked",
  );
  expect(await identities()).toEqual([
    { subject: "sub-owner", user_id: "owner" },
  ]);
});

it("races: two concurrent links of one Custodes identity produce exactly one mapping", async () => {
  claims = { sub: "sub-race", name: "x" };
  const results = await Promise.all(
    ["izzy", "owner"].map(async (user) => {
      session = { sessionId: `legacy-${user}`, userId: user, token: "t" };
      const r = await linkFlow(user, `legacy-${user}`);
      return env.accounts
        .complete(
          {
            issuer: ISSUER,
            subject: "sub-race",
            email: null,
            name: "x",
            sid: null,
          },
          await env.accounts.consumeFlow(r.cookie.split("=")[1], r.state),
          { sessionId: `legacy-${user}`, userId: user },
        )
        .then(
          () => "ok",
          (e) => e.code,
        );
    }),
  );
  expect(results.filter((r) => r === "ok")).toHaveLength(1);
  expect(
    (await identities()).filter((i) => i.subject === "sub-race"),
  ).toHaveLength(1);
});

// ---- invitations ----
async function invite(email: string, name = "Newcomer") {
  const { invite_url } = await env.members.create(
    {
      tenantId: INITIAL_TENANT,
      id: "owner:owner",
      userId: "owner",
      name: "Owner",
      owner: true,
      spaces: null,
      scopes: [],
    },
    { email, name, spaces: ["personal"] },
  );
  return new URL(invite_url).hash.slice(7);
}

it("an invitation accepted through Custodes creates and links a passwordless local user", async () => {
  const token = await invite("new@example.test");
  claims = {
    sub: "sub-new",
    email: "new@example.test",
    email_verified: true,
    name: "N",
  };
  const r = await begin({ purpose: "login", inviteToken: token });
  const response = await callback(r.cookie, { code: "c", state: r.state });
  expect(where(response)).toBe("/");
  expect(response.headers.getSetCookie().join("\n")).toContain(
    `astropath_tenant=${INITIAL_TENANT}`,
  );
  const user = (
    await env.database.query<{ id: string; emailVerified: boolean }>(
      `SELECT id,"emailVerified" FROM "user" WHERE email='new@example.test'`,
    )
  ).rows[0];
  expect(user.emailVerified).toBe(true);
  expect(created.at(-1)?.userId).toBe(user.id);
  expect(
    (
      await env.database.query('SELECT 1 FROM account WHERE "userId"=$1', [
        user.id,
      ])
    ).rows,
  ).toHaveLength(0);
  const member = (
    await env.database.query<{ user_id: string; invite_hash: string | null }>(
      "SELECT user_id,invite_hash FROM ap_members WHERE email='new@example.test'",
    )
  ).rows[0];
  expect(member).toEqual({ user_id: user.id, invite_hash: null });
  // Single use.
  expect((await identities()).map((i) => i.subject)).toContain("sub-new");
  claims = {
    sub: "sub-other",
    email: "new@example.test",
    email_verified: true,
    name: "N",
  };
  const again = await begin({ purpose: "login", inviteToken: token }).catch(
    (e) => e,
  );
  expect(again.code).toBe("invalid_invite");
});

it("refuses invitations whose email is unverified, different, or already has a local account", async () => {
  const token = await invite("new@example.test");
  for (const c of [
    { sub: "s1", email: "new@example.test", email_verified: false, name: "N" },
    {
      sub: "s2",
      email: "someone@example.test",
      email_verified: true,
      name: "N",
    },
  ]) {
    claims = c;
    const r = await begin({ purpose: "login", inviteToken: token });
    expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
      "/login?error=custodes_invite_email",
    );
  }
  // A local account with that email already exists (e.g. created with a password).
  await env.engine.exec(
    `INSERT INTO "user"(id,name,email) VALUES('late','Late','new@example.test')`,
  );
  claims = {
    sub: "s3",
    email: "new@example.test",
    email_verified: true,
    name: "N",
  };
  const r = await begin({ purpose: "login", inviteToken: token });
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/login?error=custodes_invite_account_exists",
  );
  expect((await identities()).map((i) => i.subject)).toEqual(["sub-owner"]);
  expect(
    (
      await env.database.query(
        `SELECT 1 FROM "user" WHERE email='new@example.test'`,
      )
    ).rows,
  ).toHaveLength(1);
});

it("a linked person accepts an invitation addressed to their own account email only", async () => {
  await env.engine.exec(
    `INSERT INTO "user"(id,name,email) VALUES('amy','Amy','amy@example.test')`,
  );
  await linkRow(env, "amy", "sub-amy");
  await env.engine.exec(
    `INSERT INTO ap_members(id,tenant_id,email,name,user_id,spaces,role) VALUES('${randomUUID()}','${INITIAL_TENANT}','amy@example.test','Amy','amy',ARRAY['personal'],'member')`,
  );
  // Invitation for amy's email in a second tenant.
  const second = randomUUID();
  await env.engine.exec(
    `INSERT INTO ap_tenants(id,name,wrapped_key) SELECT '${second}','Second',wrapped_key FROM ap_tenants WHERE id='${INITIAL_TENANT}'`,
  );
  const token = "A".repeat(43);
  await env.engine.exec(
    `INSERT INTO ap_members(id,tenant_id,email,name,spaces,invite_hash,invite_expires_at) VALUES('${randomUUID()}','${second}','amy@example.test','Amy',ARRAY['general'],'${hash(token)}',now()+interval '1 day')`,
  );
  const wrong = "B".repeat(43);
  await env.engine.exec(
    `INSERT INTO ap_members(id,tenant_id,email,name,spaces,invite_hash,invite_expires_at) VALUES('${randomUUID()}','${second}','other@example.test','Other',ARRAY['general'],'${hash(wrong)}',now()+interval '1 day')`,
  );
  claims = {
    sub: "sub-amy",
    email: "amy@example.test",
    email_verified: true,
    name: "Amy",
  };
  let r = await begin({ purpose: "login", inviteToken: wrong });
  expect(where(await callback(r.cookie, { code: "c", state: r.state }))).toBe(
    "/login?error=invitation_account_mismatch",
  );
  r = await begin({ purpose: "login", inviteToken: token });
  const response = await callback(r.cookie, { code: "c", state: r.state });
  expect(where(response)).toBe("/");
  expect(response.headers.getSetCookie().join("\n")).toContain(
    `astropath_tenant=${second}`,
  );
  expect(
    (
      await env.database.query(
        "SELECT 1 FROM ap_members WHERE user_id='amy' AND tenant_id=$1",
        [second],
      )
    ).rows,
  ).toHaveLength(1);
});

// ---- staged cutover and the unconfigured default ----
it("keeps password sign-in on unless ASTROPATH_PASSWORD_LOGIN is explicitly off", () => {
  for (const value of [undefined, "", "1", "true", "on", "yes"])
    expect(passwordLoginEnabled({ ASTROPATH_PASSWORD_LOGIN: value })).toBe(
      true,
    );
  for (const value of ["0", "false", "off", "no", "disabled", " OFF "])
    expect(passwordLoginEnabled({ ASTROPATH_PASSWORD_LOGIN: value })).toBe(
      false,
    );
});

it("blocks only email sign-in/sign-up when password login is off; OAuth/MCP routes are untouched", () => {
  const off = { ASTROPATH_PASSWORD_LOGIN: "0" };
  const request = (path: string) =>
    new Request(`${APP}${path}`, { method: "POST" });
  for (const path of [
    "/api/auth/sign-in/email",
    "/api/auth/sign-in/email/",
    "/api/auth/sign-up/email",
  ])
    expect(authRouteGuard(request(path), off)?.status).toBe(403);
  for (const path of [
    "/api/auth/oauth2/token",
    "/api/auth/oauth2/authorize",
    "/api/auth/oauth2/consent",
    "/api/auth/mcp/register",
    "/api/auth/get-session",
    "/api/auth/sign-out",
    "/api/auth/jwks",
  ])
    expect(authRouteGuard(request(path), off), path).toBeNull();
  // Default: nothing is blocked.
  expect(authRouteGuard(request("/api/auth/sign-in/email"), {})).toBeNull();
});

it("is entirely off without CUSTODES_* configuration", async () => {
  expect(custodesConfig({}, APP)).toBeNull();
  expect(
    custodesConfig(
      { CUSTODES_CLIENT_ID: "a", CUSTODES_CLIENT_SECRET: "b" },
      APP,
    ),
  ).toBeNull();
  expect(
    custodesConfig(
      { CUSTODES_ORIGIN: ORIGIN_FOR_TEST, CUSTODES_CLIENT_ID: "a" },
      APP,
    ),
  ).toBeNull();
  expect(
    custodesConfig(
      {
        ...{
          CUSTODES_ORIGIN: "http://evil.test",
          CUSTODES_CLIENT_ID: "a",
          CUSTODES_CLIENT_SECRET: "b",
        },
      },
      APP,
    ),
  ).toBeNull();
  const unconfigured = { ...deps(), oidc: null };
  await expect(
    beginFlow(unconfigured, { purpose: "login" }),
  ).rejects.toMatchObject({
    code: "custodes_not_configured",
  });
  const response = await handleCallback(
    new Request(`${APP}/api/auth/callback/custodes?code=c&state=s`),
    unconfigured,
  );
  expect(where(response)).toBe("/login?error=custodes_not_configured");
  expect(
    authRouteGuard(
      new Request(`${APP}/api/auth/sign-in/email`, { method: "POST" }),
      {},
    ),
  ).toBeNull();
});
const ORIGIN_FOR_TEST = "https://auth.test";
