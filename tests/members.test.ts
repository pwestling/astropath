import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { verifyPassword } from "better-auth/crypto";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";
import type { Database } from "../src/lib/db";
import type { Principal } from "../src/lib/policy";
import { MemberStore } from "../src/lib/members";
import { userPrincipal, connectionSpaces } from "../src/lib/access";
import { MessageStore } from "../src/lib/store";
import { IdentityStore } from "../src/lib/identities";

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
          return { rows: (await tx.query<T>(sql, values)).rows };
        },
      }),
    ),
};
const members = new MemberStore(database);
const messages = new MessageStore(database);
const owner: Principal = {
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
  vi.stubEnv("OWNER_EMAIL", "owner@example.com");
  vi.stubEnv("APP_URL", "https://members.example.com");
  await engine.exec(`CREATE TABLE "user"(id text PRIMARY KEY,name text,email text UNIQUE,"emailVerified" boolean,"createdAt" timestamptz,"updatedAt" timestamptz);
    CREATE TABLE account(id text PRIMARY KEY,"accountId" text,"providerId" text,"userId" text,password text,"createdAt" timestamptz,"updatedAt" timestamptz);
    CREATE TABLE session(id text PRIMARY KEY,"userId" text);`);
  const schema = await readFile(
    new URL("../src/lib/schema.sql", import.meta.url),
    "utf8",
  );
  await engine.exec(schema);
  await engine.exec(schema);
  await query(
    "INSERT INTO ap_spaces(slug,name) VALUES('personal','Personal'),('other','Other')",
  );
});
beforeEach(async () => {
  await engine.exec(
    'TRUNCATE ap_members,ap_connections,ap_messages,ap_files,ap_receipts,ap_activity,"user",account,session CASCADE',
  );
  await query(
    "INSERT INTO \"user\"(id,name,email) VALUES('owner','Owner','owner@example.com')",
  );
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await engine.close();
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
  await expect(messages.detail(principal, hidden.message.id)).rejects.toMatchObject({
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
    await connectionSpaces(database, ["personal", "other"], principal.userId!),
  ).toEqual(["personal"]);
  await expect(
    connectionSpaces(database, null, principal.userId!),
  ).rejects.toMatchObject({ status: 403 });
  await members.update(owner, String(invite.member.id), { spaces: ["other"] });
  await expect(
    connectionSpaces(database, ["personal"], principal.userId!),
  ).rejects.toMatchObject({ status: 403 });
  await query("INSERT INTO session(id,\"userId\") VALUES('test',$1)", [
    principal.userId,
  ]);
  await members.update(owner, String(invite.member.id), { disabled: true });
  expect(await userPrincipal(database, principal.userId!)).toBeNull();
  expect((await query("SELECT * FROM session")).rows).toHaveLength(0);
  await expect(
    connectionSpaces(database, ["other"], principal.userId!),
  ).rejects.toMatchObject({ status: 403 });
  expect(await connectionSpaces(database, null, null)).toBeNull();
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
  expect(await userPrincipal(database, "uninvited")).toBeNull();
});
