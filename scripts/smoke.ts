import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { deleteFile } from "../src/lib/storage";
import { pool } from "../src/lib/db";
import { mintToken } from "../src/lib/policy";

const base = process.env.SMOKE_URL || "http://localhost:3000";
const space = `smoke-${randomUUID().slice(0, 8)}`;
const principals = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const tokens = principals.map(() => mintToken());
const client = new Client({ name: "Astropath smoke check", version: "1.0.0" });

async function api(
  path: string,
  index = 0,
  method = "GET",
  body?: unknown,
  status = 200,
  extra: Record<string, string> = {},
) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens[index].token}`,
      "Content-Type": "application/json",
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${JSON.stringify(data)}`,
  );
  return data;
}

async function main() {
  await pool.query("INSERT INTO ap_spaces(slug,name) VALUES($1,$2)", [
    space,
    "Smoke verification",
  ]);
  for (let index = 0; index < principals.length; index++) {
    await pool.query(
      "INSERT INTO ap_connections(id,name,kind,token_hash,token_prefix,scopes,spaces) VALUES($1,$2,'token',$3,$4,$5,$6)",
      [
        principals[index],
        `Smoke ${index}`,
        tokens[index].tokenHash,
        tokens[index].prefix,
        index === 1 ? ["astropath:read"] : ["astropath:read", "astropath:write"],
        index === 2 ? ["general"] : [space],
      ],
    );
  }
  assert.equal((await fetch(`${base}/api/v1/messages`)).status, 401);
  await api("connections", 0, "GET", undefined, 403);
  const payload = {
    title: "Smoke handoff",
    body: "Original context survives across interfaces.",
    space,
  };
  const requests = await Promise.all(
    [0, 1, 2].map(() =>
      api("messages", 0, "POST", payload, 201, {
        "Idempotency-Key": "concurrent-smoke",
      }),
    ),
  );
  assert.equal(new Set(requests.map((r) => r.message.id)).size, 1);
  const id = requests[0].message.id;
  await api("messages", 0, "POST", { ...payload, body: "different" }, 409, {
    "Idempotency-Key": "concurrent-smoke",
  });
  await api("messages", 1, "POST", payload, 403);
  await api(`messages/${id}`, 2, "GET", undefined, 404);
  assert.equal((await api("messages?unread=true", 1)).messages.length, 1);
  await api(`messages/${id}`, 1);
  assert.equal((await api("messages?unread=true", 1)).messages.length, 1);
  await api(`messages/${id}/acknowledge`, 1, "POST", {});
  assert.equal((await api("messages?unread=true", 1)).messages.length, 0);
  console.log(
    "PASS: HTTP authentication, spaces, read-only access, concurrent retries, receipts",
  );

  const streamAbort = new AbortController();
  const streamTimeout = setTimeout(() => streamAbort.abort(), 15_000);
  try {
    const stream = await fetch(`${base}/api/v1/events?space=${space}&after=0`, {
      headers: { Authorization: `Bearer ${tokens[1].token}` },
      signal: streamAbort.signal,
    });
    assert.equal(stream.status, 200);
    assert.match(
      stream.headers.get("content-type") || "",
      /text\/event-stream/,
    );
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("event: message.created")) {
      const chunk = await reader.read();
      assert.equal(
        chunk.done,
        false,
        "Stream ended before replaying its event",
      );
      received += decoder.decode(chunk.value, { stream: true });
    }
    assert.ok(received.includes("event: ready"));
    assert.ok(received.includes(id));
    await reader.cancel();
    console.log(
      "PASS: authenticated SSE, immediate unbuffered frames and event replay",
    );
  } finally {
    clearTimeout(streamTimeout);
    streamAbort.abort();
  }

  const bytes = Buffer.from("Original file bytes.\n", "utf8");
  const upload = await api(
    "files/uploads",
    0,
    "POST",
    {
      name: "original.txt",
      content_type: "text/plain",
      size: bytes.length,
      space,
    },
    201,
  );
  const uploaded = await fetch(upload.upload_url, {
    method: upload.method,
    headers: upload.headers,
    body: bytes,
  });
  assert.equal(
    uploaded.ok,
    true,
    `Direct upload HTTP ${uploaded.status}: ${await uploaded.text()}`,
  );
  await api(`files/${upload.file_id}/complete`, 0, "POST", {});
  await api(`files/${upload.file_id}/download`, 1, "GET", undefined, 404);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a04sAAAAASUVORK5CYII=",
    "base64",
  );
  const inline = await api(
    "files/inline",
    0,
    "POST",
    {
      name: "pixel.png",
      content_type: "image/png",
      size: png.length,
      space,
      content_base64: png.toString("base64"),
    },
    201,
  );
  await api(
    "messages",
    0,
    "POST",
    {
      ...payload,
      title: "Smoke attachments",
      attachment_ids: [upload.file_id, inline.file_id],
    },
    201,
  );
  const download = await api(`files/${upload.file_id}/download`, 1);
  assert.equal((await api("messages?with_files=true", 1)).messages.length, 1);
  const downloaded = await fetch(download.url);
  assert.equal(
    downloaded.ok,
    true,
    `Signed download HTTP ${downloaded.status}`,
  );
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  await api(`files/${upload.file_id}/download`, 2, "GET", undefined, 404);
  console.log(
    "PASS: private direct upload, inline image upload, attachment ownership, exact download bytes",
  );

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[0].token}` } },
    }),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 15);
  const found = await client.callTool({
    name: "list_messages",
    arguments: { space },
  });
  assert.notEqual(found.isError, true);
  const result = await client.callTool({
    name: "read_message",
    arguments: { id },
  });
  assert.notEqual(result.isError, true);
  const image = await client.callTool({
    name: "view_image",
    arguments: { file_id: inline.file_id },
  });
  assert.equal(image.content[0].type, "image");
  console.log(
    "PASS: MCP handshake, tool discovery, shared HTTP/MCP notes, native image content",
  );
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    return JSON.parse(text.text);
  }
  assert.equal((await tool("get_identity")).identity.id, principals[0]);
  const conversation = await tool("send_message", {
    title: "Chat smoke",
    body: "Question",
    space,
    recipient: "Smoke 3",
    idempotency_key: "chat-root",
  });
  const fast = await api(
    `messages/${conversation.message.id}/replies`,
    3,
    "POST",
    { body: "Fast response" },
    201,
    { "Idempotency-Key": "fast-answer" },
  );
  assert.equal(fast.message.recipient, "Smoke 0");
  const caught = await tool("wait_for_reply", {
    message_id: conversation.message.id,
    timeout_seconds: 0,
  });
  assert.deepEqual(
    caught.messages.map((m: { id: string }) => m.id),
    [fast.message.id],
  );
  assert.equal(
    (
      await tool("wait_for_reply", {
        message_id: conversation.message.id,
        after: caught.cursor,
        timeout_seconds: 0,
      })
    ).status,
    "timeout",
  );
  const pending = tool("wait_for_reply", {
    message_id: conversation.message.id,
    after: caught.cursor,
    timeout_seconds: 10,
  });
  const later = (async () => {
    await delay(300);
    const path = `messages/${fast.message.id}/replies`;
    const answer = await api(
      path,
      3,
      "POST",
      { body: "Live followup", recipient: "Smoke 0" },
      201,
      { "Idempotency-Key": "live-answer" },
    );
    assert.equal(
      (
        await api(
          path,
          3,
          "POST",
          { body: "Live followup", recipient: "Smoke 0" },
          201,
          { "Idempotency-Key": "live-answer" },
        )
      ).message.id,
      answer.message.id,
    );
    return answer;
  })();
  const [received, sent] = await Promise.all([pending, later]);
  assert.deepEqual(
    received.messages.map((m: { id: string }) => m.id),
    [sent.message.id],
  );
  const page = await tool("read_thread", { message_id: sent.message.id, limit: 2 });
  assert.equal(page.messages.length, 2);
  assert.equal(
    (
      await tool("read_thread", {
        message_id: conversation.message.id,
        page: page.next_page,
      })
    ).messages[0].id,
    sent.message.id,
  );
  const reply = await tool("reply_to_message", {
    message_id: sent.message.id,
    body: "Received",
    idempotency_key: "chat-confirmation",
  });
  assert.equal(reply.message.recipient, "Smoke 3");
  assert.equal(
    (
      await api(`messages/${conversation.message.id}/wait`, 3, "POST", {
        after: sent.cursor,
        timeout_seconds: 0,
      })
    ).messages[0].id,
    reply.message.id,
  );
  assert.equal(
    (
      await api("messages/wait", 0, "POST", {
        space,
        recipient: "Smoke 0",
        after: conversation.cursor,
        timeout_seconds: 0,
      })
    ).messages.length,
    2,
  );
  assert.equal(
    (await api(`messages/${conversation.message.id}/thread`, 1)).messages.length,
    4,
  );
  await api(
    `messages/${conversation.message.id}/wait`,
    2,
    "POST",
    { timeout_seconds: 0 },
    404,
  );
  await api(
    `messages/${conversation.message.id}/replies`,
    1,
    "POST",
    { body: "Denied" },
    403,
  );
  console.log(
    "PASS: MCP/HTTP live chat, fast replies, retry-safe sends, cursor resume, thread pagination and space isolation",
  );
  // Exercise the stateless 2025 transport used by older MCP clients as well.
  for (const protocolVersion of ["2025-03-26", "2025-11-25"]) {
    async function legacy(method: string, params: Record<string, unknown>) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens[0].token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": protocolVersion,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method,
          params,
        }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      const envelope = response.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? text
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)))
            .find((message) => "result" in message || "error" in message)
        : JSON.parse(text);
      assert.ok(envelope && !envelope.error, text);
      return envelope.result;
    }
    assert.equal(
      (
        await legacy("initialize", {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "Legacy chat smoke", version: "1.0.0" },
        })
      ).protocolVersion,
      protocolVersion,
    );
    const waiting = await legacy("tools/call", {
      name: "wait_for_reply",
      arguments: {
        message_id: conversation.message.id,
        after: reply.cursor,
        timeout_seconds: 0,
      },
    });
    assert.notEqual(waiting.isError, true);
    assert.equal(JSON.parse(waiting.content[0].text).status, "timeout");
  }
  console.log("PASS: chat tools over both supported 2025 MCP transports");
  const revokedWait = client.callTool({
    name: "wait_for_reply",
    arguments: {
      message_id: conversation.message.id,
      after: reply.cursor,
      timeout_seconds: 10,
    },
  });
  await delay(300);
  await pool.query("UPDATE ap_connections SET revoked_at=now() WHERE id=$1", [
    principals[0],
  ]);
  const revokedResult = await revokedWait;
  assert.equal(revokedResult.isError, true);
  assert.ok(JSON.stringify(revokedResult.content).includes("invalid_token"));
  await api("me", 0, "GET", undefined, 401);
  console.log("PASS: token revocation during an active MCP wait");
}

main()
  .finally(async () => {
    await client.close().catch(() => {});
    const files = await pool.query<{ pathname: string }>(
      "SELECT pathname FROM ap_files WHERE space=$1",
      [space],
    );
    for (const file of files.rows) await deleteFile(file.pathname);
    await pool.query(
      "DELETE FROM ap_receipts WHERE message_id IN (SELECT id FROM ap_messages WHERE space=$1)",
      [space],
    );
    await pool.query("DELETE FROM ap_files WHERE space=$1", [space]);
    await pool.query(
      "DELETE FROM ap_activity WHERE target_id IN (SELECT id::text FROM ap_messages WHERE space=$1)",
      [space],
    );
    await pool.query("DELETE FROM ap_messages WHERE space=$1", [space]);
    await pool.query(
      "DELETE FROM ap_rate_limits WHERE split_part(key,':',1)=ANY($1::text[])",
      [principals],
    );
    await pool.query("DELETE FROM ap_connections WHERE id=ANY($1::uuid[])", [
      principals,
    ]);
    await pool.query("DELETE FROM ap_spaces WHERE slug=$1", [space]);
    await pool.end();
  })
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
