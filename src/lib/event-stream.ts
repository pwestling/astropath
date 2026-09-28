import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "./errors";
import { EventStore, eventSubscription } from "./events";
import type { Principal } from "./policy";

export async function eventResponse(
  request: Request,
  principal: Principal,
  events: EventStore,
  authenticate: () => Promise<Principal>,
  options: { pollMs?: number; heartbeatMs?: number; lifetimeMs?: number } = {},
) {
  const { after, ...filter } = eventSubscription(request);
  await events.validate(principal, filter);
  const head = await events.latest();
  if (after && BigInt(after) > BigInt(head))
    throw new AppError(
      400,
      "invalid_cursor",
      "The event cursor is ahead of this instance's event log.",
    );
  let cursor = after ?? head;
  const pollMs = options.pollMs ?? 2000;
  const heartbeatMs = options.heartbeatMs ?? 15000;
  const lifetimeMs = options.lifetimeMs ?? 50000;
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let stop: (close?: boolean) => void = () => {};
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        let lastFrame = Date.now();
        const timer = setTimeout(() => {
          send("reconnect", { reason: "rotation" });
          stop();
        }, lifetimeMs);
        const onAbort = () => stop();
        stop = (close = true) => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          abort.abort();
          request.signal.removeEventListener("abort", onAbort);
          if (close) controller.close();
        };
        function write(frame: string) {
          if (closed) return false;
          // Bound memory for clients that stop consuming. Their saved cursor allows replay.
          if ((controller.desiredSize ?? 0) <= 0) {
            stop();
            return false;
          }
          controller.enqueue(encoder.encode(frame));
          lastFrame = Date.now();
          return true;
        }
        function send(type: string, data: unknown, id?: string) {
          return write(
            `${id === undefined ? "" : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
          );
        }
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) {
          stop();
          return;
        }
        write("retry: 3000\n\n");
        send("ready", { cursor }, cursor);
        void (async () => {
          try {
            while (!closed) {
              // Recheck revocation, expiry and membership on every batch, even while idle.
              const current = await authenticate();
              if (closed) return;
              const batch = await events.read(current, filter, cursor);
              for (const event of batch.events) {
                if (!send(event.type, event, event.id)) return;
                cursor = event.id;
              }
              if (batch.cursor !== cursor) {
                if (!send("checkpoint", { cursor: batch.cursor }, batch.cursor))
                  return;
                cursor = batch.cursor;
              }
              if (Date.now() - lastFrame >= heartbeatMs)
                write(": heartbeat\n\n");
              await delay(pollMs, undefined, { signal: abort.signal });
            }
          } catch (error) {
            if (!closed) {
              const known = error instanceof AppError;
              if (!known)
                console.error(
                  "Astropath event stream failed",
                  error instanceof Error ? error.message : "Unknown error",
                );
              send("stream_error", {
                code: known ? error.code : "internal_error",
                retryable: !known || error.status >= 500,
              });
            }
          } finally {
            stop();
          }
        })();
      },
      cancel() {
        stop(false);
      },
    },
    { highWaterMark: 65536, size: (chunk) => chunk.byteLength },
  );
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
