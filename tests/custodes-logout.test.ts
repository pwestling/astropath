import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { handleBackchannelLogout } from "../src/lib/custodes/logout";
import {
  CLIENT_ID,
  config,
  createEnv,
  INITIAL_TENANT,
  ISSUER,
  linkRow,
  resetFixture,
  sign,
  signingKey,
  type Env,
  type Signer,
} from "./helpers/custodes-env";

const EVENTS = {
  events: { "http://schemas.openid.net/event/backchannel-logout": {} },
};
let env: Env, signer: Signer, other: Signer;
const logout = (
  claims: Record<string, unknown>,
  options: Parameters<typeof sign>[2] = {},
  key = signer,
) =>
  sign(
    key,
    { ...EVENTS, ...claims },
    { typ: "logout+jwt", audience: CLIENT_ID, expires: "2m", ...options },
  );
const send = (token: string | null) =>
  handleBackchannelLogout(
    config(),
    signer.keys,
    env.accounts,
    env.database,
    token,
  );
const sessions = async () =>
  (
    await env.database.query<{ id: string }>(
      'SELECT id FROM "session" ORDER BY id',
    )
  ).rows.map((r) => r.id);

beforeAll(async () => {
  env = await createEnv();
  signer = await signingKey();
  other = await signingKey();
});
afterAll(() => env.engine.close());
beforeEach(async () => {
  await resetFixture(env);
  await env.engine.exec(`
    DELETE FROM "session";
    INSERT INTO "session"(id,"userId",token) VALUES('legacy','owner','x'),('a1','owner','x'),('a2','owner','x'),('b1','izzy','x');
    INSERT INTO ap_custodes_sessions(session_id,user_id,issuer,subject,sid) VALUES
      ('a1','owner','${ISSUER}','sub-owner','sid-a'),('a2','owner','${ISSUER}','sub-owner','sid-a'),
      ('b1','izzy','${ISSUER}','sub-izzy','sid-b');`);
  await linkRow(env, "owner", "sub-owner");
});

it("ends exactly the web sessions of that Custodes session; password-era sessions survive", async () => {
  expect(await send(await logout({ sub: "sub-owner", sid: "sid-a" }))).toBe(2);
  expect(await sessions()).toEqual(["b1", "legacy"]);
  expect(
    (await env.database.query("SELECT 1 FROM ap_custodes_sessions")).rows,
  ).toHaveLength(1);
});

it("without a sid ends that user's Custodes-created sessions only", async () => {
  expect(await send(await logout({ sub: "sub-owner" }))).toBe(2);
  expect(await sessions()).toEqual(["b1", "legacy"]);
});

it("does not touch MCP/OAuth connections or members", async () => {
  await env.engine.exec(
    `INSERT INTO ap_connections(id,tenant_id,name,kind,scopes,oauth_user_id,created_by_user_id) VALUES('${randomUUID()}','${INITIAL_TENANT}','Claude','oauth',ARRAY['astropath:read'],'owner','owner')`,
  );
  await send(await logout({ sub: "sub-owner", sid: "sid-a" }));
  expect(
    (
      await env.database.query(
        "SELECT 1 FROM ap_connections WHERE revoked_at IS NULL",
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await env.database.query(
        "SELECT 1 FROM ap_members WHERE disabled_at IS NULL",
      )
    ).rows,
  ).toHaveLength(2);
});

it("an unknown session is a harmless no-op", async () => {
  expect(await send(await logout({ sub: "nobody", sid: "sid-zzz" }))).toBe(0);
  expect(await sessions()).toHaveLength(4);
});

it("rejects a replayed token", async () => {
  const token = await logout({ sub: "sub-izzy", sid: "sid-b" });
  expect(await send(token)).toBe(1);
  await expect(send(token)).rejects.toMatchObject({ status: 400 });
});

it.each([
  ["a missing token", async () => null],
  [
    "a bad signature",
    () => logout({ sub: "sub-owner", sid: "sid-a" }, {}, other),
  ],
  [
    "the wrong type",
    () => logout({ sub: "sub-owner", sid: "sid-a" }, { typ: "JWT" }),
  ],
  [
    "the wrong audience",
    () =>
      logout(
        { sub: "sub-owner", sid: "sid-a" },
        { audience: "another-client" },
      ),
  ],
  [
    "the wrong issuer",
    () =>
      logout(
        { sub: "sub-owner", sid: "sid-a" },
        { issuer: "https://evil.test/api/auth" },
      ),
  ],
  [
    "an expired token",
    () =>
      logout(
        { sub: "sub-owner", sid: "sid-a" },
        { expires: Math.floor(Date.now() / 1000) - 60 },
      ),
  ],
  ["a nonce", () => logout({ sub: "sub-owner", sid: "sid-a", nonce: "n" })],
  [
    "no events",
    () =>
      sign(
        signer,
        { sub: "sub-owner", sid: "sid-a" },
        { typ: "logout+jwt", audience: CLIENT_ID },
      ),
  ],
  [
    "the wrong event",
    () =>
      sign(
        signer,
        { sub: "p", sid: "sid-a", events: { other: {} } },
        { typ: "logout+jwt", audience: CLIENT_ID },
      ),
  ],
  ["neither sid nor sub", () => logout({})],
])("answers 400 and ends nothing for %s", async (_name, make) => {
  await expect(send(await make())).rejects.toMatchObject({
    status: 400,
    code: "invalid_logout_token",
  });
  expect(await sessions()).toHaveLength(4);
});
