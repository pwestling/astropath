import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Database, type Queryable } from "./db";
import { AppError } from "./errors";
import { hash, requireScope, requireSpace, type Principal } from "./policy";
import { messageInput, listInput } from "./validation";
import { publishMessageEvent } from "./events";

export interface Message {
  id: string;
  title: string;
  body: string;
  sender: string;
  space: string;
  principal_id: string;
  recipient: string | null;
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

export class MessageStore {
  constructor(private database: Database) {}

  async activity(
    actor: string,
    action: string,
    target: string | null,
    detail: string | null = null,
    tx: Queryable = this.database,
  ) {
    await tx.query(
      "INSERT INTO ap_activity(actor,action,target_id,detail) VALUES($1,$2,$3,$4)",
      [actor, action, target, detail],
    );
  }

  async get(
    principal: Principal,
    id: string,
    tx: Queryable = this.database,
  ): Promise<Message> {
    requireScope(principal, "astropath:read");
    const result = await tx.query<Message>("SELECT * FROM ap_messages WHERE id=$1", [
      z.uuid().parse(id),
    ]);
    const message = result.rows[0];
    if (!message) throw new AppError(404, "not_found", "Message not found.");
    requireSpace(principal, message.space);
    return message;
  }

  async list(principal: Principal, raw: unknown) {
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
    if (input.q)
      where.push(
        `(to_tsvector('english',d.title || ' ' || d.body) @@ websearch_to_tsquery('english',${arg(input.q)}) OR d.title ILIKE ${arg(`%${input.q.replace(/[\\%_]/g, "\\$&")}%`)})`,
      );
    if (input.unread) where.push("r.message_id IS NULL AND d.principal_id <> $1");
    if (input.pinned) where.push("d.pinned=true");
    if (input.with_files)
      where.push("EXISTS (SELECT 1 FROM ap_files f WHERE f.message_id=d.id)");
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      where.push(
        `(d.created_at,d.id)<(${arg(cursor.created_at)}::timestamptz,${arg(cursor.id)}::uuid)`,
      );
    }
    const result = await this.database.query<Message>(
      `SELECT d.*, to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       (r.message_id IS NULL AND d.principal_id<>$1) AS unread,
       (SELECT count(*)::integer FROM ap_files f WHERE f.message_id=d.id) AS attachment_count,
       (SELECT count(*)::integer FROM ap_messages reply WHERE reply.thread_id=d.id AND reply.parent_id IS NOT NULL) AS reply_count
       FROM ap_messages d LEFT JOIN ap_receipts r ON r.message_id=d.id AND r.principal_id=$1
       WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC,d.id DESC LIMIT ${arg(input.limit + 1)}`,
      args,
    );
    const more = result.rows.length > input.limit;
    const messages = result.rows.slice(0, input.limit);
    return {
      messages,
      next_cursor: more ? encodeCursor(messages[messages.length - 1]) : null,
    };
  }

  async detail(principal: Principal, id: string) {
    const message = await this.get(principal, id);
    const [files, replies] = await Promise.all([
      this.database.query<Attachment>(
        "SELECT id,name,content_type,size,message_id,status FROM ap_files WHERE message_id=$1 ORDER BY created_at",
        [message.id],
      ),
      this.database.query<Message>(
        "SELECT * FROM ap_messages WHERE thread_id=$1 AND parent_id IS NOT NULL ORDER BY created_at,id",
        [message.thread_id],
      ),
    ]);
    return { message, attachments: files.rows, replies: replies.rows };
  }

  async create(principal: Principal, raw: unknown, idempotencyKey?: string) {
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
    return this.database.transaction(async (tx) => {
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
            message: existing.rows[0],
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
      const result = await tx.query<Message>(
        `INSERT INTO ap_messages(id,space,title,body,sender,principal_id,recipient,tags,parent_id,thread_id,idempotency_key,request_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          id,
          input.space,
          input.title,
          input.body,
          principal.name,
          principal.id,
          input.recipient || null,
          input.tags,
          input.parent_id || null,
          threadId,
          idempotencyKey || null,
          requestHash,
        ],
      );
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
      return { message: result.rows[0], replayed: false, cursor };
    });
  }

  async acknowledge(principal: Principal, id: string) {
    await this.database.transaction(async (tx) => {
      const message = await this.get(principal, id, tx);
      const result = await tx.query(
        "INSERT INTO ap_receipts(message_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING message_id",
        [id, principal.id],
      );
      if (result.rows.length)
        await publishMessageEvent(tx, "message.acknowledged", principal, message, {});
    });
    return { acknowledged: true, id };
  }

  async update(principal: Principal, id: string, raw: unknown) {
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
    return this.database.transaction(async (tx) => {
      await this.get(principal, id, tx);
      const result = await tx.query<Message>(
        `UPDATE ap_messages SET pinned=COALESCE($2,pinned),
       archived_at=CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN now() ELSE NULL END
       WHERE id=$1 RETURNING *`,
        [id, change.pinned ?? null, change.archived ?? null],
      );
      await this.activity(principal.name, "organized", id, null, tx);
      await publishMessageEvent(tx, "message.updated", principal, result.rows[0], {
        pinned: result.rows[0].pinned,
        archived_at: result.rows[0].archived_at,
      });
      return { message: result.rows[0] };
    });
  }

  async file(principal: Principal, id: string) {
    requireScope(principal, "astropath:read");
    const result = await this.database.query<Attachment>(
      "SELECT * FROM ap_files WHERE id=$1",
      [z.uuid().parse(id)],
    );
    const file = result.rows[0];
    if (
      !file ||
      (!file.message_id && file.principal_id !== principal.id && !principal.owner)
    )
      throw new AppError(404, "not_found", "File not found.");
    requireSpace(principal, file.space);
    if (file.message_id) await this.get(principal, file.message_id);
    return file;
  }
}
export const store = new MessageStore(db);
