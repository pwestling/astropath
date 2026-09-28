import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { verifyPassword } from "better-auth/crypto";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";
import { tenantDatabase, type Database, type Queryable } from "../src/lib/db";
import type { Principal } from "../src/lib/policy";
import { MemberStore } from "../src/lib/members";
import { userPrincipal, connectionSpaces } from "../src/lib/access";
import { MessageStore } from "../src/lib/store";
import { IdentityStore } from "../src/lib/identities";
import { migrateTenancy, INITIAL_TENANT } from "../src/lib/tenant-migration";
import { createTenant } from "../src/lib/tenants";
import { POST } from "../src/app/api/invitations/route";

const state = vi.hoisted(() => ({
  database: undefined as Database | undefined,
  userId: null as string | null,
}));
vi.mock("../src/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/db")>()),
  systemDb: {
    query: (sql: string, values?: unknown[]) =>
      state.database!.query(sql, values),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>) =>
      state.database!.transaction(fn),
  },
}));
vi.mock("../src/lib/auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        state.userId ? { user: { id: state.userId } } : null,
    },
  }),
}));

const engine = new PGlite();
const query = async <T extends QueryResultRow>(
  sql: string,
  values?: unknown[],
) => ({ rows: (await engine.query<T>(sql, values)).rows });
const database: Database = {
  query,
  transaction: (fn) =>
    engine.transaction((tx) =>
      fn({
        query: async <T extends QueryResultRow>(
          sql: string,
          values?: unknown[],
        ) => {
          if (sql.startsWith("SELECT pg_advisory_xact_lock"))
            return { rows: [] };
          if (!values)
            return { rows: ((await tx.exec(sql)).at(-1)?.rows as T[]) || [] };
          return { rows: (await tx.query<T>(sql, values)).rows };
        },
      }),
    ),
};
const members = new MemberStore({
  ...database,
  forTenant: (id) => tenantDatabase(id, database),
});
const messages = new MessageStore(database);
const owner: Principal = {
  tenantId: INITIAL_TENANT,
  id: "owner:owner",
  userId: "owner",
  name: "Owner",
  owner: true,
  spaces: null,
  scopes: ["astropath:read", "astropath:write"],
};
const password = "a-private-test-password";
const input = {
  email: "member@example.com",
  name: "Member",
  spaces: ["personal"],
};
const tokenOf = (url: string) =>
  new URLSearchParams(new URL(url).hash.slice(1)).get("token")!;
