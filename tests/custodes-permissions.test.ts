import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { connectionSpaces, userPrincipal } from "../src/lib/access";
import { tenantDatabase } from "../src/lib/db";
import { createPermissionHandler } from "../src/lib/permissions/adapter";
import type { Change, State, Target } from "../src/lib/permissions/protocol";
import { permissionsSecret } from "../src/lib/permissions/runtime";
import {
  AstropathPermissions,
  SCHEMA_REVISION,
} from "../src/lib/permissions/astropath";
import {
  signManagementRequest,
  type ManagementIdentity,
} from "../src/lib/permissions/security";
import type { Principal } from "../src/lib/policy";
import {
  createEnv,
  INITIAL_TENANT,
  ISSUER,
  ORIGIN,
  resetFixture,
  type Env,
} from "./helpers/custodes-env";

const identity: ManagementIdentity = {
  issuer: ORIGIN,
  appId: "astropath",
  secret: "permissions-secret-that-is-long-enough",
};
const BASE = "https://ap.test/_custodes/permissions";
const actor = "user:custodes-admin";
let env: Env,
  adapter: AstropathPermissions,
  handler: (r: Request) => Promise<Response>;

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: { token?: string; id?: ManagementIdentity; actor?: string } = {},
) {
  const url = new URL(BASE + path);
  const text = body === undefined ? "" : JSON.stringify(body);
  const token =
    options.token ??
    (await signManagementRequest(
      options.id ?? identity,
      options.actor ?? actor,
      method,
      url,
      text,
    ));
  return handler(
    new Request(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: text }),
    }),
  );
}
const json = async (r: Response) => (await r.json()) as any;
const subject = (id: string): Target => ({ kind: "subject", id });
const tenantEntity: Target = {
  kind: "entity",
  catalog: "tenants",
  id: INITIAL_TENANT,
};
const space = (slug: string, tenant = INITIAL_TENANT) => `${tenant}/${slug}`;
async function version() {
  return String(
    (
      await env.database.query<{ revision: string }>(
        "SELECT revision::text FROM ap_permission_revision",
      )
    ).rows[0].revision,
  );
}
async function change(
  target: Target,
  actionId: string,
  values: Change["values"] = {},
  requestId = randomUUID(),
): Promise<Change> {
  return {
    requestId,
    schemaRevision: SCHEMA_REVISION,
    expectedVersion: await version(),
    target,
    actionId,
    values,
  };
}
const post = async (c: Change) => call("POST", "/changes", c);
const state = async (t: Target): Promise<State> =>
  json(
    await call(
      "GET",
      `/state?${new URLSearchParams(t as Record<string, string>)}`,
    ),
  );
const ids = (s: State) => s.actions.map((a) => a.id);
const member = async (userId: string, tenant = INITIAL_TENANT) =>
  (
    await env.database.query<{
      role: string;
      spaces: string[];
      disabled_at: Date | null;
    }>(
      "SELECT role,spaces,disabled_at FROM ap_members WHERE tenant_id=$1 AND user_id=$2",
      [tenant, userId],
    )
  ).rows[0];
const hasAccess = async (userId: string) =>
  !!(await userPrincipal(env.database, userId))?.tenantId;
const ownerPrincipal: Principal = {
  tenantId: INITIAL_TENANT,
  id: "owner:owner",
  userId: "owner",
  name: "Owner",
  owner: true,
  spaces: null,
  scopes: ["astropath:read", "astropath:write"],
};
const grant = (tenant: string, slugs: string[]) => ({
  tenant,
  spaces: slugs.map((s) => space(s, tenant)),
});

beforeAll(async () => {
  env = await createEnv();
  adapter = new AstropathPermissions(env.database, ISSUER);
  handler = createPermissionHandler(
    identity,
    adapter,
    "/_custodes/permissions",
  );
});
afterAll(() => env.engine.close());
beforeEach(async () => {
  await resetFixture(env);
  await env.engine.exec(`
    DELETE FROM ap_tenants WHERE id<>'${INITIAL_TENANT}' AND false;
    INSERT INTO ap_custodes_identities(issuer,subject,user_id,linked_via) VALUES('${ISSUER}','c-owner','owner','session'),('${ISSUER}','c-izzy','izzy','session');`);
});

