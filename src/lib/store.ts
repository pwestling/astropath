import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, forPrincipal, type Database, type Queryable } from "./db";
import { AppError } from "./errors";
import { hash, requireScope, requireSpace, type Principal } from "./policy";
import { messageInput, listInput } from "./validation";
import { publishMessageEvent } from "./events";
import {
  agentFor,
  handleFrom,
  mentionsIn,
  resolveHandles,
  resolveMentions,
} from "./agents";
import { ensureSession } from "./memory";

export interface Message {
  encrypted_content?: string | null;
  id: string;
  title: string;
  body: string;
  sender: string;
  space: string;
  principal_id: string;
  recipient: string | null;
  agent_id?: string | null;
  mentions?: string[];
  session_id?: string | null;
  mention_sessions?: string[];
  tags: string[];
  parent_id: string | null;
  thread_id: string;
  pinned: boolean;
  archived_at: string | null;
  created_at: string;
  unread?: boolean;
  attachment_count?: number;
  reply_count?: number;
}
export interface Attachment {
  encrypted_metadata?: string | null;
  encrypted?: boolean;
  id: string;
  name: string;
  content_type: string;
  size: string | number;
  space: string;
  pathname: string;
  principal_id: string;
  status: "pending" | "ready";
  message_id: string | null;
  created_at: string;
}

export const cursorSchema = z.object({
  created_at: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});
export function decodeCursor(cursor: string) {
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    throw new AppError(
      400,
      "invalid_cursor",
      "The pagination cursor is invalid.",
    );
  }
}
export function encodeCursor(message: Message) {
  return Buffer.from(
    JSON.stringify({
      created_at: message.created_at,
      id: message.id,
    }),
  ).toString("base64url");
}

export function decodeMessage<
  T extends { id: string; encrypted_content?: string | null },
>(database: Queryable, row: T): T {
  const { encrypted_content, ...metadata } = row;
  if (!database.cipher) return row;
  if (!encrypted_content)
    throw new Error("Unencrypted message requires migration");
  return {
    ...metadata,
    ...database.cipher.decrypt<object>(`message:${row.id}`, encrypted_content),
  } as T;
}

export function decodeFile<
  T extends { id: string; encrypted_metadata?: string | null },
>(database: Queryable, row: T): T {
  const { encrypted_metadata, ...metadata } = row;
  if (!database.cipher) return row;
  if (!encrypted_metadata)
    throw new Error("Unencrypted file metadata requires migration");
  return {
    ...metadata,
    ...database.cipher.decrypt<object>(
      `file-metadata:${row.id}`,
      encrypted_metadata,
    ),
  } as T;
}

export class MessageStore {
  constructor(private database: Database) {}

  async activity(
    actor: string,
    action: string,
    target: string | null,
    detail: string | null = null,
    tx: Queryable = this.database,
  ) {
    const result = await tx.query<{ id: string }>(
      "INSERT INTO ap_activity(actor,action,target_id,detail) VALUES($1,$2,$3,$4) RETURNING id::text",
      [actor, action, target, tx.cipher ? null : detail],
    );
    if (tx.cipher && detail !== null)
      await tx.query("UPDATE ap_activity SET encrypted_detail=$2 WHERE id=$1", [
        result.rows[0].id,
        tx.cipher.encrypt(`activity:${result.rows[0].id}`, detail),
      ]);
  }

  async get(
    principal: Principal,
    id: string,
    tx?: Queryable,
  ): Promise<Message> {
    tx ??= await forPrincipal(this.database, principal);
    requireScope(principal, "astropath:read");
    const result = await tx.query<Message>(
      "SELECT * FROM ap_messages WHERE id=$1",
      [z.uuid().parse(id)],
    );
    const message = result.rows[0];
    if (!message) throw new AppError(404, "not_found", "Message not found.");
    requireSpace(principal, message.space);
    return decodeMessage(tx, message);
  }