async function inviteAndAccept() {
  const invite = await members.create(owner, input);
  await members.accept(tokenOf(invite.invite_url), password);
  const row = (
    await query<{ user_id: string }>(
      "SELECT user_id FROM ap_members WHERE email=$1",
      [input.email],
    )
  ).rows[0];
  return { invite, principal: (await userPrincipal(database, row.user_id))! };
}
beforeAll(async () => {
  state.database = database;
  vi.stubEnv("OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("APP_URL", "https://members.example.com");
  vi.stubEnv("ASTROPATH_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  await engine.exec(`CREATE TABLE "user"(id text PRIMARY KEY,name text,email text UNIQUE,"emailVerified" boolean,"createdAt" timestamptz,"updatedAt" timestamptz);
    CREATE TABLE account(id text PRIMARY KEY,"accountId" text,"providerId" text,"userId" text,password text,"createdAt" timestamptz,"updatedAt" timestamptz);
    CREATE TABLE session(id text PRIMARY KEY,"userId" text);`);
  const schema = await readFile(
    new URL("../src/lib/schema.sql", import.meta.url),
    "utf8",
  );
  await engine.exec(schema);
  await engine.exec(schema);
  await database.transaction(migrateTenancy);
  await query("SELECT set_config('astropath.tenant_id',$1,false)", [
    INITIAL_TENANT,
  ]);
  await query(
    "INSERT INTO ap_spaces(slug,name) VALUES('personal','Personal'),('other','Other')",
  );
});
beforeEach(async () => {
  state.userId = null;
  await engine.exec(
    'TRUNCATE ap_members,ap_connections,ap_messages,ap_files,ap_receipts,ap_activity,"user",account,session CASCADE',
  );
  await query(
    "INSERT INTO \"user\"(id,name,email) VALUES('owner','Owner','owner@example.com')",
  );
  await query(
    "INSERT INTO ap_members(id,email,name,user_id,spaces,role) VALUES($1,'owner@example.com','Owner','owner',ARRAY['general'],'owner')",
    [randomUUID()],
  );
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await engine.close();
});

async function inviteExisting() {
  const { principal } = await inviteAndAccept();
  const { tenant } = await createTenant(owner, { name: "Shared project" });
  const tenantDb = await tenantDatabase(tenant.id, database);
  await tenantDb.query(
    "INSERT INTO ap_spaces(slug,name) VALUES('personal','Personal')",
  );
  const scoped = new MemberStore(tenantDb);
  const invite = await scoped.create({ ...owner, tenantId: tenant.id }, input);
  return {
    principal,
    tenant,
    token: tokenOf(invite.invite_url),
    memberId: invite.member.id,
  };
}

it("joins another tenant with the same account and preserves credentials and original access", async () => {
  const { principal, tenant, token } = await inviteExisting();
  const accountsBefore = (await query("SELECT * FROM account")).rows;
  const usersBefore = (await query('SELECT * FROM "user" ORDER BY id')).rows;
  expect(await members.inspect(token)).toMatchObject({
    existing_account: true,
    tenant_name: "Shared project",
  });
  await expect(members.accept(token, password)).rejects.toMatchObject({
    code: "existing_account",
  });
  await expect(members.acceptExisting(token, "owner")).rejects.toMatchObject({
    code: "invitation_account_mismatch",
  });
  expect(await members.acceptExisting(token, principal.userId!)).toEqual({
    email: input.email,
    tenant_id: tenant.id,
  });
  await expect(
    members.acceptExisting(token, principal.userId!),
  ).rejects.toMatchObject({ code: "invalid_invite" });
  expect((await query("SELECT * FROM account")).rows).toEqual(accountsBefore);
  expect((await query('SELECT * FROM "user" ORDER BY id')).rows).toEqual(
    usersBefore,
  );
  for (const tenantId of [INITIAL_TENANT, tenant.id])
    expect(
      await userPrincipal(database, principal.userId!, tenantId),
    ).toMatchObject({ tenantId, owner: false, spaces: ["personal"] });
});

it.each(["expired", "disabled member", "disabled tenant"])(
  "rejects existing-account acceptance when invitation state is %s",
  async (reason) => {
    const { principal, tenant, token, memberId } = await inviteExisting();
    if (reason === "expired")
      await query(
        "UPDATE ap_members SET invite_expires_at=now()-interval '1 second' WHERE id=$1",
        [memberId],
      );
    else if (reason === "disabled member")
      await query("UPDATE ap_members SET disabled_at=now() WHERE id=$1", [
        memberId,
      ]);
    else
      await query("UPDATE ap_tenants SET disabled_at=now() WHERE id=$1", [
        tenant.id,
      ]);
    await expect(
      members.acceptExisting(token, principal.userId!),
    ).rejects.toMatchObject({ code: "invalid_invite" });
    expect(
      (await query("SELECT user_id FROM ap_members WHERE id=$1", [memberId]))
        .rows[0].user_id,
    ).toBeNull();
  },
);

it("uses only the authenticated session for acceptance and requires a same-origin request", async () => {
  const { principal, tenant, token } = await inviteExisting();
  const request = (body: object, origin = "https://members.example.com") =>
    POST(
      new Request("https://members.example.com/api/invitations", {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-Astropath-Tenant": INITIAL_TENANT,
        },
        body: JSON.stringify({ action: "accept_existing", token, ...body }),
      }),
    );
  expect((await request({})).status).toBe(401);
  state.userId = "owner";
  expect((await request({ userId: principal.userId })).status).toBe(400);
  expect((await request({})).status).toBe(403);
  state.userId = principal.userId!;
  expect((await request({}, "https://foreign.example.com")).status).toBe(403);
  const accepted = await request({});
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("cache-control")).toBe("no-store");
  expect(await accepted.json()).toMatchObject({ tenant_id: tenant.id });
  expect((await request({})).status).toBe(400);
});

it("reserves invitation creation and member listing for the owner", async () => {
  const app = { ...owner, owner: false, userId: undefined };
  await expect(members.create(app, input)).rejects.toMatchObject({
    status: 403,
  });
  await expect(members.list(app)).rejects.toMatchObject({ status: 403 });
  await expect(
    members.create(owner, { ...input, spaces: ["missing"] }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    members.create(owner, { ...input, email: "owner@example.com" }),
  ).rejects.toMatchObject({ status: 409 });
  await members.create(owner, input);
  await expect(
    members.create(owner, { ...input, email: "MEMBER@example.com" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(JSON.stringify(await members.list(owner))).not.toContain(
    "invite_hash",
  );
});

it("activates exactly the invited identity and consumes the link once", async () => {
  const invite = await members.create(owner, input);
  const token = tokenOf(invite.invite_url);
  expect(await members.inspect(token)).toMatchObject({
    email: input.email,
    spaces: [{ slug: "personal" }],
  });
  await members.accept(token, password);
  await expect(members.accept(token, password)).rejects.toMatchObject({
    status: 400,
  });
  const user = (
    await query<{ id: string; email: string }>(
      'SELECT id,email FROM "user" WHERE email=$1',
      [input.email],
    )
  ).rows[0];
  const account = (
    await query<{ password: string }>(
      'SELECT password FROM account WHERE "userId"=$1',
      [user.id],
    )
  ).rows[0];
  expect(await verifyPassword({ hash: account.password, password })).toBe(true);
  expect((await query('SELECT id FROM "user"')).rows).toHaveLength(2);
  expect(
    (await query("SELECT invite_hash FROM ap_members")).rows[0].invite_hash,
  ).toBeNull();
});

it("rejects expired, replaced, and disabled invitations", async () => {
  const invite = await members.create(owner, input);
  const first = tokenOf(invite.invite_url);
  const id = String(invite.member.id);
  const replacement = await members.reinvite(owner, id);
  await expect(members.inspect(first)).rejects.toMatchObject({ status: 400 });
  await query(
    "UPDATE ap_members SET invite_expires_at=now()-interval '1 second'",
  );
  await expect(
    members.accept(tokenOf(replacement.invite_url), password),
  ).rejects.toMatchObject({ status: 400 });
  const active = await members.reinvite(owner, id);
  await members.update(owner, id, { disabled: true });
  await expect(
    members.accept(tokenOf(active.invite_url), password),
  ).rejects.toMatchObject({ status: 400 });
});

it("limits members to assigned data, defaults, and organization controls", async () => {
  const { principal } = await inviteAndAccept();
  expect(principal).toMatchObject({ owner: false, spaces: ["personal"] });
  const own = await messages.create(principal, { title: "My note" });
  expect(own.message.space).toBe("personal");
  const hidden = await messages.create(owner, {
    title: "Private owner note",
    space: "other",
  });
  expect(
    (await messages.list(principal, {})).messages.map((message) => message.id),
  ).toEqual([own.message.id]);
  await expect(
    messages.detail(principal, hidden.message.id),
  ).rejects.toMatchObject({
    status: 404,
  });
  await expect(
    messages.create(principal, { title: "Denied", space: "general" }),
  ).rejects.toMatchObject({ status: 404 });
  await messages.update(principal, own.message.id, { pinned: true });
  await expect(
    messages.update(principal, hidden.message.id, { pinned: true }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    messages.update({ ...principal, userId: undefined }, own.message.id, {
      pinned: true,
    }),
  ).rejects.toMatchObject({ status: 403 });
});

it("intersects app grants with current membership and disables sessions and connections", async () => {
  const { principal, invite } = await inviteAndAccept();
  expect(
    await connectionSpaces(
      database,
      ["personal", "other"],
      principal.userId!,
      INITIAL_TENANT,
    ),
  ).toEqual(["personal"]);
  await expect(
    connectionSpaces(database, null, principal.userId!, INITIAL_TENANT),
  ).rejects.toMatchObject({ status: 403 });
  await members.update(owner, String(invite.member.id), { spaces: ["other"] });
  await expect(
    connectionSpaces(database, ["personal"], principal.userId!, INITIAL_TENANT),
  ).rejects.toMatchObject({ status: 403 });
  await query("INSERT INTO session(id,\"userId\") VALUES('test',$1)", [
    principal.userId,
  ]);
  await members.update(owner, String(invite.member.id), { disabled: true });
  expect(
    await userPrincipal(database, principal.userId!, INITIAL_TENANT),
  ).toBeNull();
  expect((await query("SELECT * FROM session")).rows).toHaveLength(1);
  await expect(
    connectionSpaces(database, ["other"], principal.userId!, INITIAL_TENANT),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    connectionSpaces(database, null, null, INITIAL_TENANT),
  ).rejects.toMatchObject({ status: 403 });
  expect((await userPrincipal(database, "owner"))?.owner).toBe(true);
});

it("stores the member's space grant and creator on OAuth identities", async () => {
  const { principal } = await inviteAndAccept();
  const identities = new IdentityStore(database);
  const id = await identities.approve({
    name: "Member Claude",
    userId: principal.userId!,
    clientId: "shared-client",
    approvalKey: randomUUID(),
    scopes: principal.scopes,
    spaces: principal.spaces,
  });
  expect(
    (
      await query(
        "SELECT spaces,created_by_user_id FROM ap_connections WHERE id=$1",
        [id],
      )
    ).rows[0],
  ).toEqual({ spaces: ["personal"], created_by_user_id: principal.userId });
  await query(
    "INSERT INTO \"user\"(id,name,email) VALUES('uninvited','Unknown','unknown@example.com')",
  );
  expect(await userPrincipal(database, "uninvited", INITIAL_TENANT)).toBeNull();
});
