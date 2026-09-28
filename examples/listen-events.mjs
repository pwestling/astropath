// Node.js 24+. Set ASTROPATH_URL and ASTROPATH_TOKEN, then see docs/events.md.
import { readFile, writeFile, rename } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

class StopListening extends Error {}
const { values } = parseArgs({
  options: {
    space: { type: "string" },
    recipient: { type: "string" },
    after: { type: "string" },
    "cursor-file": { type: "string" },
  },
});

// Replace this with your work. It must finish successfully before saving the cursor.
// Use event.id as an idempotency key if handling the event has side effects.
async function handleEvent(event) {
  console.log(JSON.stringify(event));
}

async function* frames(body) {
  const decoder = new TextDecoder();
  let pending = "";
  let frame = { event: "message", data: [] };
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, boundary).replace(/\r$/, "");
      pending = pending.slice(boundary + 1);
      if (!line) {
        if (frame.data.length)
          yield { ...frame, data: JSON.parse(frame.data.join("\n")) };
        frame = { event: "message", data: [] };
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value =
          colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") frame.data.push(value);
        else if (field === "event") frame.event = value;
        else if (field === "id") frame.id = value;
      }
    }
  }
}

async function main() {
  const baseUrl = process.env.ASTROPATH_URL;
  const token = process.env.ASTROPATH_TOKEN;
  if (!baseUrl || !token)
    throw new StopListening("Set ASTROPATH_URL and ASTROPATH_TOKEN.");
  const url = new URL("/api/v1/events", baseUrl);
  if (values.space) url.searchParams.set("space", values.space);
  if (values.recipient) url.searchParams.set("recipient", values.recipient);
  let cursor = values.after;
  const cursorFile = values["cursor-file"];
  if (cursorFile) {
    try {
      const saved = JSON.parse(await readFile(cursorFile, "utf8"));
      if (saved.url !== url.href)
        throw new StopListening(
          "Use a separate cursor file for each instance and subscription filter.",
        );
      cursor = saved.cursor;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (cursor !== undefined && !/^(0|[1-9][0-9]{0,18})$/.test(cursor))
    throw new StopListening("The saved event cursor is invalid.");
  while (true) {
    let retryMs = 3000;
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
          ...(cursor !== undefined ? { "Last-Event-ID": cursor } : {}),
        },
        // The server rotates at 50 seconds; recover from a stalled network too.
        signal: AbortSignal.timeout(65000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status !== 429 && response.status < 500)
          throw new StopListening(
            `Subscription rejected (HTTP ${response.status}). Check token, permissions, filters and cursor.`,
          );
        const retrySeconds = Number(response.headers.get("retry-after") || 3);
        retryMs = Number.isFinite(retrySeconds)
          ? Math.max(3000, Math.min(60000, retrySeconds * 1000))
          : 3000;
        throw new Error(`HTTP ${response.status}`);
      }
      for await (const frame of frames(response.body)) {
        if (frame.event === "stream_error") {
          if (!frame.data.retryable)
            throw new StopListening(`Subscription stopped: ${frame.data.code}`);
          throw new Error(frame.data.code);
        }
        if (frame.event.startsWith("message.")) {
          try {
            await handleEvent(frame.data);
          } catch (error) {
            throw new StopListening(`Event handler failed: ${error.message}`);
          }
        }
        if (frame.id !== undefined) {
          if (cursorFile) {
            try {
              await writeFile(
                `${cursorFile}.tmp`,
                JSON.stringify({ url: url.href, cursor: frame.id }),
                { mode: 0o600 },
              );
              await rename(`${cursorFile}.tmp`, cursorFile);
            } catch (error) {
              throw new StopListening(
                `Unable to save cursor: ${error.message}`,
              );
            }
          }
          cursor = frame.id;
        }
      }
    } catch (error) {
      if (error instanceof StopListening) throw error;
      console.error(`Reconnecting: ${error.message}`);
    }
    await delay(retryMs);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
