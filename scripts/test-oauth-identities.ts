import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { hashPassword } from "better-auth/crypto";
import { writeFile } from "node:fs/promises";
import { createAuth } from "../src/lib/auth";
import { pool } from "../src/lib/db";
import { CONNECTION_CLAIM } from "../src/lib/identities";
import { oauthPrincipal } from "../src/lib/security";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const base = process.env.APP_URL || "";
const suffix = randomUUID().slice(0, 8);
const email = process.env.OWNER_EMAIL || "";
const password = randomBytes(24).toString("base64url");
let cookie = "";

async function post(
  path: string,
  body: unknown,
  expected = 200,
  origin = base,
) {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      Cookie: cookie,
    },
    body: JSON.stringify(body),
    redirect: "manual",
  });
  const data = await response.json();
  assert.equal(
    response.status,
    expected,
    `${path}: HTTP ${response.status}; ${data.message || data.error?.message || data.error_description || "unexpected status"}`,
  );
  return { response, data };
}

async function main() {
  assert.ok(
    process.env.IDENTITY_TEST_BRANCH_ID,
    "Run only with an isolated test branch",
  );
  assert.ok(
    ["localhost", "127.0.0.1"].includes(new URL(base).hostname),
    "Run against a local test server",
  );
  assert.match(email, /^identity-test-/);
  const existing = await pool.query('SELECT id FROM "user" WHERE email=$1', [
    email,
  ]);
  if (existing.rows.length) {
    await pool.query(
      'UPDATE account SET password=$1 WHERE "userId"=$2 AND "providerId"=\'credential\'',
      [await hashPassword(password), existing.rows[0].id],
    );
  } else {
    await createAuth(true).api.signUpEmail({
      body: { email, password, name: "Identity test owner" },
    });
  }
  const signedIn = await post("/api/auth/sign-in/email", { email, password });
  cookie = signedIn.response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  const metadata = await (
    await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)
  ).json();
  const redirectUri = "http://127.0.0.1:3100/oauth-test-callback";
  const registered = await post(
    metadata.registration_endpoint,
    {
      client_name: `Identity regression ${suffix}`,
      application_type: "native",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
  const clientId: string = registered.data.client_id;
  const begin = async () => {
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
    assert.equal(
      new URL(location, base).pathname,
      "/consent",
      "Every new authorization requires naming",
    );
    return {
      verifier,
      query: new URL(location, base).search.slice(1),
      location: new URL(location, base).href,
    };
  };
  const exchange = async (url: string, verifier: string) => {
    const code = new URL(url).searchParams.get("code");
    assert.ok(code, "Approval must issue an authorization code");
    const response = await fetch(metadata.token_endpoint, {
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
    assert.equal(response.status, 200, "PKCE code exchange");
    return response.json();
  };
  const first = await begin();
  // Keep a valid approval URL for optional browser verification without issuing a token.
  console.log("Approval page is ready; OAuth regression started.");
  const before = await pool.query("SELECT count(*) FROM ap_connections");
  await post(
    "/api/auth/oauth2/consent",
    { accept: true, oauth_query: first.query },
    400,
  );
  await post(
    "/api/auth/oauth2/consent",
    {
      accept: true,
      identity_name: `Tampered ${suffix}`,
      oauth_query: `${first.query}&scope=astropath:write`,
    },
    400,
  );
  await post(
    "/api/auth/oauth2/consent",
    { accept: true, identity_name: `CSRF ${suffix}`, oauth_query: first.query },
    403,
    "https://example.com",
  );
  const rejected = await begin();
  await post("/api/auth/oauth2/consent", {
    accept: false,
    oauth_query: rejected.query,
  });
  assert.equal(
    (await pool.query("SELECT count(*) FROM ap_connections")).rows[0].count,
    before.rows[0].count,
  );
  console.log(
    "PASS: missing names, tampered requests, cross-origin requests, and denial create no identities.",
  );

  // Concurrent approvals in one browser session must keep their request-local identities.
  const second = await begin();
  const secondName = `Claude Work ${suffix}`;
  const firstName = `Claude Personal ${suffix}`;
  const [approvalB, approvalA] = await Promise.all([
    post("/api/auth/oauth2/consent", {
      accept: true,
      identity_name: secondName,
      oauth_query: second.query,
    }),
    post("/api/auth/oauth2/consent", {
      accept: true,
      identity_name: firstName,
      oauth_query: first.query,
    }),
  ]);
  const tokenB = await exchange(approvalB.data.url, second.verifier);
  const tokenA = await exchange(approvalA.data.url, first.verifier);
  const idA = decodeJwt(tokenA.access_token)[CONNECTION_CLAIM];
  const idB = decodeJwt(tokenB.access_token)[CONNECTION_CLAIM];
  assert.ok(idA);
  assert.ok(idB);
  assert.notEqual(idA, idB);
  assert.equal(
    (await oauthPrincipal(decodeJwt(tokenA.access_token))).name,
    firstName,
  );
  assert.equal(
    (await oauthPrincipal(decodeJwt(tokenB.access_token))).name,
    secondName,
  );
  const retry = await post("/api/auth/oauth2/consent", {
    accept: true,
    identity_name: firstName,
    oauth_query: first.query,
  });
  const retriedToken = await exchange(retry.data.url, first.verifier);
  assert.equal(decodeJwt(retriedToken.access_token)[CONNECTION_CLAIM], idA);
  const duplicate = await begin();
  await post(
    "/api/auth/oauth2/consent",
    {
      accept: true,
      identity_name: firstName.toUpperCase(),
      oauth_query: duplicate.query,
    },
    409,
  );
  console.log(
    "PASS: shared-client identities, concurrent approvals, retry stability, and unique names.",
  );

  const refreshResponse = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokenA.refresh_token,
      client_id: clientId,
      resource: `${base}/mcp`,
    }),
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.equal(decodeJwt(refreshed.access_token)[CONNECTION_CLAIM], idA);
  const client = new Client({
    name: "Named identity verification",
    version: "1.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${refreshed.access_token}` },
        },
      }),
    );
    const note = await client.callTool({
      name: "send_message",
      arguments: {
        title: "Named identity regression",
        body: "Test on isolated database branch.",
        recipient: `Not yet connected ${suffix}`,
      },
    });
    assert.notEqual(note.isError, true);
    const stored = await pool.query(
      "SELECT sender,principal_id,recipient FROM ap_messages WHERE principal_id=$1",
      [idA],
    );
    assert.equal(stored.rows[0].sender, firstName);
    assert.equal(stored.rows[0].recipient, `Not yet connected ${suffix}`);
  } finally {
    await client.close();
  }
  console.log(
    "PASS: token refresh retains identity, authenticated MCP sends with the chosen name, and future recipients still work.",
  );

  await pool.query("UPDATE ap_connections SET revoked_at=now() WHERE id=$1", [
    idA,
  ]);
  await assert.rejects(
    oauthPrincipal(decodeJwt(refreshed.access_token)),
    /revoked/,
  );
  assert.equal(
    (await oauthPrincipal(decodeJwt(tokenB.access_token))).name,
    secondName,
  );
  const revokedRefresh = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshed.refresh_token,
      client_id: clientId,
      resource: `${base}/mcp`,
    }),
  });
  assert.ok(
    revokedRefresh.status >= 400,
    "Revoked identity cannot mint refreshed tokens",
  );
  const legacy = await oauthPrincipal({
    sub: decodeJwt(tokenB.access_token).sub,
    client_id: `legacy-${suffix}`,
    scope: "astropath:read",
  });
  assert.ok(legacy.id);
  assert.equal(legacy.owner, false);
  console.log("PASS: independent revocation and legacy identity mapping.");
  if (process.env.IDENTITY_BROWSER_CHECK === "1") {
    const browserApproval = await begin();
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
      ".env.identity-browser.json",
      JSON.stringify({ cookies, origins: [] }),
      { mode: 0o600 },
    );
    await writeFile(".env.identity-browser-url", browserApproval.location, {
      mode: 0o600,
    });
    console.log(
      "Isolated browser session saved for consent-page verification.",
    );
  } else await post("/api/auth/sign-out", {});
}

main()
  .finally(() => pool.end())
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
