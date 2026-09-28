import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { db, forPrincipal, type Database } from "./db";
import { AppError } from "./errors";
import { EventStore, eventId } from "./events";
import { requireScope, type Principal } from "./policy";
import { MessageStore, decodeMessage, decodeFile, type Message } from "./store";
import { messageInput, spaceSlug } from "./validation";

const waitOptions = {
  after: eventId.optional(),
  timeout_seconds: z.number().int().min(0).max(50).default(30),
  limit: z.number().int().min(1).max(50).default(20),
  include_self: z.boolean().default(false),
};
export const waitMessagesInput = z
  .object({
    ...waitOptions,
    space: spaceSlug.optional(),
    recipient: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const waitReplyInput = z
  .object({ ...waitOptions, message_id: z.uuid() })
  .strict();
export const replyInput = messageInput
  .pick({ body: true, attachment_ids: true, recipient: true })
  .extend({
    message_id: z.uuid(),
    idempotency_key: z.string().min(1).max(150).optional(),
  })
  .strict();
export const threadInput = z
  .object({
    message_id: z.uuid(),
    limit: z.number().int().min(1).max(50).default(20),
    page: z.string().max(1000).optional(),
  })
  .strict();
const threadPage = z
  .object({
    thread_id: z.uuid(),
    head: eventId,
    event_id: eventId.nullable(),
    created_at: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

type ChatMessage = Pick<
  Message,
  | "id"
  | "thread_id"
  | "parent_id"
  | "space"
  | "sender"
  | "principal_id"
  | "recipient"
  | "title"
  | "body"
  | "created_at"
> & {
  encrypted_content?: string;
  body_truncated: boolean;
  attachments: {
    id: string;
    name: string;
    content_type: string;
    size: string;
  }[];
  event_id: string | null;
};
// Bound tool results even when messages have large bodies. Full content remains in read_message.
const messageColumns = `d.id,d.thread_id,d.parent_id,d.space,d.sender,d.principal_id,d.recipient,d.title,
  d.body,d.encrypted_content,false AS body_truncated,
  to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  e.id::text AS event_id,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'encrypted_metadata',f.encrypted_metadata,'name',f.name,'content_type',f.content_type,'size',f.size::text) ORDER BY f.created_at,f.id)
    FROM ap_files f WHERE f.message_id=d.id),'[]'::jsonb) AS attachments`;

export interface ChatContext {
  authenticate: () => Promise<Principal>;
  signal: AbortSignal;
  pollMs?: number;
}

export class ChatStore {
  private messages: MessageStore;
  private events: EventStore;
  constructor(private database: Database) {
    this.messages = new MessageStore(database);
    this.events = new EventStore(database);
  }

  async reply(principal: Principal, raw: unknown) {
    const input = replyInput.parse(raw);
    const parent = await this.messages.get(principal, input.message_id);
    // No caller-supplied space or sender: replies always stay in the parent's space.
    return this.messages.create(
      principal,
      {
        title: parent.title,
        body: input.body,
        attachment_ids: input.attachment_ids,
        space: parent.space,
        parent_id: parent.id,
        recipient:
          input.recipient === undefined ? parent.sender : input.recipient,
      },
      input.idempotency_key,
    );
  }

  async thread(principal: Principal, raw: unknown) {
    const database = await forPrincipal(this.database, principal);
    const input = threadInput.parse(raw);
    const anchor = await this.messages.get(principal, input.message_id);
    const latest = await this.events.latest(principal);
    let page: z.infer<typeof threadPage> | undefined;
    if (input.page) {
      try {
        page = threadPage.parse(
          JSON.parse(Buffer.from(input.page, "base64url").toString("utf8")),
        );
      } catch {
        throw new AppError(400, "invalid_cursor", "Invalid conversation page.");
      }
      if (
        page.thread_id !== anchor.thread_id ||
        BigInt(page.head) > BigInt(latest)
      )
        throw new AppError(
          400,
          "invalid_cursor",
          "This page belongs to another conversation or event log.",
        );
    }
    const head = page?.head ?? latest;
    const rows = (
      await database.query<ChatMessage>(
        `SELECT ${messageColumns} FROM ap_messages d
       LEFT JOIN ap_events e ON e.message_id=d.id AND e.type='message.created'
       WHERE d.thread_id=$1 AND d.space=$2 AND (e.id IS NULL OR e.id<=$3::bigint)
       AND ($4::timestamptz IS NULL
         OR ($6::bigint IS NULL AND (e.id IS NOT NULL OR (d.created_at,d.id)>($4::timestamptz,$5::uuid)))
         OR e.id>$6::bigint)
       ORDER BY e.id NULLS FIRST,d.created_at,d.id LIMIT $7`,
        [
          anchor.thread_id,
          anchor.space,
          head,
          page?.created_at ?? null,
          page?.id ?? null,
          page?.event_id ?? null,
          input.limit + 1,
        ],
      )
    ).rows;
    const messages = rows.slice(0, input.limit).map((row) => {
      const decoded = decodeMessage(database, row);
      return {
        ...decoded,
        body: decoded.body.slice(0, 8000),
        body_truncated: decoded.body.length > 8000,
        attachments: decoded.attachments.map((file) =>
          decodeFile(database, file),
        ),
      };
    });
    const last = messages.at(-1);
    return {
      thread_id: anchor.thread_id,
      space: anchor.space,
      messages,
      cursor: head,
      next_page:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                thread_id: anchor.thread_id,
                head,
                event_id: last.event_id,
                created_at: last.created_at,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }

  waitMessages(principal: Principal, raw: unknown, context: ChatContext) {
    return this.wait(principal, waitMessagesInput.parse(raw), context);
  }

  waitReply(principal: Principal, raw: unknown, context: ChatContext) {
    return this.wait(principal, waitReplyInput.parse(raw), context);
  }

  private async wait(
    principal: Principal,
    input: z.infer<typeof waitMessagesInput> | z.infer<typeof waitReplyInput>,
    context: ChatContext,
  ) {
    const database = await forPrincipal(this.database, principal);
    const deadline = Date.now() + input.timeout_seconds * 1000;
    context.signal.throwIfAborted();
    requireScope(principal, "astropath:read");
    const anchor =
      "message_id" in input
        ? await this.messages.get(principal, input.message_id)
        : undefined;
    const filter =
      "message_id" in input
        ? { space: anchor!.space }
        : { space: input.space, recipient: input.recipient };
    await this.events.validate(principal, filter);
    const head = await this.events.latest(principal);
    if (input.after && BigInt(input.after) > BigInt(head))
      throw new AppError(
        400,
        "invalid_cursor",
        "The event cursor is ahead of this instance's event log.",
      );
    let cursor = input.after ?? head;
    if (anchor) {
      const event = (
        await database.query<{ id: string }>(
          "SELECT id::text FROM ap_events WHERE message_id=$1 AND type='message.created' ORDER BY id LIMIT 1",
          [anchor.id],
        )
      ).rows[0];
      const start = event?.id ?? "0";
      cursor =
        input.after && BigInt(input.after) > BigInt(start)
          ? input.after
          : start;
    }
    while (true) {
      context.signal.throwIfAborted();
      // Current credentials and space access are checked even when the inbox is quiet.
      const current = await context.authenticate();
      context.signal.throwIfAborted();
      if (
        current.id !== principal.id ||
        current.tenantId !== principal.tenantId
      )
        throw new AppError(
          403,
          "identity_changed",
          "Connection identity changed.",
        );
      await this.events.validate(current, filter);
      const highWater = await this.events.latest(principal);
      const rows = (
        await database.query<ChatMessage>(
          `SELECT ${messageColumns} FROM ap_events e JOIN ap_messages d ON d.id=e.message_id
         WHERE e.type='message.created' AND e.id>$1::bigint AND e.id<=$2::bigint
         AND ($3::text[] IS NULL OR d.space=ANY($3))
         AND ($4::text IS NULL OR d.space=$4) AND ($5::text IS NULL OR d.recipient=$5)
         AND ($6::uuid IS NULL OR d.thread_id=$6)
         AND ($7::boolean OR d.principal_id<>$8)
         ORDER BY e.id LIMIT $9`,
          [
            cursor,
            highWater,
            current.spaces,
            filter.space ?? null,
            "recipient" in filter ? (filter.recipient ?? null) : null,
            anchor?.thread_id ?? null,
            input.include_self,
            current.id,
            input.limit + 1,
          ],
        )
      ).rows;
      context.signal.throwIfAborted();
      const messages = rows.slice(0, input.limit).map((row) => {
        const decoded = decodeMessage(database, row);
        return {
          ...decoded,
          body: decoded.body.slice(0, 8000),
          body_truncated: decoded.body.length > 8000,
          attachments: decoded.attachments.map((file) =>
            decodeFile(database, file),
          ),
        };
      });
      const more = rows.length > input.limit;
      cursor = more ? messages[messages.length - 1].event_id! : highWater;
      if (messages.length || Date.now() >= deadline)
        return {
          status: messages.length ? "messages" : "timeout",
          messages,
          cursor,
          has_more: more,
          ...(anchor ? { thread_id: anchor.thread_id } : {}),
        };
      await delay(
        Math.min(context.pollMs ?? 2000, Math.max(0, deadline - Date.now())),
        undefined,
        { signal: context.signal },
      );
    }
  }
}

export const chat = new ChatStore(db);
