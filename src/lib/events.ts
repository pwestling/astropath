import { z } from "zod";
import { forPrincipal, type Database, type Queryable } from "./db";
import type { Message } from "./store";
import { AppError } from "./errors";
import { requireScope, requireSpace, type Principal } from "./policy";
import { spaceSlug } from "./validation";

export const eventId = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .pipe(
    z
      .string()
      .refine(
        (value) => BigInt(value) <= 9223372036854775807n,
        "Invalid event ID",
      ),
  );
const subscription = z
  .object({
    space: spaceSlug.optional(),
    recipient: z.string().trim().min(1).max(100).optional(),
    after: eventId.optional(),
  })
  .strict();
export type EventFilter = Pick<
  z.infer<typeof subscription>,
  "space" | "recipient"
>;
export type EventType =
  "message.created" | "message.updated" | "message.acknowledged";
export interface MessageEvent {
  id: string;
  type: EventType;
  space: string;
  recipient: string | null;
  message_id: string;
  actor_id: string;
  actor: string;
  data: Record<string, unknown>;
  created_at: string;
}

export function eventSubscription(request: Request) {
  const input = Object.fromEntries(new URL(request.url).searchParams);
  const lastId = request.headers.get("last-event-id");
  if (lastId !== null) input.after = lastId;
  return subscription.parse(input);
}

// Call at the end of the same transaction as the change. Never publish after commit.
export async function publishMessageEvent(
  tx: Queryable,
  type: EventType,
  principal: Principal,
  message: Message,
  data: Record<string, unknown>,
) {
  await tx.query("SELECT pg_advisory_xact_lock(1788124201, 1)");
  const result = await tx.query<{ id: string }>(
    `INSERT INTO ap_events(type,space,recipient,message_id,actor_id,actor,data)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id::text`,
    [
      type,
      message.space,
      message.recipient,
      message.id,
      principal.id,
      principal.name,
      JSON.stringify(
        tx.cipher
          ? { sealed: tx.cipher.encrypt(`event:${message.id}:${type}`, data) }
          : data,
      ),
    ],
  );
  return result.rows[0].id;
}

export class EventStore {
  constructor(private database: Database) {}

  async latest(principal?: Principal) {
    const database = principal
      ? await forPrincipal(this.database, principal)
      : this.database;
    // Read the non-transactional sequence only after taking the publication lock.
    // Without that lock an uncommitted event could be skipped; max(id) instead
    // regresses when events are deleted (e.g. isolated smoke-test cleanup).
    // The materialized CTE runs first, and the volatile sequence read runs while
    // this statement still holds its shared transaction lock. Identity CACHE=1.
    return (
      await database.query<{ id: string }>(
        `WITH locked AS MATERIALIZED (SELECT pg_advisory_xact_lock_shared(1788124201, 1))
         SELECT COALESCE(pg_sequence_last_value('ap_events_id_seq'::regclass),0)::text AS id FROM locked`,
      )
    ).rows[0].id;
  }

  async validate(principal: Principal, filter: EventFilter) {
    const database = await forPrincipal(this.database, principal);
    requireScope(principal, "astropath:read");
    if (filter.space) {
      requireSpace(principal, filter.space);
      if (
        !(
          await database.query("SELECT slug FROM ap_spaces WHERE slug=$1", [
            filter.space,
          ])
        ).rows.length
      )
        throw new AppError(404, "not_found", "Space not found.");
    }
  }

  async read(principal: Principal, filter: EventFilter, after: string) {
    const database = await forPrincipal(this.database, principal);
    requireScope(principal, "astropath:read");
    if (filter.space) requireSpace(principal, filter.space);
    const head = await this.latest(principal);
    const events = (
      await database.query<MessageEvent>(
        `SELECT id::text,type,space,recipient,message_id,actor_id,actor,data,created_at
       FROM ap_events WHERE id>$1::bigint AND id<=$2::bigint
       AND ($3::text[] IS NULL OR space=ANY($3))
       AND ($4::text IS NULL OR space=$4) AND ($5::text IS NULL OR recipient=$5)
       ORDER BY ap_events.id LIMIT 100`,
        [
          eventId.parse(after),
          head,
          principal.spaces,
          filter.space ?? null,
          filter.recipient ?? null,
        ],
      )
    ).rows;
    // Bound the scan to a committed high-water mark, including when no events match.
    return {
      events: events.map((event) => ({
        ...event,
        data: database.cipher
          ? database.cipher.decrypt<Record<string, unknown>>(
              `event:${event.message_id}:${event.type}`,
              String(event.data.sealed),
            )
          : event.data,
      })),
      cursor: events.length === 100 ? events[events.length - 1].id : head,
    };
  }
}
