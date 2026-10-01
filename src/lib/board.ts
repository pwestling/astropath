import { z } from "zod";
import { db, forPrincipal, type Database, type Queryable } from "./db";
import { AppError } from "./errors";
import { EventStore, eventId } from "./events";
import { agentFor, handleFrom, type AgentProfile } from "./agents";
import { requireScope, type Principal } from "./policy";
import { ChatStore } from "./chat";
import { MessageStore, decodeMessage, type Message } from "./store";
import { messageInput, spaceSlug } from "./validation";

const idempotency = z.string().min(1).max(150).optional();
export const postTopicInput = messageInput
  .pick({
    title: true,
    body: true,
    space: true,
    mentions: true,
    attachment_ids: true,
    tags: true,
  })
  .extend({ idempotency_key: idempotency })
  .strict();
export const replyToTopicInput = messageInput
  .pick({ body: true, mentions: true, attachment_ids: true })
  .extend({ topic_id: z.uuid(), idempotency_key: idempotency })
  .strict();
export const readTopicInput = z
  .object({
    topic_id: z.uuid(),
    limit: z.number().int().min(1).max(50).default(20),
    page: z.string().max(1000).optional(),
  })
  .strict();
export const listTopicsInput = z
  .object({
    space: spaceSlug.optional(),
    q: z.string().max(200).optional(),
    mentioning: z.string().trim().min(1).max(33).optional(),
    author: z.string().trim().min(1).max(33).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    cursor: z.string().max(500).optional(),
  })
  .strict();
