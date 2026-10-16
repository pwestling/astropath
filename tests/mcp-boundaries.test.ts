import { expect, it, vi } from "vitest";
import { mcpFor } from "../src/lib/mcp";
import type { Principal } from "../src/lib/policy";

vi.mock("../src/lib/agents", async (original) => {
  const actual = await original<typeof import("../src/lib/agents")>();
  return {
    ...actual,
    agents: { ...actual.agents, me: async () => ({ agent: null }) },
  };
});
vi.mock("../src/lib/file-transfers", async (original) => {
  const actual = await original<typeof import("../src/lib/file-transfers")>();
  return {
    ...actual,
    uploadInline: async (
      _principal: Principal,
      _metadata: unknown,
      content: string,
    ) => ({ bytes: Buffer.from(content, "base64").length }),
  };
});
const principal: Principal = {
  id: "first-client",
  name: "Test",
  owner: false,
  scopes: ["astropath:read", "astropath:write"],
  spaces: ["general"],
};
function handler(identity = principal) {
  return mcpFor(identity, {
    authenticate: async () => identity,
    signal: new AbortController().signal,
  });
}
function request(id: number, method: string, params: unknown) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}
async function rpc(
  identity: Principal,
  id: number,
  name: string,
  args: unknown,
) {
  const response = await handler(identity).fetch(
    request(id, "tools/call", { name, arguments: args }),
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  return JSON.parse(
    text.startsWith("event:") || text.startsWith("data:")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6)
      : text,
  );
}

it("initializes and lists tools using the stateless client protocol", async () => {
  const initialized = await handler().fetch(
    request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    }),
  );
  expect(initialized.status).toBe(200);
  expect(await initialized.text()).toContain("serverInfo");
  const listed = await handler().fetch(request(2, "tools/list", {}));
  expect(listed.status).toBe(200);
  expect(await listed.text()).toContain("get_identity");
});

it("rejects bodies exceeding 4 MiB before parsing or invoking a tool", async () => {
  const response = await handler().fetch(
    request(3, "tools/call", {
      name: "get_identity",
      arguments: { oversized: "x".repeat(4 * 1024 * 1024) },
    }),
  );
  expect(response.status).toBe(413);
});

it("rejects excessive input elements before tool schema validation", async () => {
  const response = await rpc(principal, 4, "get_identity", {
    oversized: Array(10_001).fill(0),
  });
  expect(JSON.stringify(response)).toContain("maximum of 10000 elements");
});

it("keeps concurrent clients with the same JSON-RPC ID separate", async () => {
  const second = { ...principal, id: "second-client" };
  const results = await Promise.all([
    rpc(principal, 10, "get_identity", {}),
    rpc(second, 10, "get_identity", {}),
  ]);
  expect(results.map((item) => item.id)).toEqual([10, 10]);
  expect(JSON.parse(results[0].result.content[0].text).identity.id).toBe(
    principal.id,
  );
  expect(JSON.parse(results[1].result.content[0].text).identity.id).toBe(
    second.id,
  );
});

it("accepts the documented 2 MiB inline upload without contacting storage", async () => {
  const size = 2 * 1024 * 1024;
  const result = await rpc(principal, 12, "upload_small_file", {
    name: "boundary.bin",
    content_type: "application/octet-stream",
    size,
    content_base64: Buffer.alloc(size).toString("base64"),
  });
  expect(result.result.isError).not.toBe(true);
  expect(JSON.parse(result.result.content[0].text).bytes).toBe(size);
});
