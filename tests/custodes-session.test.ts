import { beforeEach, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { custodesSession } from "../src/lib/custodes/session-plugin";

const queries: { sql: string; values?: unknown[] }[] = [];
let denied = false;
function auth() {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  return betterAuth({
    baseURL: "https://ap.test",
    secret: "a-test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter(db),
    // The same workspace-access hook as the real configuration.
    databaseHooks: {
      session: {
        create: {
          before: async () => {
            if (denied)
              throw new APIError("FORBIDDEN", {
                message: "No workspace access",
              });
          },
        },
      },
    },
    plugins: [
      custodesSession(() => ({
        query: async (sql: string, values?: unknown[]) => {
          queries.push({ sql, values });
          return { rows: [] };
        },
      })),
    ],
  });
}
beforeEach(() => {
  queries.length = 0;
  denied = false;
  vi.restoreAllMocks();
});

it("creates a normal Better Auth session cookie for a known user and records the sid", async () => {
  const instance = auth();
  const ctx = await instance.$context;
  const user = await ctx.internalAdapter.createUser(
    {
      email: "a@example.test",
      name: "A",
      emailVerified: true,
    },
    { method: "email" } as never,
  );
  const response = await instance.api.createCustodesSession({
    body: {
      userId: user.id,
      issuer: "https://auth.test/api/auth",
      subject: "sub-a",
      sid: "sid-a",
    },
    asResponse: true,
  });
  const cookie = response.headers.getSetCookie().join("\n");
  expect(cookie).toContain("better-auth.session_token=");
  const sessionId = (await response.json()).sessionId as string;
  expect(queries[0].sql).toContain("INSERT INTO ap_custodes_sessions");
  expect(queries[0].values).toEqual([
    sessionId,
    user.id,
    "https://auth.test/api/auth",
    "sub-a",
    "sid-a",
  ]);
  // The cookie really authenticates a request.
  const session = await instance.api.getSession({
    headers: new Headers({ cookie: cookie.split(";")[0] }),
  });
  expect(session?.user.id).toBe(user.id);
});

it("refuses unknown users, honours the access hook, and is not reachable over HTTP", async () => {
  const instance = auth();
  const ctx = await instance.$context;
  await expect(
    instance.api.createCustodesSession({
      body: { userId: "nobody", issuer: "i", subject: "s", sid: null },
    }),
  ).rejects.toThrow();
  const user = await ctx.internalAdapter.createUser(
    {
      email: "b@example.test",
      name: "B",
      emailVerified: true,
    },
    { method: "email" } as never,
  );
  denied = true;
  await expect(
    instance.api.createCustodesSession({
      body: { userId: user.id, issuer: "i", subject: "s", sid: null },
    }),
  ).rejects.toThrow();
  expect(queries).toHaveLength(0);
  const http = await instance.handler(
    new Request("https://ap.test/api/auth/create-custodes-session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://ap.test",
      },
      body: JSON.stringify({
        userId: user.id,
        issuer: "i",
        subject: "s",
        sid: null,
      }),
    }),
  );
  expect(http.status).toBe(404);
  expect(http.headers.getSetCookie()).toEqual([]);
});

it("rotates the previous session when linking", async () => {
  const instance = auth();
  const ctx = await instance.$context;
  const user = await ctx.internalAdapter.createUser(
    {
      email: "c@example.test",
      name: "C",
      emailVerified: true,
    },
    { method: "email" } as never,
  );
  const old = await ctx.internalAdapter.createSession(user.id, false);
  await instance.api.createCustodesSession({
    body: {
      userId: user.id,
      issuer: "i",
      subject: "s",
      sid: null,
      replace: { sessionId: old.id, token: old.token },
    },
  });
  expect(await ctx.internalAdapter.findSession(old.token)).toBeNull();
  expect(
    queries.some((q) => q.sql.startsWith("DELETE FROM ap_custodes_sessions")),
  ).toBe(true);
});
