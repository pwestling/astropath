import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, db } from "../src/lib/db";
import { mintToken, type Principal } from "../src/lib/policy";
import { MessageStore } from "../src/lib/store";
import { EventStore } from "../src/lib/events";
import { MemberStore } from "../src/lib/members";

const base = process.env.APP_URL!;
const suffix = randomUUID().slice(0, 8);
const space = `events-${suffix}`;
const other = `other-${suffix}`;
const owner: Principal = {
  id: "owner:events-test",
  userId: "events-test",
  name: "Test Owner",
  owner: true,
  spaces: null,
  scopes: ["astropath:read", "astropath:write"],
};
type Frame = { type: string; id?: string; data: Record<string, unknown> };
type TestStream = {
  frames: Frame[];
  completion: Promise<void>;
  close: () => void;
  wait: (
    predicate: (frame: Frame) => boolean,
    timeout?: number,
  ) => Promise<Frame>;
};
const streams: TestStream[] = [];
const children: ChildProcess[] = [];
async function token(
  spaces: string[] | null,
  creator: string | null = null,
  scopes = owner.scopes,
) {
  const minted = mintToken();
  const id = randomUUID();
  await pool.query(
    "INSERT INTO ap_connections(id,name,kind,token_hash,scopes,spaces,created_by_user_id) VALUES($1,$2,'token',$3,$4,$5,$6)",
    [id, `SSE ${id}`, minted.tokenHash, scopes, spaces, creator],
  );
  return { id, value: minted.token };
}
async function api(
  token: string,
  path: string,
  body?: unknown,
  expected = 200,
) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, path);
  return response.json();
}
async function listen(
  token: string,
  query: string,
  after?: string,
): Promise<TestStream> {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/v1/events?${query}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(after ? { "Last-Event-ID": after } : {}),
    },
    signal: abort.signal,
  });
  assert.equal(response.status, 200, "SSE response");
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  const frames: Frame[] = [];
  let ended = false;
  let failure: unknown;
  const completion = (async () => {
    let pending = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body!) {
        pending += decoder.decode(chunk, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const raw = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const lines = raw.split("\n");
          const type = lines
            .find((line) => line.startsWith("event: "))
            ?.slice(7);
          const data = lines
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (type && data)
            frames.push({
              type,
              id: lines.find((line) => line.startsWith("id: "))?.slice(4),
              data: JSON.parse(data),
            });
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) failure = error;
    } finally {
      ended = true;
    }
  })();
  const stream = {
    frames,
    completion,
    close: () => abort.abort(),
    async wait(predicate: (frame: Frame) => boolean, timeout = 8000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const frame = frames.find(predicate);
        if (frame) return frame;
        if (failure) throw failure;
        if (ended) throw new Error("SSE ended before expected event");
        await delay(20);
      }
      throw new Error("Timed out waiting for SSE event");
    },
  };
  streams.push(stream);
  await stream.wait((frame) => frame.type === "ready");
  return stream;
}

