import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  ["https://handoffs.example.com", "https://handoffs.example.com/connection"],
  ["https://notes.example.net/", "https://notes.example.net/connection"],
])(
  "namespaces OAuth identities under the configured origin %s",
  async (origin, claim) => {
    vi.stubEnv("APP_URL", origin);
    vi.resetModules();
    const { CONNECTION_CLAIM } = await import("../src/lib/identities");
    expect(CONNECTION_CLAIM).toBe(claim);
  },
);

it("reads only the configured OAuth identity namespace", async () => {
  vi.stubEnv("APP_URL", "https://astropath.example.com");
  const { oauthConnectionClaim, CONNECTION_CLAIM } =
    await import("../src/lib/identities");
  expect(oauthConnectionClaim({ [CONNECTION_CLAIM]: "current-id" })).toBe(
    "current-id",
  );
  expect(
    oauthConnectionClaim({
      "https://deaddrop.thehivemind5.com/connection": "old-id",
    }),
  ).toBeUndefined();
  expect(oauthConnectionClaim({ [CONNECTION_CLAIM]: null })).toBeNull();
  expect(oauthConnectionClaim({})).toBeUndefined();
});