  async list(principal: Principal, raw: unknown) {
    const database = await forPrincipal(this.database, principal);
    requireScope(principal, "astropath:read");
    const input = listInput.parse(raw);
    if (input.space) requireSpace(principal, input.space);
    const args: unknown[] = [principal.id];
    const where = [
      input.archived ? "d.archived_at IS NOT NULL" : "d.archived_at IS NULL",
      "d.parent_id IS NULL",
    ];
    const arg = (value: unknown) => {
      args.push(value);
      return `$${args.length}`;
    };
    if (principal.spaces)
      where.push(`d.space = ANY(${arg(principal.spaces)}::text[])`);
    if (input.space) where.push(`d.space=${arg(input.space)}`);
    if (input.recipient) where.push(`d.recipient=${arg(input.recipient)}`);
    if ((input.mentioning || input.author) && database.tenantId) {
      const [mentioning, author] = await database.transaction(async (tx) => [
        input.mentioning === "me"
          ? (await agentFor(tx, principal)).id
          : input.mentioning
            ? (await resolveHandles(tx, [input.mentioning.split("#")[0]]))[0].id
            : null,
        input.author ? (await resolveHandles(tx, [input.author]))[0].id : null,
      ]);
      if (mentioning)
        where.push(
          `(${arg(mentioning)}::uuid=ANY(d.mentions) OR EXISTS (SELECT 1 FROM ap_messages m WHERE m.thread_id=d.id AND ${arg(mentioning)}::uuid=ANY(m.mentions)))`,
        );
      if (author) where.push(`d.agent_id=${arg(author)}::uuid`);
    }
    if (input.q && !database.cipher)
      where.push(
        `(to_tsvector('english',d.title || ' ' || d.body) @@ websearch_to_tsquery('english',${arg(input.q)}) OR d.title ILIKE ${arg(`%${input.q.replace(/[\\%_]/g, "\\$&")}%`)})`,
      );
    if (input.unread)
      where.push("r.message_id IS NULL AND d.principal_id <> $1");
    if (input.pinned) where.push("d.pinned=true");
    if (input.with_files)
      where.push("EXISTS (SELECT 1 FROM ap_files f WHERE f.message_id=d.id)");
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      where.push(
        `(d.created_at,d.id)<(${arg(cursor.created_at)}::timestamptz,${arg(cursor.id)}::uuid)`,
      );
    }
    const fetchPage = async (
      limit: number,
      before?: { created_at: string; id: string },
    ) => {
      const pageArgs = [...args];
      const pageWhere = [...where];
      if (before) {
        pageArgs.push(before.created_at, before.id);
        pageWhere.push(
          `(d.created_at,d.id)<($${pageArgs.length - 1}::timestamptz,$${pageArgs.length}::uuid)`,
        );
      }
      pageArgs.push(limit);
      return database.query<Message>(
        `SELECT d.*, to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       (r.message_id IS NULL AND d.principal_id<>$1) AS unread,
       (SELECT count(*)::integer FROM ap_files f WHERE f.message_id=d.id) AS attachment_count,
       (SELECT count(*)::integer FROM ap_messages reply WHERE reply.thread_id=d.id AND reply.parent_id IS NOT NULL) AS reply_count
       FROM ap_messages d LEFT JOIN ap_receipts r ON r.message_id=d.id AND r.principal_id=$1
       WHERE ${pageWhere.join(" AND ")} ORDER BY d.created_at DESC,d.id DESC LIMIT $${pageArgs.length}`,
        pageArgs,
      );
    };
    // Search authorized plaintext in memory, with no plaintext database index.
    const rows: Message[] = [];
    let before: { created_at: string; id: string } | undefined;
    const search =
      database.cipher && input.q ? input.q.toLocaleLowerCase() : undefined;
    do {
      const batchSize = search ? 200 : input.limit + 1;
      const page = await fetchPage(batchSize, before);
      for (const row of page.rows) {
        const decoded = decodeMessage(database, row);
        if (
          !search ||
          `${decoded.title} ${decoded.body}`
            .toLocaleLowerCase()
            .includes(search)
        )
          rows.push(decoded);
        if (rows.length > input.limit) break;
      }
      if (rows.length > input.limit || page.rows.length < batchSize) break;
      before = page.rows.at(-1);
    } while (search);
    const more = rows.length > input.limit;
    const messages = rows.slice(0, input.limit);
    return {
      messages,
      next_cursor: more ? encodeCursor(messages[messages.length - 1]) : null,
    };
  }

  async detail(principal: Principal, id: string) {
    const database = await forPrincipal(this.database, principal);
    const message = await this.get(principal, id);
    const [files, replies] = await Promise.all([
      database.query<Attachment>(
        "SELECT * FROM ap_files WHERE message_id=$1 ORDER BY created_at",
        [message.id],
      ),
      database.query<Message>(
        "SELECT * FROM ap_messages WHERE thread_id=$1 AND parent_id IS NOT NULL ORDER BY created_at,id",
        [message.thread_id],
      ),
    ]);
    return {
      message,
      attachments: files.rows.map((row) => decodeFile(database, row)),
      replies: replies.rows.map((row) => decodeMessage(database, row)),
    };
  }

  async create(principal: Principal, raw: unknown, idempotencyKey?: string) {
    const database = await forPrincipal(this.database, principal);
    requireScope(principal, "astropath:write");
    const input = messageInput.parse(raw);
    input.space ??= principal.spaces?.[0] || "general";
    requireSpace(principal, input.space);
    if (new Set(input.attachment_ids).size !== input.attachment_ids.length)
      throw new AppError(
        400,
        "duplicate_attachment",
        "Each attachment can appear only once.",
      );
    if (
      idempotencyKey &&
      (idempotencyKey.length > 150 || !/^[\x21-\x7e]+$/.test(idempotencyKey))
    )
      throw new AppError(
        400,
        "invalid_idempotency_key",
        "Use a printable key of at most 150 characters.",
      );
    const requestHash = hash(JSON.stringify(input));
    return database.transaction(async (tx) => {
      // Serialize identical retry keys across serverless instances before checking the result.
      if (idempotencyKey) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${principal.id}:${idempotencyKey}`,
        ]);
        const existing = await tx.query<Message & { request_hash: string }>(
          "SELECT * FROM ap_messages WHERE principal_id=$1 AND idempotency_key=$2",
          [principal.id, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash)
            throw new AppError(
              409,
              "idempotency_conflict",
              "This key was already used for a different message.",
            );
          const event = await tx.query<{ id: string }>(
            "SELECT id::text FROM ap_events WHERE message_id=$1 AND type='message.created' ORDER BY id LIMIT 1",
            [existing.rows[0].id],
          );
          return {
            message: decodeMessage(tx, existing.rows[0]),
            replayed: true,
            cursor: event.rows[0]?.id ?? null,
          };
        }
      }
      const spaces = await tx.query(
        "SELECT slug FROM ap_spaces WHERE slug=$1",
        [input.space],
      );
      if (!spaces.rows.length)
        throw new AppError(404, "not_found", "Space not found.");
      let threadId: string = randomUUID();
      const id = threadId;
      if (input.parent_id) {
        const parent = await tx.query<Message>(
          "SELECT * FROM ap_messages WHERE id=$1",
          [input.parent_id],
        );
        if (!parent.rows[0] || parent.rows[0].space !== input.space)
          throw new AppError(
            404,
            "not_found",
            "Parent message not found in this space.",
          );
        threadId = parent.rows[0].thread_id;
      }
      if (input.attachment_ids.length) {
        const files = await tx.query<Attachment>(
          "SELECT * FROM ap_files WHERE id=ANY($1::uuid[]) AND principal_id=$2 AND space=$3 AND status='ready' AND message_id IS NULL FOR UPDATE",
          [input.attachment_ids, principal.id, input.space],
        );
        if (files.rows.length !== input.attachment_ids.length)
          throw new AppError(
            409,
            "attachment_unavailable",
            "Attachments must be uploaded by this connection, ready, unused, and in this space.",
          );
      }
      const board = tx.tenantId
        ? await authorAndMentions(tx, principal, {
            ...input,
            space: input.space!,
          })
        : null;
      const result = await tx.query<Message>(
        `INSERT INTO ap_messages(id,space,title,body,sender,principal_id,recipient,tags,parent_id,thread_id,idempotency_key,request_hash${tx.cipher ? ",encrypted_content" : ""})
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12${tx.cipher ? ",$13" : ""}) RETURNING *`,
        [
          id,
          input.space,
          tx.cipher ? "" : input.title,
          tx.cipher ? "" : input.body,
          principal.name,
          principal.id,
          input.recipient || null,
          tx.cipher ? [] : input.tags,
          input.parent_id || null,
          threadId,
          idempotencyKey || null,
          requestHash,
          ...(tx.cipher
            ? [
                tx.cipher.encrypt(`message:${id}`, {
                  title: input.title,
                  body: input.body,
                  tags: input.tags,
                }),
              ]
            : []),
        ],
      );
      if (board) {
        await tx.query(
          "UPDATE ap_messages SET agent_id=$2,mentions=$3::uuid[],session_id=$4,mention_sessions=$5::uuid[] WHERE id=$1",
          [
            id,
            board.agentId,
            board.mentions,
            board.sessionId,
            board.mentionSessions,
          ],
        );
        Object.assign(result.rows[0], {
          agent_id: board.agentId,
          mentions: board.mentions,
          session_id: board.sessionId,
          mention_sessions: board.mentionSessions,
        });
      }
      await tx.query(
        "UPDATE ap_files SET message_id=$1 WHERE id=ANY($2::uuid[])",
        [id, input.attachment_ids],
      );
      await this.activity(
        principal.name,
        input.parent_id ? "replied" : "created",
        id,
        input.title,
        tx,
      );
      const cursor = await publishMessageEvent(
        tx,
        "message.created",
        principal,
        result.rows[0],
        {
          title: input.title,
          parent_id: input.parent_id || null,
          thread_id: threadId,
          attachment_ids: input.attachment_ids,
        },
      );
      return {
        message: decodeMessage(tx, result.rows[0]),
        replayed: false,
        cursor,
      };
    });
  }

  async acknowledge(principal: Principal, id: string) {
    const database = await forPrincipal(this.database, principal);
    await database.transaction(async (tx) => {
      const message = await this.get(principal, id, tx);
      const result = await tx.query(
        "INSERT INTO ap_receipts(message_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING message_id",
        [id, principal.id],
      );
      if (result.rows.length)
        await publishMessageEvent(
          tx,
          "message.acknowledged",
          principal,
          message,
          {},
        );
    });
    return { acknowledged: true, id };
  }

  async update(principal: Principal, id: string, raw: unknown) {
    const database = await forPrincipal(this.database, principal);
    if (!principal.owner && !principal.userId)
      throw new AppError(
        403,
        "owner_required",
        "Sign in to organize messages in your spaces.",
      );
    const change = z
      .object({
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    return database.transaction(async (tx) => {
      await this.get(principal, id, tx);
      const result = await tx.query<Message>(
        `UPDATE ap_messages SET pinned=COALESCE($2,pinned),
       archived_at=CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN now() ELSE NULL END
       WHERE id=$1 RETURNING *`,
        [id, change.pinned ?? null, change.archived ?? null],
      );
      await this.activity(principal.name, "organized", id, null, tx);
      await publishMessageEvent(
        tx,
        "message.updated",
        principal,
        result.rows[0],
        {
          pinned: result.rows[0].pinned,
          archived_at: result.rows[0].archived_at,
        },
      );
      return { message: decodeMessage(tx, result.rows[0]) };
    });
  }

  async file(principal: Principal, id: string) {
    const database = await forPrincipal(this.database, principal);
    requireScope(principal, "astropath:read");
    const result = await database.query<Attachment>(
      "SELECT * FROM ap_files WHERE id=$1",
      [z.uuid().parse(id)],
    );
    const file = result.rows[0];
    if (
      !file ||
      (!file.message_id &&
        file.principal_id !== principal.id &&
        !principal.owner)
    )
      throw new AppError(404, "not_found", "File not found.");
    requireSpace(principal, file.space);
    if (file.message_id) await this.get(principal, file.message_id);
    return decodeFile(database, file);
  }
}
// Explicit mentions must name real agents and sessions. @mentions written in
// the body, and a legacy recipient that matches a handle, are picked up
// leniently. A session mention also mentions its agent.
async function authorAndMentions(
  tx: Queryable,
  principal: Principal,
  input: {
    body: string;
    space: string;
    mentions: string[];
    recipient?: string | null;
    session_key?: string;
    session_name?: string;
    session_context?: string;
  },
) {
  const author = await agentFor(tx, principal);
  const session = input.session_key
    ? await ensureSession(tx, principal, input.space, {
        session_key: input.session_key,
        name: input.session_name,
        context: input.session_context,
      })
    : null;
  const strict = await resolveMentions(tx, input.mentions, true);
  const loose = await resolveMentions(
    tx,
    [
      ...mentionsIn(input.body),
      ...(input.recipient ? [handleFrom(input.recipient)] : []),
    ],
    false,
  );
  const agents = new Set([...strict.agents, ...loose.agents]);
  // Mentioning yourself is noise, but one session may flag a sibling session
  // of the same agent (e.g. the session working in another project).
  const sessions = new Set([...strict.sessions, ...loose.sessions]);
  if (session) sessions.delete(session.id);
  const siblings = sessions.size
    ? (
        await tx.query<{ id: string }>(
          `SELECT s.id FROM ap_agent_sessions s JOIN ap_connections c ON c.id::text=s.principal_id
          WHERE s.id=ANY($1::uuid[]) AND c.agent_id=$2`,
          [[...sessions], author.id],
        )
      ).rows
    : [];
  if (!siblings.length) agents.delete(author.id);
  return {
    agentId: author.id,
    sessionId: session?.id ?? null,
    mentions: [...agents],
    mentionSessions: [...sessions],
  };
}

export const store = new MessageStore(db);