export const catchUpInput = z
  .object({
    since: eventId.optional(),
    peek: z.boolean().default(false),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

export interface AgentRef {
  handle: string;
  display_name: string;
  kind: "agent" | "human";
}
type Directory = Map<string, AgentRef>;

export async function directory(tx: Queryable): Promise<Directory> {
  const rows = (
    await tx.query<{
      id: string;
      handle: string;
      kind: "agent" | "human";
      encrypted_profile: string;
    }>("SELECT id,handle,kind,encrypted_profile FROM ap_agents")
  ).rows;
  return new Map(
    rows.map((row) => [
      row.id,
      {
        handle: row.handle,
        kind: row.kind,
        display_name: tx.cipher!.decrypt<AgentProfile>(
          `agent:${row.id}`,
          row.encrypted_profile,
        ).display_name,
      },
    ]),
  );
}

// Replace stored agent ids with handles readers can act on.
export function present<
  T extends Pick<Message, "agent_id" | "mentions" | "sender">,
>(agents: Directory, message: T) {
  const { agent_id, mentions, ...rest } = message;
  const author = agent_id ? agents.get(agent_id) : undefined;
  return {
    ...rest,
    author: author ?? {
      handle: null,
      display_name: message.sender,
      kind: "agent" as const,
    },
    mentions: (mentions ?? [])
      .map((id) => agents.get(id)?.handle)
      .filter((handle): handle is string => !!handle),
  };
}

const excerpt = (text: string, size = 400) =>
  text.length > size ? `${text.slice(0, size)}…` : text;

export class BoardStore {
  private messages: MessageStore;
  private chat: ChatStore;
  private events: EventStore;
  constructor(private database: Database) {
    this.messages = new MessageStore(database);
    this.chat = new ChatStore(database);
    this.events = new EventStore(database);
  }

  private async decorate<
    T extends Pick<Message, "agent_id" | "mentions" | "sender">,
  >(principal: Principal, items: T[]) {
    const database = await forPrincipal(this.database, principal);
    const agents = await database.transaction((tx) => directory(tx));
    return items.map((item) => present(agents, item));
  }

  async postTopic(principal: Principal, raw: unknown) {
    const { idempotency_key, ...input } = postTopicInput.parse(raw);
    const result = await this.messages.create(
      principal,
      input,
      idempotency_key,
    );
    const [topic] = await this.decorate(principal, [result.message]);
    return { topic, replayed: result.replayed, cursor: result.cursor };
  }

  async reply(principal: Principal, raw: unknown) {
    const { topic_id, idempotency_key, ...input } =
      replyToTopicInput.parse(raw);
    const parent = await this.messages.get(principal, topic_id);
    const result = await this.messages.create(
      principal,
      {
        ...input,
        title: parent.title,
        space: parent.space,
        parent_id: parent.id,
      },
      idempotency_key,
    );
    const [message] = await this.decorate(principal, [result.message]);
    return { ...result, message };
  }

  async readTopic(principal: Principal, raw: unknown) {
    const input = readTopicInput.parse(raw);
    const thread = await this.chat.thread(principal, {
      message_id: input.topic_id,
      limit: input.limit,
      page: input.page,
    });
    const database = await forPrincipal(this.database, principal);
    const extra = new Map(
      (
        await database.query<{
          id: string;
          agent_id: string | null;
          mentions: string[];
        }>("SELECT id,agent_id,mentions FROM ap_messages WHERE thread_id=$1", [
          thread.thread_id,
        ])
      ).rows.map((row) => [row.id, row]),
    );
    return {
      ...thread,
      messages: await this.decorate(
        principal,
        thread.messages.map((message) => ({
          ...message,
          agent_id: extra.get(message.id)?.agent_id ?? null,
          mentions: extra.get(message.id)?.mentions ?? [],
        })),
      ),
    };
  }

  async listTopics(principal: Principal, raw: unknown) {
    const input = listTopicsInput.parse(raw);
    const page = await this.messages.list(principal, input);
    return {
      topics: await this.decorate(principal, page.messages),
      next_cursor: page.next_cursor,
    };
  }

  // What is new for this agent since it last caught up: posts that mention it,
  // new topics, and replies in topics it has written in or been mentioned in.
  // The cursor is shared by all of the agent's sessions.
  async catchUp(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:read");
    const input = catchUpInput.parse(raw);
    const database = await forPrincipal(this.database, principal);
    const head = await this.events.latest(principal);
    return database.transaction(async (tx) => {
      const me = await agentFor(tx, principal);
      const saved = (
        await tx.query<{ event_id: string }>(
          "SELECT event_id::text FROM ap_agent_cursors WHERE agent_id=$1",
          [me.id],
        )
      ).rows[0]?.event_id;
      // A first catch-up looks back a week rather than at all history.
      const since =
        input.since ??
        saved ??
        (
          await tx.query<{ id: string }>(
            `SELECT COALESCE(min(id)-1,$1::bigint)::text AS id FROM ap_events
            WHERE created_at>now()-interval '7 days'`,
            [head],
          )
        ).rows[0].id;
      if (BigInt(since) > BigInt(head))
        throw new AppError(
          400,
          "invalid_cursor",
          "The cursor is ahead of this workspace's event log.",
        );
      const scan = 500;
      const rows = (
        await tx.query<
          Message & { event_id: string; involved: boolean; root_title: string }
        >(
          `SELECT d.*,e.id::text AS event_id,
            EXISTS (SELECT 1 FROM ap_messages t WHERE t.thread_id=d.thread_id AND t.id<>d.id
              AND (t.agent_id=$4 OR $4=ANY(t.mentions))) AS involved
          FROM ap_events e JOIN ap_messages d ON d.id=e.message_id
          WHERE e.type='message.created' AND e.id>$1::bigint AND e.id<=$2::bigint
          AND ($3::text[] IS NULL OR d.space=ANY($3)) AND d.archived_at IS NULL
          AND d.agent_id IS DISTINCT FROM $4 AND d.principal_id<>$5
          ORDER BY e.id LIMIT $6`,
          [since, head, principal.spaces, me.id, principal.id, scan],
        )
      ).rows;
      const agents = await directory(tx);
      const mentions = [];
      const topics = [];
      const replies = [];
      let others = 0;
      for (const row of rows) {
        const message = present(agents, decodeMessage(tx, row));
        const item = {
          id: row.id,
          topic_id: row.thread_id,
          title: message.title,
          author: message.author,
          mentions: message.mentions,
          space: row.space,
          created_at: row.created_at,
          excerpt: excerpt(message.body),
        };
        if (row.mentions?.includes(me.id)) mentions.push(item);
        else if (!row.parent_id) topics.push(item);
        else if (row.involved) replies.push(item);
        else others++;
      }
      // Stop at the last scanned event when there was more than one batch.
      const reached = rows.length === scan ? rows.at(-1)!.event_id : head;
      if (!input.peek && !input.since)
        await tx.query(
          `INSERT INTO ap_agent_cursors(agent_id,event_id) VALUES($1,$2)
          ON CONFLICT(tenant_id,agent_id) DO UPDATE SET event_id=GREATEST(ap_agent_cursors.event_id,EXCLUDED.event_id),updated_at=now()`,
          [me.id, reached],
        );
      const cap = <T>(list: T[]) => list.slice(-input.limit);
      return {
        agent: { handle: me.handle },
        since,
        cursor: reached,
        has_more: reached !== head,
        mentions: cap(mentions),
        new_topics: cap(topics),
        replies: cap(replies),
        omitted: {
          mentions: Math.max(0, mentions.length - input.limit),
          new_topics: Math.max(0, topics.length - input.limit),
          replies: Math.max(0, replies.length - input.limit),
          other_replies: others,
        },
      };
    });
  }
}

// Repeatable backfill: attribute existing posts to their author's agent, and
// turn a legacy recipient that names an agent into a mention.
export async function migrateBoard(tx: Queryable, tenantId: string) {
  await tx.query("SELECT set_config('astropath.tenant_id',$1,true)", [
    tenantId,
  ]);
  await tx.query("SET LOCAL ROLE astropath_tenant");
  try {
    await tx.query(
      `UPDATE ap_messages m SET agent_id=c.agent_id FROM ap_connections c
      WHERE m.agent_id IS NULL AND c.id::text=m.principal_id AND c.agent_id IS NOT NULL`,
    );
    await tx.query(
      `UPDATE ap_messages m SET agent_id=a.id FROM ap_agents a
      WHERE m.agent_id IS NULL AND a.user_id IS NOT NULL
      AND m.principal_id IN ('owner:'||a.user_id,'member:'||a.user_id)`,
    );
    const legacy = (
      await tx.query<{
        id: string;
        recipient: string;
        agent_id: string | null;
      }>(
        "SELECT id,recipient,agent_id FROM ap_messages WHERE recipient IS NOT NULL AND mentions='{}'",
      )
    ).rows;
    for (const row of legacy) {
      const target = (
        await tx.query<{ id: string }>(
          "SELECT id FROM ap_agents WHERE handle=$1",
          [handleFrom(row.recipient)],
        )
      ).rows[0];
      if (target && target.id !== row.agent_id)
        await tx.query(
          "UPDATE ap_messages SET mentions=ARRAY[$2::uuid] WHERE id=$1",
          [row.id, target.id],
        );
    }
  } finally {
    await tx.query("RESET ROLE");
  }
}

export const board = new BoardStore(db);
