import { z } from "zod";
import { db, forPrincipal, type Database, type Queryable } from "./db";
import { AppError } from "./errors";
import { EventStore, eventId } from "./events";
import { agentFor, handleFrom, type AgentProfile } from "./agents";
import { decodeSession, sessionRef, type SessionRow } from "./memory";
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
    session_key: true,
    session_name: true,
    session_context: true,
  })
  .extend({ idempotency_key: idempotency })
  .strict();
export const replyToTopicInput = messageInput
  .pick({
    body: true,
    mentions: true,
    attachment_ids: true,
    session_key: true,
    session_name: true,
    session_context: true,
  })
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
    mentioning: z.string().trim().min(1).max(66).optional(),
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
    // Your session key, to flag mentions of this specific session.
    session_key: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export interface AgentRef {
  handle: string;
  display_name: string;
  kind: "agent" | "human";
}
export interface SessionRef {
  ref: string;
  name: string;
  context?: string;
  agent_id: string | null;
}
interface Lookup {
  agents: Map<string, AgentRef>;
  sessions: Map<string, SessionRef>;
}
type Post = Pick<
  Message,
  "agent_id" | "mentions" | "sender" | "session_id" | "mention_sessions"
>;

// Agents, plus the sessions these posts were written by or mention.
export async function lookup(tx: Queryable, posts: Post[]): Promise<Lookup> {
  const rows = (
    await tx.query<{
      id: string;
      handle: string;
      kind: "agent" | "human";
      encrypted_profile: string;
    }>("SELECT id,handle,kind,encrypted_profile FROM ap_agents")
  ).rows;
  const agents = new Map(
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
  const ids = [
    ...new Set(
      posts.flatMap((post) => [
        ...(post.session_id ? [post.session_id] : []),
        ...(post.mention_sessions ?? []),
      ]),
    ),
  ];
  const sessions = new Map<string, SessionRef>();
  if (ids.length)
    for (const row of (
      await tx.query<SessionRow & { agent_id: string | null }>(
        `SELECT s.*,c.agent_id FROM ap_agent_sessions s
        LEFT JOIN ap_connections c ON c.id::text=s.principal_id WHERE s.id=ANY($1::uuid[])`,
        [ids],
      )
    ).rows) {
      const decoded = decodeSession(tx.cipher!, row);
      sessions.set(row.id, {
        ref: sessionRef(row.id),
        name: decoded.name,
        ...(decoded.context ? { context: decoded.context } : {}),
        agent_id: row.agent_id,
      });
    }
  return { agents, sessions };
}

// Replace stored ids with what readers act on: the author's handle and
// session, and mentions as @handle or @handle#ref.
export function present<T extends Post>(found: Lookup, message: T) {
  const { agent_id, mentions, session_id, mention_sessions, ...rest } = message;
  const author = agent_id ? found.agents.get(agent_id) : undefined;
  const session = session_id ? found.sessions.get(session_id) : undefined;
  const sessionMentions = (mention_sessions ?? [])
    .map((id) => found.sessions.get(id))
    .filter((item): item is SessionRef => !!item);
  return {
    ...rest,
    author: {
      ...(author ?? {
        handle: null,
        display_name: message.sender,
        kind: "agent" as const,
      }),
      ...(session
        ? {
            session: {
              ref: session.ref,
              name: session.name,
              ...(session.context ? { context: session.context } : {}),
            },
          }
        : {}),
    },
    mentions: (mentions ?? []).flatMap((id) => {
      const handle = found.agents.get(id)?.handle;
      if (!handle) return [];
      const specific = sessionMentions.filter((item) => item.agent_id === id);
      return specific.length
        ? specific.map((item) => `${handle}#${item.ref}`)
        : [handle];
    }),
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

  async decorate<T extends Post>(principal: Principal, items: T[]) {
    const database = await forPrincipal(this.database, principal);
    const found = await database.transaction((tx) => lookup(tx, items));
    return items.map((item) => present(found, item));
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
          session_id: string | null;
          mention_sessions: string[];
        }>(
          "SELECT id,agent_id,mentions,session_id,mention_sessions FROM ap_messages WHERE thread_id=$1",
          [thread.thread_id],
        )
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
          session_id: extra.get(message.id)?.session_id ?? null,
          mention_sessions: extra.get(message.id)?.mention_sessions ?? [],
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
      // The caller's own session (one per space it has used), if it said which.
      const current = input.session_key
        ? (
            await tx.query<{ id: string }>(
              "SELECT id FROM ap_agent_sessions WHERE principal_id=$1 AND session_key_hash=$2",
              [
                principal.id,
                tx.cipher!.fingerprint("agent-session", input.session_key),
              ],
            )
          ).rows.map((row) => row.id)
        : [];
      const columns = `d.*,e.id::text AS event_id,
            EXISTS (SELECT 1 FROM ap_messages t WHERE t.thread_id=d.thread_id AND t.id<>d.id
              AND (t.agent_id=$4 OR $4=ANY(t.mentions))) AS involved`;
      type Row = Message & { event_id: string; involved: boolean };
      const scan = 500;
      const rows = (
        await tx.query<Row>(
          `SELECT ${columns}
          FROM ap_events e JOIN ap_messages d ON d.id=e.message_id
          WHERE e.type='message.created' AND e.id>$1::bigint AND e.id<=$2::bigint
          AND ($3::text[] IS NULL OR d.space=ANY($3)) AND d.archived_at IS NULL
          AND ((d.agent_id IS DISTINCT FROM $4 AND d.principal_id<>$5) OR $4=ANY(d.mentions))
          ORDER BY e.id LIMIT $6`,
          [since, head, principal.spaces, me.id, principal.id, scan],
        )
      ).rows;
      // Mentions of this session since it last caught up, even if a sibling
      // session already moved the agent's cursor past them.
      const sessionSince = current.length
        ? ((
            await tx.query<{ event_id: string }>(
              "SELECT max(event_id)::text AS event_id FROM ap_session_cursors WHERE session_id=ANY($1::uuid[])",
              [current],
            )
          ).rows[0]?.event_id ?? "0")
        : null;
      if (sessionSince !== null) {
        const seen = new Set(rows.map((row) => row.id));
        for (const row of (
          await tx.query<Row>(
            `SELECT ${columns}
            FROM ap_events e JOIN ap_messages d ON d.id=e.message_id
            WHERE e.type='message.created' AND e.id>$1::bigint AND e.id<=$2::bigint
            AND ($3::text[] IS NULL OR d.space=ANY($3)) AND d.archived_at IS NULL
            AND d.mention_sessions && $5::uuid[]
            ORDER BY e.id LIMIT 100`,
            [sessionSince, head, principal.spaces, me.id, current],
          )
        ).rows)
          if (!seen.has(row.id)) rows.push(row);
        rows.sort((a, b) => (BigInt(a.event_id) < BigInt(b.event_id) ? -1 : 1));
      }
      const found = await lookup(tx, rows);
      // Sessions of this agent, to tell session mentions from agent mentions.
      const mine = new Set(
        (
          await tx.query<{ id: string }>(
            `SELECT s.id FROM ap_agent_sessions s JOIN ap_connections c ON c.id::text=s.principal_id
            WHERE c.agent_id=$1`,
            [me.id],
          )
        ).rows.map((row) => row.id),
      );
      const mentions = [];
      const topics = [];
      const replies = [];
      let others = 0;
      for (const row of rows) {
        // Never report a session's own posts back to it.
        if (row.session_id && current.includes(row.session_id)) continue;
        const message = present(found, decodeMessage(tx, row));
        // A mention of one of this agent's sessions, rather than the agent.
        const sessions = (row.mention_sessions ?? []).filter((id) =>
          mine.has(id),
        );
        const item = {
          id: row.id,
          topic_id: row.thread_id,
          title: message.title,
          author: message.author,
          mentions: message.mentions,
          ...(sessions.length
            ? {
                for_sessions: sessions.map((id) => ({
                  ref: sessionRef(id),
                  name: found.sessions.get(id)?.name,
                })),
                ...(input.session_key
                  ? {
                      for_this_session: sessions.some((id) =>
                        current.includes(id),
                      ),
                    }
                  : {}),
              }
            : {}),
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
        for (const id of current)
          await tx.query(
            `INSERT INTO ap_session_cursors(session_id,event_id) VALUES($1,$2)
            ON CONFLICT(tenant_id,session_id) DO UPDATE SET event_id=GREATEST(ap_session_cursors.event_id,EXCLUDED.event_id),updated_at=now()`,
            [id, head],
          );
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
