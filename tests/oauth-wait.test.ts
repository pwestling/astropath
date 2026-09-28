import { beforeEach, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { userPrincipal, connectionSpaces } from "../src/lib/access";
import { CONNECTION_CLAIM } from "../src/lib/identities";
import { oauthPrincipal } from "../src/lib/security";

vi.mock("../src/lib/db", () => ({ db: { query: vi.fn() } }));
vi.mock("../src/lib/auth", () => ({ getAuth: vi.fn() }));
vi.mock("../src/lib/access", () => ({
  userPrincipal: vi.fn(),
  connectionSpaces: vi.fn(),
}));
const id = "00000000-0000-4000-8000-000000000001";
const claims = {
  sub: "owner",
  client_id: "client",
  scope: "astropath:read astropath:write",
  [CONNECTION_CLAIM]: id,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(userPrincipal).mockResolvedValue({
    id: "owner:owner",
    userId: "owner",
    name: "Owner",
    owner: true,
    spaces: null,
    scopes: ["astropath:read", "astropath:write"],
  });
  vi.mocked(connectionSpaces).mockResolvedValue(["general"]);
});

it("rechecks token expiry while waiting even after the JWT was initially verified", async () => {
  await expect(
    oauthPrincipal(
      { ...claims, exp: Math.floor(Date.now() / 1000) - 1 },
      { touch: false },
    ),
  ).rejects.toMatchObject({ status: 401, code: "invalid_token" });
  expect(db.query).not.toHaveBeenCalled();
});
it("honors current named-connection scopes and space membership without writing every poll", async () => {
  vi.mocked(db.query).mockResolvedValue({
    rows: [
      { id, name: "Claude Work", spaces: null, scopes: ["astropath:read"] },
    ],
  });
  const current = await oauthPrincipal(claims, { touch: false });
  expect(current).toMatchObject({
    id,
    scopes: ["astropath:read"],
    spaces: ["general"],
  });
  expect(vi.mocked(db.query).mock.calls[0][0]).toMatch(/^SELECT/);
  expect(connectionSpaces).toHaveBeenCalledWith(db, null, "owner");
});
it("rejects an active wait after named connection revocation or account disabling", async () => {
  vi.mocked(db.query).mockResolvedValue({ rows: [] });
  await expect(oauthPrincipal(claims, { touch: false })).rejects.toMatchObject({
    code: "connection_revoked",
  });
  vi.mocked(userPrincipal).mockResolvedValue(null);
  await expect(oauthPrincipal(claims, { touch: false })).rejects.toMatchObject({
    code: "access_revoked",
  });
});
it("does not recreate a deleted legacy connection during a wait", async () => {
  vi.mocked(db.query).mockResolvedValue({ rows: [] });
  await expect(
    oauthPrincipal(
      { sub: "owner", client_id: "legacy", scope: "astropath:read" },
      { touch: false },
    ),
  ).rejects.toMatchObject({ code: "connection_revoked" });
  expect(
    vi.mocked(db.query).mock.calls.every(([sql]) => sql.startsWith("SELECT")),
  ).toBe(true);
});
