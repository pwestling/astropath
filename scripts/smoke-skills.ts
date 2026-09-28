import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { pool } from "../src/lib/db";
import { newTenantKey } from "../src/lib/encryption";
import { mintToken } from "../src/lib/policy";
import { ownerEmail } from "../src/lib/config";

const base = process.env.SMOKE_URL || "http://localhost:3000";
const tenants = [randomUUID(), randomUUID()];
const connections = [randomUUID(), randomUUID()];
const tokens = [mintToken(), mintToken()];
const client = new Client({ name: "Astropath skills smoke", version: "1.0.0" });
async function api(
  path: string,
  index = 0,
  method = "GET",
  body?: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens[index].token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}
async function main() {
  const user = (
    await pool.query<{ id: string; name: string; email: string }>(
      'SELECT id,name,email FROM "user" WHERE lower(email)=$1',
      [ownerEmail()],
    )
  ).rows[0];
  assert.ok(user, "Create the owner before running the smoke test");
  for (const [index, id] of tenants.entries()) {
    await pool.query(
      "INSERT INTO ap_tenants(id,name,wrapped_key) VALUES($1,$2,$3)",
      [id, `Skills smoke ${id.slice(0, 8)}`, newTenantKey(id)],
    );
    await pool.query(
      "INSERT INTO ap_spaces(tenant_id,slug,name) VALUES($1,'general','General')",
      [id],
    );
    await pool.query(
      "INSERT INTO ap_members(id,tenant_id,email,name,user_id,spaces,role) VALUES($1,$2,$3,$4,$5,ARRAY['general'],'owner')",
      [randomUUID(), id, user.email, user.name, user.id],
    );
    await pool.query(
      "INSERT INTO ap_connections(id,tenant_id,name,kind,token_hash,scopes,created_by_user_id) VALUES($1,$2,'Skills smoke','token',$3,$4,$5)",
      [
        connections[index],
        id,
        tokens[index].tokenHash,
        ["astropath:read", "astropath:write"],
        user.id,
      ],
    );
  }
  const message = await api(
    "messages",
    0,
    "POST",
    { title: "Tenant boundary", body: "private" },
    201,
  );
  await api(`messages/${message.message.id}`, 1, "GET", undefined, 404);
  assert.equal(
    (
      await api("me", 0, "GET", undefined, 200, {
        "X-Astropath-Tenant": tenants[1],
      })
    ).identity.tenantId,
    tenants[0],
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[0].token}` } },
    }),
  );
  async function tool(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    return JSON.parse(text.text);
  }
  const input = {
    slug: "smoke-review",
    files: {
      "SKILL.md": "# Review\nCheck tests.",
      "notes/rules.md": "Keep findings actionable.",
    },
  };
  const first = await tool("publish_skill", input);
  assert.equal((await api("skills", 0, "POST", input, 201)).id, first.id);
  const second = await api(
    "skills",
    0,
    "POST",
    {
      ...input,
      files: { "SKILL.md": "# Review\nCheck tests and permissions." },
    },
    201,
  );
  assert.equal(second.revision, 2);
  assert.deepEqual(
    (await tool("pull_skill", { slug: input.slug, revision_id: first.id }))
      .files,
    input.files,
  );
  assert.equal(
    (await tool("list_skill_revisions", { slug: input.slug })).revisions.length,
    2,
  );
  await api(
    `skills/${input.slug}?revision_id=${first.id}`,
    1,
    "GET",
    undefined,
    404,
  );
  assert.equal((await api("skills", 1)).skills.length, 0);
  await tool("deprecate_skill", {
    slug: input.slug,
    reason: "Smoke deprecation",
  });
  assert.equal((await api("skills")).skills.length, 0);
  await api(`skills/${input.slug}`, 0, "GET", undefined, 409);
  assert.equal(
    (await api(`skills/${input.slug}?revision_id=${first.id}`))
      .deprecation_reason,
    "Smoke deprecation",
  );
  await api(`skills/${input.slug}`, 0, "PATCH", { deprecated: false });
  assert.equal((await tool("pull_skill", { slug: input.slug })).id, second.id);
  const raw = (
    await pool.query(
      "SELECT encrypted_content FROM ap_skill_revisions WHERE id=$1",
      [first.id],
    )
  ).rows[0];
  assert.ok(!JSON.stringify(raw).includes("Keep findings actionable"));
  console.log(
    "PASS: HTTP/MCP tenant isolation, pinned credentials, encrypted skills, immutable history, retries, deprecation and restoration",
  );
}
main()
  .finally(async () => {
    await client.close().catch(() => {});
    // Retain immutable test history in disabled test tenants; never bypass revision immutability.
    await pool.query(
      "UPDATE ap_connections SET revoked_at=now() WHERE id=ANY($1::uuid[])",
      [connections],
    );
    await pool.query(
      "UPDATE ap_tenants SET disabled_at=now() WHERE id=ANY($1::uuid[])",
      [tenants],
    );
    await pool.end();
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Smoke test failed");
    process.exitCode = 1;
  });
