import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import type { Database } from "../src/lib/db";
import { IdentityStore } from "../src/lib/identities";
import { MessageStore } from "../src/lib/store";

const engine = new PGlite();
const database: Database = {
  query: async <T extends QueryResultRow>(sql: string, values?: unknown[]) => {
    const result = await engine.query<T>(sql, values);
    return { rows: result.rows };
  },
  transaction: (fn) =>
    engine.transaction((tx) =>
      fn({
        query: async <T extends QueryResultRow>(
          sql: string,
          values?: unknown[],
        ) => {
          if (sql.startsWith("SELECT pg_advisory_xact_lock"))
            return { rows: [] };
          const result = await tx.query<T>(sql, values);
          return { rows: result.rows };
        },
      }),
    ),
};
const identities = new IdentityStore(database);
const messages = new MessageStore(database);
const approval = (name: string) => ({
  name,
  clientId: "shared-claude-client",
  userId: "owner",
  approvalKey: randomUUID(),
  scopes: ["astropath:read", "astropath:write"],
});

beforeAll(async () => {
  const schema = await readFile(
    new URL("../src/lib/schema.sql", import.meta.url),
    "utf8",
  );
  // Simulate an existing deployment, then apply the additive migration twice.
  await engine.exec(`CREATE TABLE ap_connections (
    id uuid PRIMARY KEY, name text NOT NULL, kind text NOT NULL,
    token_hash text UNIQUE, token_prefix text, oauth_client_id text UNIQUE,
    scopes text[] NOT NULL, spaces text[], created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz, expires_at timestamptz, revoked_at timestamptz
  )`);
  await engine.query(
    "INSERT INTO ap_connections(id,name,kind,oauth_client_id,scopes) VALUES($1,'Legacy Claude','oauth','shared-claude-client',$2)",
    [randomUUID(), ["astropath:read"]],
  );
  await engine.exec(schema);
  await engine.exec(schema);
});
afterAll(() => engine.close());

it("preserves legacy OAuth connections during repeatable migration", async () => {
  const { rows } = await database.query(
    "SELECT name,oauth_client_id,oauth_approval_key FROM ap_connections WHERE name='Legacy Claude'",
  );
  expect(rows).toEqual([
    {
      name: "Legacy Claude",
      oauth_client_id: "shared-claude-client",
      oauth_approval_key: null,
    },
  ]);
});

it("keeps identities, senders, and read receipts distinct for one shared OAuth client", async () => {
  const personal = await identities.approve(approval("Claude Personal"));
  const work = await identities.approve(approval("Claude Work"));
  expect(personal).not.toBe(work);
  const principal = (id: string, name: string) => ({
    id,
    name,
    owner: false,
    scopes: ["astropath:read", "astropath:write"],
    spaces: null,
  });
  const sender = principal("sender", "Muse");
  const { message } = await messages.create(sender, { title: "Shared message" });
  await messages.acknowledge(principal(personal, "Claude Personal"), message.id);
  expect(
    (await messages.list(principal(personal, "Claude Personal"), { unread: true }))
      .messages,
  ).toHaveLength(0);
  expect(
    (await messages.list(principal(work, "Claude Work"), { unread: true })).messages,
  ).toHaveLength(1);
  const reply = await messages.create(principal(work, "Claude Work"), {
    title: "Acknowledged",
    parent_id: message.id,
  });
  expect(reply.message.sender).toBe("Claude Work");
  expect(reply.message.principal_id).toBe(work);
});

it("reuses a retried approval without creating another identity", async () => {
  const input = approval("Retry identity");
  expect(await identities.approve(input)).toBe(await identities.approve(input));
  await expect(
    identities.approve({ ...input, name: "Different identity" }),
  ).rejects.toThrow("already been used");
  await expect(
    identities.approve({ ...input, userId: "someone-else" }),
  ).rejects.toThrow("already been used");
  await expect(
    identities.approve({ ...input, clientId: "another-client" }),
  ).rejects.toThrow("already been used");
});

it("rejects duplicate active names across token and OAuth connections", async () => {
  await database.query(
    "INSERT INTO ap_connections(id,name,kind,scopes) VALUES($1,'Muse','token',$2)",
    [randomUUID(), ["astropath:read"]],
  );
  await expect(identities.approve(approval("  MUSE  "))).rejects.toThrow(
    "already in use",
  );
  await expect(identities.approve(approval("Legacy Claude"))).rejects.toThrow(
    "already in use",
  );
});

it("does not revive revoked identities on approval retries", async () => {
  const input = approval("Revoked identity");
  const id = await identities.approve(input);
  await database.query(
    "UPDATE ap_connections SET revoked_at=now() WHERE id=$1",
    [id],
  );
  await expect(identities.approve(input)).rejects.toThrow("revoked");
  expect(await identities.approve(approval("Revoked identity"))).not.toBe(id);
});

it("rejects empty, oversized, or control-character names", async () => {
  for (const name of ["   ", "a".repeat(81), "Claude\nWork"])
    await expect(identities.approve(approval(name))).rejects.toThrow();
});