async function main() {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
  assert.ok(
    ["localhost", "127.0.0.1"].includes(
      new URL(process.env.DATABASE_URL!).hostname,
    ),
    "Use a disposable local database",
  );
  assert.match(process.env.OWNER_EMAIL!, /^identity-test-/);
  await pool.query(
    "INSERT INTO ap_spaces(slug,name) VALUES($1,'Events Test'),($2,'Other')",
    [space, other],
  );
  const all = await token(null);
  const restricted = await token([space]);
  const writeOnly = await token([space], null, ["astropath:write"]);
  for (const [query, auth, status] of [
    ["", "", 401],
    ["", writeOnly.value, 403],
    [`space=${other}`, restricted.value, 404],
    ["after=-1", restricted.value, 400],
    ["after=9223372036854775808", restricted.value, 400],
    ["after=9223372036854775807", restricted.value, 400],
    ["token=forbidden", restricted.value, 400],
  ] as const) {
    const response = await fetch(`${base}/api/v1/events?${query}`, {
      headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    });
    assert.equal(response.status, status, query);
    await response.body?.cancel();
  }
  assert.equal(
    (await fetch(`${base}/api/v1/events`, { method: "HEAD" })).status,
    405,
  );
  const stream = await listen(
    restricted.value,
    `space=${space}&recipient=Muse`,
  );
  const first = await api(
    restricted.value,
    "messages",
    { title: "First", recipient: "Muse" },
    201,
  );
  await api(
    all.value,
    "messages",
    { title: "Secret", space: other, recipient: "Muse" },
    201,
  );
  await api(
    restricted.value,
    "messages",
    { title: "Other recipient", recipient: "Claude" },
    201,
  );
  const reply = await api(
    restricted.value,
    "messages",
    { title: "Reply", recipient: "Muse", parent_id: first.message.id },
    201,
  );
  const latest = await stream.wait(
    (frame) => frame.data.message_id === reply.message.id,
  );
  assert.deepEqual(
    stream.frames
      .filter((frame) => frame.type === "message.created")
      .map((frame) => frame.data.message_id),
    [first.message.id, reply.message.id],
  );
  stream.close();
  await stream.completion;
  const offline = await api(
    restricted.value,
    "messages",
    { title: "While disconnected", recipient: "Muse" },
    201,
  );
  const replay = await listen(
    restricted.value,
    `space=${space}&recipient=Muse&after=0`,
    latest.id,
  );
  await replay.wait((frame) => frame.data.message_id === offline.message.id);
  assert.deepEqual(
    replay.frames
      .filter((frame) => frame.type === "message.created")
      .map((frame) => frame.data.message_id),
    [offline.message.id],
  );
  await api(restricted.value, `messages/${offline.message.id}/acknowledge`, {});
  await api(restricted.value, `messages/${offline.message.id}/acknowledge`, {});
  await new MessageStore(db).update(owner, offline.message.id, { pinned: true });
  await replay.wait((frame) => frame.type === "message.updated");
  assert.equal(
    replay.frames.filter((frame) => frame.type === "message.acknowledged").length,
    1,
  );
  console.log(
    "PASS: authenticated SSE, space/recipient filtering, replies, replay, acknowledgements and updates.",
  );

  await pool.query("UPDATE ap_connections SET revoked_at=now() WHERE id=$1", [
    restricted.id,
  ]);
  const revoked = await replay.wait((frame) => frame.type === "stream_error");
  assert.equal(revoked.data.code, "invalid_token");
  assert.equal(revoked.data.retryable, false);
  await replay.completion;
  const expiring = await token([space]);
  const expiringStream = await listen(expiring.value, `space=${space}`);
  await pool.query(
    "UPDATE ap_connections SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expiring.id],
  );
  assert.equal(
    (await expiringStream.wait((frame) => frame.type === "stream_error")).data
      .code,
    "invalid_token",
  );

  const members = new MemberStore(db);
  const invitation = await members.create(owner, {
    name: "SSE Member",
    email: `sse-${suffix}@example.com`,
    spaces: [space, other],
  });
  await members.accept(
    new URLSearchParams(new URL(invitation.invite_url).hash.slice(1)).get(
      "token",
    )!,
    "synthetic-events-password",
  );
  const userId = (
    await pool.query<{ user_id: string }>(
      "SELECT user_id FROM ap_members WHERE id=$1",
      [invitation.member.id],
    )
  ).rows[0].user_id;
  const memberToken = await token([space, other], userId);
  const memberStream = await listen(memberToken.value, "");
  await members.update(owner, String(invitation.member.id), {
    spaces: [space],
  });
  const hidden = await api(
    all.value,
    "messages",
    { title: "Newly forbidden", space: other },
    201,
  );
  const visible = await api(
    memberToken.value,
    "messages",
    { title: "Still visible", space },
    201,
  );
  await memberStream.wait((frame) => frame.data.message_id === visible.message.id);
  assert.ok(
    memberStream.frames.every((frame) => frame.data.message_id !== hidden.message.id),
  );
  await members.update(owner, String(invitation.member.id), { disabled: true });
  assert.equal(
    (await memberStream.wait((frame) => frame.type === "stream_error")).data
      .code,
    "access_revoked",
  );
  console.log(
    "PASS: already-open streams enforce token revocation, expiry, membership changes and account disablement.",
  );

  const eventStore = new EventStore(db);
  const before = await eventStore.latest();
  const transaction = await pool.connect();
  try {
    await transaction.query("BEGIN");
    await transaction.query("SELECT pg_advisory_xact_lock(1788124201, 1)");
    const pending = (
      await transaction.query<{ id: string }>(
        "INSERT INTO ap_events(type,space,message_id,actor_id,actor,data) VALUES('message.updated',$1,$2,'test','Test','{}') RETURNING id::text",
        [space, offline.message.id],
      )
    ).rows[0].id;
    let completed = false;
    const concurrent = new MessageStore(db)
      .create(owner, { title: "Concurrent commit", space })
      .then((result) => {
        completed = true;
        return result;
      });
    await delay(150);
    assert.equal(completed, false);
    assert.equal(
      await eventStore.latest(),
      before,
      "No higher ID commits while a lower ID is uncommitted",
    );
    await transaction.query("COMMIT");
    await concurrent;
    const batch = await eventStore.read(owner, { space }, before);
    assert.equal(batch.events[0].id, pending);
    assert.equal(batch.events.length, 2);
    assert.ok(BigInt(batch.events[1].id) > BigInt(pending));
  } finally {
    await transaction.query("ROLLBACK");
    transaction.release();
  }
  console.log(
    "PASS: concurrent transactions preserve cursor ordering without missed notifications.",
  );
  const directory = await mkdtemp(join(tmpdir(), "astropath-listener-"));
  const cursorFile = join(directory, "cursor.json");
  const sampleToken = await token([space]);
  function listener() {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../examples/listen-events.mjs", import.meta.url),
        ),
        "--space",
        space,
        "--after",
        "0",
        "--cursor-file",
        cursorFile,
      ],
      {
        env: {
          ...process.env,
          ASTROPATH_URL: base,
          ASTROPATH_TOKEN: sampleToken.value,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    let output = "";
    let errors = "";
    child.stdout.on("data", (value) => {
      output += value;
    });
    child.stderr.on("data", (value) => {
      errors += value;
    });
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    return { child, completion, output: () => output, errors: () => errors };
  }
  async function savedCursor(expected: string) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        if (JSON.parse(await readFile(cursorFile, "utf8")).cursor === expected)
          return;
      } catch {
        /* The listener may not have written its first cursor yet. */
      }
      await delay(20);
    }
    throw new Error("Listener did not save expected cursor");
  }
  try {
    const firstRun = listener();
    await savedCursor(await eventStore.latest());
    firstRun.child.kill("SIGTERM");
    await firstRun.completion;
    assert.ok(firstRun.output().includes("message.created"));
    const fresh = await new MessageStore(db).create(owner, {
      title: "Listener restart",
      space,
    });
    const secondRun = listener();
    await savedCursor(await eventStore.latest());
    const received = secondRun
      .output()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      received.map((event) => event.message_id),
      [fresh.message.id],
    );
    await pool.query("UPDATE ap_connections SET revoked_at=now() WHERE id=$1", [
      sampleToken.id,
    ]);
    assert.equal(await secondRun.completion, 1);
    assert.match(secondRun.errors(), /Subscription stopped: invalid_token/);
    console.log(
      "PASS: runnable Node listener persists cursors, resumes across restarts, and stops on revocation.",
    );
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
}
main()
  .finally(async () => {
    for (const child of children) child.kill("SIGTERM");
    for (const stream of streams) stream.close();
    await Promise.all(streams.map((stream) => stream.completion));
    await pool.end();
  })
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
