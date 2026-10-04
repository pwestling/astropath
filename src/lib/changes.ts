import { z } from "zod";
import { db, forPrincipal, type Database } from "./db";
import { requireScope, requireSpace, type Principal } from "./policy";
import { decodeMessage, type Message } from "./store";
import { spaceSlug } from "./validation";
import type { MemoryAuthor } from "./memory";

// A resumable feed of what changed, for apps that index or mirror Astropath
// content: board topics and replies (created or updated) and memories, with
// content, in the spaces this connection can read. Store the returned cursor
// and pass it as after to continue; nothing is skipped across calls.
export const changesInput = z
  .object({
    after: z
      .string()
      .regex(
        /^e(0|[1-9]\d{0,18})\.m(0|[1-9]\d{0,18})$/,
        "Use a cursor from a previous call.",
      )
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    space: spaceSlug.optional(),
  })
  .strict();

// Memory sequence numbers are allocated before commit, so a just-written
// memory can briefly be invisible below a higher committed one. Only settled
// memories are returned; the feed lags writes by this much.
const SETTLE_SECONDS = 5;

export type Change =
  | {
      kind: "topic" | "reply";
      change: "created" | "updated";
      id: string;
      thread_id: string;
      parent_id: string | null;
      space: string;
      title: string;
      body: string;
      author: string;
      tags: string[];
      pinned: boolean;
      archived_at: string | null;
      at: string;
    }
  | {
      kind: "memory";
      change: "created";
      id: string;
      sequence: string;
      space: string;
      session_id: string | null;
      body: string;
      author: MemoryAuthor;
      at: string;
    };

const iso = (value: string | Date) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export async function readChanges(
  principal: Principal,
  raw: unknown,
  database: Database = db,
) {
  requireScope(principal, "astropath:read");
  const input = changesInput.parse(raw ?? {});
  if (input.space) requireSpace(principal, input.space);
  const [, eventAfter, memoryAfter] =
    /^e(\d+)\.m(\d+)$/.exec(input.after ?? "e0.m0") ?? [];
  const scoped = await forPrincipal(database, principal);
  return scoped.transaction(async (tx) => {
    // The committed high-water mark for events, as EventStore.latest takes it.
    const head = (
      await tx.query<{ id: string }>(
        `WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock_shared(1788124201, 1))
         SELECT COALESCE(pg_sequence_last_value('ap_events_id_seq'::regclass),0)::text AS id FROM locked`,
      )
    ).rows[0].id;
    const events = (
      await tx.query<
        Message & { event_id: string; event_type: string; event_at: string }
      >(
        `SELECT m.*,e.id::text AS event_id,e.type AS event_type,e.created_at AS event_at
         FROM ap_events e JOIN ap_messages m ON m.id=e.message_id
         WHERE e.id>$1::bigint AND e.id<=$2::bigint
           AND e.type IN ('message.created','message.updated')
           AND ($3::text[] IS NULL OR e.space=ANY($3)) AND ($4::text IS NULL OR e.space=$4)
         ORDER BY e.id LIMIT $5`,
        [eventAfter, head, principal.spaces, input.space ?? null, input.limit],
      )
    ).rows;
    const memories = (
      await tx.query<{
        id: string;
        sequence: string;
        space: string;
        session_id: string | null;
        created_at: string;
        encrypted_content: string;
      }>(
        `SELECT id,sequence::text AS sequence,space,session_id,created_at,encrypted_content
         FROM ap_memories
         WHERE sequence>$1::bigint AND created_at < now() - make_interval(secs=>$2)
           AND ($3::text[] IS NULL OR space=ANY($3)) AND ($4::text IS NULL OR space=$4)
         ORDER BY sequence LIMIT $5`,
        [
          memoryAfter,
          SETTLE_SECONDS,
          principal.spaces,
          input.space ?? null,
          input.limit,
        ],
      )
    ).rows;
    const changes: Change[] = [
      ...events.map((row): Change => {
        const message = decodeMessage(tx, row);
        return {
          kind: message.parent_id ? "reply" : "topic",
          change: row.event_type === "message.created" ? "created" : "updated",
          id: message.id,
          thread_id: message.thread_id,
          parent_id: message.parent_id,
          space: message.space,
          title: message.title,
          body: message.body,
          author: message.sender,
          tags: message.tags,
          pinned: message.pinned,
          archived_at: message.archived_at ? iso(message.archived_at) : null,
          at: iso(row.event_at),
        };
      }),
      ...memories.map((row): Change => {
        const content = tx.cipher!.decrypt<{
          body: string;
          author: MemoryAuthor;
        }>(`memory:${row.id}`, row.encrypted_content);
        return {
          kind: "memory",
          change: "created",
          id: row.id,
          sequence: row.sequence,
          space: row.space,
          session_id: row.session_id,
          body: content.body,
          author: content.author,
          at: iso(row.created_at),
        };
      }),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const eventCursor =
      events.length === input.limit ? events.at(-1)!.event_id : head;
    const memoryCursor = memories.length
      ? memories.at(-1)!.sequence
      : memoryAfter;
    return {
      changes,
      cursor: `e${eventCursor}.m${memoryCursor}`,
      has_more:
        events.length === input.limit || memories.length === input.limit,
    };
  });
}