// ---- transport security ----
it("serves the manifest and state to signed requests only", async () => {
  const manifest = await call("GET", "/manifest");
  expect(manifest.status).toBe(200);
  const body = await json(manifest);
  expect(body.appId).toBe("astropath");
  expect(body.actions.map((a: { id: string }) => a.id)).toEqual([
    "add-to-tenant",
    "set-member-spaces",
    "remove-from-tenant",
    "make-owner",
    "make-member",
    "revoke-invite",
  ]);
  expect((await handler(new Request(`${BASE}/manifest`))).status).toBe(401);
  expect(
    (
      await handler(
        new Request(`${BASE}/manifest`, {
          headers: { authorization: "Bearer nonsense" },
        }),
      )
    ).status,
  ).toBe(401);
});

it("refuses tokens with the wrong secret, issuer, audience or type", async () => {
  const url = new URL(`${BASE}/manifest`);
  for (const bad of [
    { ...identity, secret: "another-permissions-secret-long-enough" },
    { ...identity, issuer: "https://evil.test" },
    { ...identity, appId: "roundtable" },
  ])
    expect(
      (await call("GET", "/manifest", undefined, { id: bad })).status,
    ).toBe(401);
  const key = new TextEncoder().encode(identity.secret);
  const forged = await new SignJWT({
    actor,
    method: "GET",
    path: url.pathname,
    bodyHash: "",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(identity.issuer)
    .setAudience("astropath")
    .setIssuedAt()
    .setExpirationTime("60s")
    .setJti(randomUUID())
    .sign(key);
  expect(
    (await call("GET", "/manifest", undefined, { token: forged })).status,
  ).toBe(401);
  const userJwt = await new SignJWT({ sub: "c-owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("astropath")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(key);
  expect(
    (await call("GET", "/manifest", undefined, { token: userJwt })).status,
  ).toBe(401);
});

it("refuses expired, over-age, replayed, path-mismatched and body-mismatched tokens", async () => {
  const key = new TextEncoder().encode(identity.secret);
  const url = new URL(`${BASE}/manifest`);
  const make = (iat: number, exp: number) =>
    new SignJWT({
      actor,
      method: "GET",
      path: url.pathname + url.search,
      bodyHash:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    })
      .setProtectedHeader({ alg: "HS256", typ: "permission-admin+jwt" })
      .setIssuer(identity.issuer)
      .setAudience("astropath")
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(key);
  const now = Math.floor(Date.now() / 1000);
  const status = async (token: string) =>
    (await call("GET", "/manifest", undefined, { token })).status;
  expect(await status(await make(now - 200, now - 100))).toBe(401);
  expect(await status(await make(now - 200, now + 100))).toBe(401);
  expect(await status(await make(now, now + 60))).toBe(200);
  // single use: a repeated jti is a replay
  const token = await signManagementRequest(identity, actor, "GET", url, "");
  expect(await status(token)).toBe(200);
  expect(await status(token)).toBe(401);
  // signed for another path or another method
  expect(
    await status(
      await signManagementRequest(
        identity,
        actor,
        "GET",
        new URL(`${BASE}/state?kind=application`),
        "",
      ),
    ),
  ).toBe(401);
  expect(
    await status(await signManagementRequest(identity, actor, "POST", url, "")),
  ).toBe(401);
  // a tampered body does not apply and does not burn the token
  const c = await change(subject("c-izzy"), "remove-from-tenant", {
    tenant: INITIAL_TENANT,
  });
  const signed = await signManagementRequest(
    identity,
    actor,
    "POST",
    new URL(`${BASE}/changes`),
    JSON.stringify(c),
  );
  const tampered = { ...c, actionId: "make-owner" };
  expect(
    (await call("POST", "/changes", tampered, { token: signed })).status,
  ).toBe(401);
  expect((await member("izzy")).role).toBe("member");
  expect((await call("POST", "/changes", c, { token: signed })).status).toBe(
    200,
  );
  expect(
    (await call("GET", "/manifest", undefined, { actor: "anonymous" })).status,
  ).toBe(403);
});

it("rejects oversized and malformed bodies and unknown routes", async () => {
  expect((await call("POST", "/changes", { requestId: "nope" })).status).toBe(
    422,
  );
  expect(
    (await call("POST", "/changes", { big: "x".repeat(70 * 1024) })).status,
  ).toBe(400);
  expect((await call("GET", "/nothing")).status).toBe(404);
  expect((await call("GET", "/catalogs/unknown")).status).toBe(404);
});

it("is disabled, not crashed, without a usable secret", () => {
  const origin = { CUSTODES_ORIGIN: ORIGIN };
  const with_ = (env: Record<string, string>) => ({ ...origin, ...env });
  expect(permissionsSecret({}).secret).toBeNull();
  expect(
    permissionsSecret(with_({ PERMISSIONS_ASTROPATH_SECRET: "short" })).secret,
  ).toBeNull();
  const same = "z".repeat(40);
  for (const other of [
    "BETTER_AUTH_SECRET",
    "CUSTODES_CLIENT_SECRET",
    "ASTROPATH_MASTER_KEY",
  ])
    expect(
      permissionsSecret(
        with_({ PERMISSIONS_ASTROPATH_SECRET: same, [other]: same }),
      ).secret,
    ).toBeNull();
  expect(
    permissionsSecret({ PERMISSIONS_ASTROPATH_SECRET: same }).secret,
  ).toBeNull(); // no origin
  expect(
    permissionsSecret(with_({ PERMISSIONS_ASTROPATH_SECRET: same })).secret,
  ).toBe(same);
});

// ---- the real permission model ----
it("describes owners, members, unmapped subjects, the application and a tenant with invitations", async () => {
  const owner = await state(subject("c-owner"));
  expect(owner.access.map((a) => a.label)).toEqual([
    "Owner",
    "Platform administrator",
  ]);
  // The only owner can be removed/demoted by no action; other actions are offered.
  expect(ids(owner)).toContain("remove-from-tenant");
  const izzy = await state(subject("c-izzy"));
  expect(izzy.access).toMatchObject([
    { label: "Member", scope: expect.stringContaining("personal") },
  ]);
  expect(ids(izzy)).toEqual([
    "set-member-spaces",
    "remove-from-tenant",
    "make-owner",
  ]);
  expect(
    izzy.actions.find((a) => a.id === "remove-from-tenant")!.values,
  ).toEqual({ tenant: INITIAL_TENANT });
  expect(izzy.facts[0].value).toContain("izzy@example.test");

  const stranger = await state(subject("never-seen"));
  expect(stranger.actions).toEqual([]);
  expect(stranger.access).toEqual([]);
  expect(stranger.facts[0].value).toMatch(/sign in to Astropath once/);

  const app = await state({ kind: "application" });
  expect(app.access.map((a) => a.scope)).toEqual(["Owner of Personal"]);

  const { invite_url } = await env.members.create(ownerPrincipal, {
    email: "guest@example.test",
    name: "Guest",
    spaces: ["personal"],
  });
  expect(invite_url).toContain("#token=");
  const tenant = await state(tenantEntity);
  expect(tenant.access).toHaveLength(2);
  expect(tenant.facts.map((f) => f.value).join("\n")).toContain(
    "guest@example.test",
  );
  expect(ids(tenant)).toEqual(["revoke-invite"]);
  expect(
    (await json(await call("GET", "/catalogs/invites"))).items,
  ).toHaveLength(1);
  expect(
    (await json(await call("GET", "/catalogs/tenants?q=pers"))).items,
  ).toEqual([{ id: INITIAL_TENANT, label: "Personal" }]);
  const spaces = (await json(await call("GET", "/catalogs/spaces?q=work")))
    .items;
  expect(spaces).toEqual([{ id: space("work"), label: "Personal / Work" }]);
  expect(
    (await call("GET", `/state?kind=entity&catalog=tenants&id=${randomUUID()}`))
      .status,
  ).toBe(404);
});

it("removing and re-adding a member changes what Astropath's own policy allows", async () => {
  await env.engine.exec(
    `INSERT INTO ap_connections(id,tenant_id,name,kind,scopes,oauth_user_id,created_by_user_id,spaces) VALUES('${randomUUID()}','${INITIAL_TENANT}','Claude','oauth',ARRAY['astropath:read'],'izzy','izzy',ARRAY['personal','work'])`,
  );
  expect(await hasAccess("izzy")).toBe(true);
  expect(
    await connectionSpaces(
      env.database,
      ["personal", "work"],
      "izzy",
      INITIAL_TENANT,
    ),
  ).toEqual(["personal"]);
  const removed = await post(
    await change(subject("c-izzy"), "remove-from-tenant", {
      tenant: INITIAL_TENANT,
    }),
  );
  expect(removed.status).toBe(200);
  // Same enforcement as the members UI: no workspace, and the agent connection loses access.
  expect(await hasAccess("izzy")).toBe(false);
  expect(await userPrincipal(env.database, "izzy", INITIAL_TENANT)).toBeNull();
  await expect(
    connectionSpaces(
      env.database,
      ["personal", "work"],
      "izzy",
      INITIAL_TENANT,
    ),
  ).rejects.toMatchObject({ code: "access_revoked" });
  expect(ids((await json(removed)).state)).toEqual(["add-to-tenant"]);

  const added = await post(
    await change(
      subject("c-izzy"),
      "add-to-tenant",
      grant(INITIAL_TENANT, ["work"]),
    ),
  );
  expect(added.status).toBe(200);
  expect(await hasAccess("izzy")).toBe(true);
  expect(
    await connectionSpaces(
      env.database,
      ["personal", "work"],
      "izzy",
      INITIAL_TENANT,
    ),
  ).toEqual(["work"]);
  expect((await member("izzy")).role).toBe("member"); // re-adding never restores owner rights
  const audit = await env.database.query<{ action: string; actor: string }>(
    "SELECT action,actor FROM ap_custodes_audit WHERE action<>'link_custodes' ORDER BY id",
  );
  expect(audit.rows.map((r) => r.action)).toEqual([
    "remove_member",
    "add_member",
  ]);
  expect(audit.rows.every((r) => r.actor === actor)).toBe(true);
});

it("changes a member's spaces, and owners always keep every space", async () => {
  expect(
    (
      await post(
        await change(
          subject("c-izzy"),
          "set-member-spaces",
          grant(INITIAL_TENANT, ["personal", "work"]),
        ),
      )
    ).status,
  ).toBe(200);
  expect((await member("izzy")).spaces.sort()).toEqual(["personal", "work"]);
  expect((await userPrincipal(env.database, "izzy"))!.spaces).toEqual([
    "personal",
    "work",
  ]);
  expect(
    (
      await post(
        await change(
          subject("c-owner"),
          "set-member-spaces",
          grant(INITIAL_TENANT, ["work"]),
        ),
      )
    ).status,
  ).toBe(422);
  expect((await userPrincipal(env.database, "owner"))!.spaces).toBeNull();
});

it("promotes and demotes owners, never the last one", async () => {
  const promoted = await post(
    await change(subject("c-izzy"), "make-owner", { tenant: INITIAL_TENANT }),
  );
  expect(promoted.status).toBe(200);
  expect((await userPrincipal(env.database, "izzy"))!.owner).toBe(true);
  expect(
    (
      await post(
        await change(subject("c-izzy"), "make-owner", {
          tenant: INITIAL_TENANT,
        }),
      )
    ).status,
  ).toBe(422);
  // Two owners: one may be demoted or removed.
  expect(
    (
      await post(
        await change(subject("c-owner"), "make-member", {
          tenant: INITIAL_TENANT,
        }),
      )
    ).status,
  ).toBe(200);
  expect((await userPrincipal(env.database, "owner"))!.owner).toBe(false);
  // izzy is now the last owner: neither demotion nor removal is allowed.
  for (const [action, expected] of [
    ["make-member", 422],
    ["remove-from-tenant", 422],
  ] as const) {
    const refused = await post(
      await change(subject("c-izzy"), action, { tenant: INITIAL_TENANT }),
    );
    expect(refused.status).toBe(expected);
    expect((await json(refused)).error).toMatch(/last owner/);
  }
  expect((await member("izzy")).role).toBe("owner");
  expect((await member("izzy")).disabled_at).toBeNull();
  // The same rule for the sole owner removed while another member exists.
  await env.engine.exec(
    `UPDATE ap_members SET role='owner' WHERE user_id='owner'; UPDATE ap_members SET disabled_at=now() WHERE user_id='izzy'`,
  );
  const sole = await post(
    await change(subject("c-owner"), "remove-from-tenant", {
      tenant: INITIAL_TENANT,
    }),
  );
  expect(sole.status).toBe(422);
  expect(await hasAccess("owner")).toBe(true);
});

it("explains that an unmapped person must sign in or accept an invitation, and never matches by email", async () => {
  await env.engine.exec(
    `INSERT INTO "user"(id,name,email) VALUES('ghost','Ghost','ghost@example.test')`,
  );
  const response = await post(
    await change(
      subject("custodes-ghost"),
      "add-to-tenant",
      grant(INITIAL_TENANT, ["personal"]),
    ),
  );
  expect(response.status).toBe(422);
  expect((await json(response)).error).toMatch(/sign in to Astropath once/);
  expect(await hasAccess("ghost")).toBe(false);
});

it("validates references: tenants, spaces of other tenants, existing memberships and pending invitations", async () => {
  await env.engine.exec(
    `INSERT INTO "user"(id,name,email) VALUES('newbie','Newbie','n@example.test');
     INSERT INTO ap_custodes_identities(issuer,subject,user_id,linked_via) VALUES('${ISSUER}','c-newbie','newbie','session');`,
  );
  const second = randomUUID();
  await env.engine.exec(
    `INSERT INTO ap_tenants(id,name,wrapped_key) SELECT '${second}','Second',wrapped_key FROM ap_tenants WHERE id='${INITIAL_TENANT}';
     INSERT INTO ap_spaces(tenant_id,slug,name) VALUES('${second}','general','General')`,
  );
  const add = async (values: Change["values"]) =>
    (await post(await change(subject("c-newbie"), "add-to-tenant", values)))
      .status;
  expect(await add({ tenant: randomUUID(), spaces: [space("personal")] })).toBe(
    422,
  );
  expect(await add({ tenant: "not-a-uuid", spaces: [space("personal")] })).toBe(
    422,
  );
  expect(await add({ tenant: INITIAL_TENANT, spaces: [space("nope")] })).toBe(
    422,
  );
  expect(
    await add({ tenant: INITIAL_TENANT, spaces: [space("general", second)] }),
  ).toBe(422);
  expect(await add({ tenant: INITIAL_TENANT, spaces: ["personal"] })).toBe(422);
  expect(await add({ tenant: INITIAL_TENANT, spaces: [] })).toBe(422);
  expect(await hasAccess("newbie")).toBe(false);
  // An existing member is edited, not re-added.
  expect(
    (
      await post(
        await change(
          subject("c-izzy"),
          "add-to-tenant",
          grant(INITIAL_TENANT, ["work"]),
        ),
      )
    ).status,
  ).toBe(422);
  // A pending invitation for the same email blocks a duplicate row.
  await env.members.create(ownerPrincipal, {
    email: "n@example.test",
    name: "N",
    spaces: ["personal"],
  });
  const blocked = await post(
    await change(
      subject("c-newbie"),
      "add-to-tenant",
      grant(INITIAL_TENANT, ["personal"]),
    ),
  );
  expect(blocked.status).toBe(409);
  // Another workspace works, with its own space.
  expect(
    await add({ tenant: second, spaces: [space("general", second)] }),
  ).toBe(200);
  expect((await member("newbie", second)).spaces).toEqual(["general"]);
  expect((await userPrincipal(env.database, "newbie", second))!.spaces).toEqual(
    ["general"],
  );
  expect(
    await userPrincipal(env.database, "newbie", INITIAL_TENANT),
  ).toBeNull();
  // Actions that need an active membership are refused for non-members.
  const entity: Target = {
    kind: "entity",
    catalog: "tenants",
    id: INITIAL_TENANT,
  };
  expect(
    (
      await post(
        await change(entity, "revoke-invite", { invite: randomUUID() }),
      )
    ).status,
  ).toBe(422);
  expect(
    (
      await post(
        await change(subject("c-newbie"), "make-owner", {
          tenant: INITIAL_TENANT,
        }),
      )
    ).status,
  ).toBe(422);
});

it("revokes a pending invitation so its link no longer works", async () => {
  const { invite_url } = await env.members.create(ownerPrincipal, {
    email: "guest@example.test",
    name: "Guest",
    spaces: ["personal"],
  });
  const token = new URL(invite_url).hash.slice(7);
  const [invite] = (await json(await call("GET", "/catalogs/invites"))).items;
  const response = await post(
    await change(tenantEntity, "revoke-invite", { invite: invite.id }),
  );
  expect(response.status).toBe(200);
  await expect(env.members.inspect(token)).rejects.toMatchObject({
    code: "invalid_invite",
  });
  expect((await state(tenantEntity)).actions).toEqual([]);
  // The email can be invited again.
  await env.members.create(ownerPrincipal, {
    email: "guest@example.test",
    name: "Guest",
    spaces: ["personal"],
  });
});

// ---- idempotency, versions, concurrency ----
it("a retried request id returns the recorded receipt; a different payload or actor is a 409", async () => {
  const c = await change(subject("c-izzy"), "remove-from-tenant", {
    tenant: INITIAL_TENANT,
  });
  const first = await post(c);
  expect(first.status).toBe(200);
  const firstBody = await json(first);
  const again = await post(c); // stale expectedVersion now, but the receipt is replayed first
  expect(again.status).toBe(200);
  expect(await json(again)).toEqual(firstBody);
  expect(
    (
      await env.database.query(
        "SELECT 1 FROM ap_custodes_audit WHERE action='remove_member'",
      )
    ).rows,
  ).toHaveLength(1);
  expect((await post({ ...c, actionId: "make-owner" })).status).toBe(409);
  expect(
    (await call("POST", "/changes", c, { actor: "user:someone-else" })).status,
  ).toBe(409);
});

it("duplicate concurrent requests apply once; stale versions are rejected and remembered", async () => {
  const c = await change(subject("c-izzy"), "remove-from-tenant", {
    tenant: INITIAL_TENANT,
  });
  const [a, b] = await Promise.all([post(c), post(c)]);
  expect([a.status, b.status]).toEqual([200, 200]);
  expect(
    (
      await env.database.query(
        "SELECT 1 FROM ap_custodes_audit WHERE action='remove_member'",
      )
    ).rows,
  ).toHaveLength(1);
  const stale = await change(
    subject("c-izzy"),
    "add-to-tenant",
    grant(INITIAL_TENANT, ["personal"]),
  );
  await env.engine.exec(
    `UPDATE ap_spaces SET name='Renamed' WHERE slug='work'`,
  );
  const rejected = await post(stale);
  expect(rejected.status).toBe(409);
  expect((await json(rejected)).outcome).toBe("rejected");
  expect(await hasAccess("izzy")).toBe(false);
  expect((await post(stale)).status).toBe(409); // the rejection is durable
  expect(await hasAccess("izzy")).toBe(false);
  expect(
    (
      await post(
        await change(
          subject("c-izzy"),
          "add-to-tenant",
          grant(INITIAL_TENANT, ["personal"]),
        ),
      )
    ).status,
  ).toBe(200);
});

it("every writer versions the same data, including tenant-scoped ones under row-level security", async () => {
  let before = await version();
  await env.members.create(ownerPrincipal, {
    email: "late@example.test",
    name: "Late",
    spaces: ["personal"],
  });
  expect(await version()).not.toBe(before);
  before = await version();
  // The members UI writes through the restricted tenant role, which has no right to the revision table.
  const scoped = await tenantDatabase(INITIAL_TENANT, env.database);
  await scoped.query(
    "UPDATE ap_members SET spaces=ARRAY['work'] WHERE user_id='izzy'",
  );
  expect(await version()).not.toBe(before);
  await expect(
    scoped.query("UPDATE ap_permission_revision SET revision=0"),
  ).rejects.toThrow();
  await expect(
    scoped.query("SELECT * FROM ap_custodes_identities"),
  ).rejects.toThrow();
  const c = await change(subject("c-izzy"), "remove-from-tenant", {
    tenant: INITIAL_TENANT,
  });
  await env.members.create(ownerPrincipal, {
    email: "later@example.test",
    name: "Later",
    spaces: ["personal"],
  });
  expect((await post(c)).status).toBe(409);
});

it("a schema-revision mismatch and unsupported actions are refused before applying", async () => {
  const c = await change(subject("c-izzy"), "remove-from-tenant", {
    tenant: INITIAL_TENANT,
  });
  expect((await post({ ...c, schemaRevision: "astropath-0" })).status).toBe(
    409,
  );
  expect((await post({ ...c, actionId: "nope" })).status).toBe(422);
  expect(
    (await post({ ...c, values: { tenant: INITIAL_TENANT, surprise: "x" } }))
      .status,
  ).toBe(422);
  expect(await hasAccess("izzy")).toBe(true);
});

it("reports an unknown outcome (not a rejection) when storage fails mid-write", async () => {
  const failing = new AstropathPermissions(
    {
      ...env.database,
      transaction: async () => {
        throw new Error("connection lost");
      },
    } as typeof env.database,
    ISSUER,
  );
  const h = createPermissionHandler(
    identity,
    failing,
    "/_custodes/permissions",
  );
  const c = await change(subject("c-izzy"), "remove-from-tenant", {
    tenant: INITIAL_TENANT,
  });
  const url = new URL(`${BASE}/changes`);
  const text = JSON.stringify(c);
  const response = await h(
    new Request(url, {
      method: "POST",
      body: text,
      headers: {
        authorization: `Bearer ${await signManagementRequest(identity, actor, "POST", url, text)}`,
      },
    }),
  );
  expect(response.status).toBe(503);
  expect((await json(response)).outcome).toBe("unknown");
  expect(await hasAccess("izzy")).toBe(true);
});
