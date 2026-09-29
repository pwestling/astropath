import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, forPrincipal, type Database, type Queryable } from "./db";
import { AppError } from "./errors";
import {
  requireAccount,
  requireScope,
  requireSpace,
  type Principal,
} from "./policy";
import { identityName, spaceSlug } from "./validation";

const topicName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const topicPathInput = z
  .object({
    space: spaceSlug.optional(),
    path: z.array(topicName).min(1).max(32),
  })
  .strict();
export const listTopicsInput = z
  .object({
    space: spaceSlug.optional(),
    parent_id: z.uuid().optional(),
    q: z.string().trim().max(200).optional(),
    include_archived: z.boolean().default(false),
    after: z.uuid().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export const registerSessionInput = z
  .object({
    space: spaceSlug.optional(),
    session_key: z.string().trim().min(1).max(200),
    name: identityName,
  })
  .strict();
export const topicNoteInput = z
  .object({
    topic_id: z.uuid(),
    session_id: z.uuid().optional(),
    kind: z
      .enum([
        "note",
        "progress",
        "milestone",
        "decision",
        "question",
        "handoff",
      ])
      .default("note"),
    body: z.string().trim().min(1).max(20000),
    idempotency_key: z.string().min(1).max(150),
  })
  .strict();
export const listTopicNotesInput = z
  .object({
    topic_id: z.uuid().optional(),
    space: spaceSlug.optional(),
    include_descendants: z.boolean().default(true),
    include_archived: z.boolean().default(false),
    q: z.string().trim().max(200).optional(),
    before: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine((value) => BigInt(value) <= 9223372036854775807n)
      .optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export const archiveTopicInput = z.object({ archived: z.boolean() }).strict();

interface TopicRow {
  id: string;
  space: string;
  parent_id: string | null;
  encrypted_name: string;
  created_at: string;
  archived_at: string | null;
  effective_archived: boolean;
  ancestor_ids: string[];
  path: { id: string; encrypted_name: string }[];
}
export interface Topic {
  id: string;
  space: string;
  parent_id: string | null;
  name: string;
  created_at: string;
  archived_at: string | null;
  effective_archived: boolean;
  path: { id: string; name: string }[];
}
export interface SessionAuthor {
  principal_id: string;
  name: string;
  session_id: string | null;
  session_name: string | null;
  session_key: string | null;
}
interface SessionRow {
  id: string;
  space: string;
  principal_id: string;
  encrypted_content: string;
  created_at: string;
}
interface NoteRow {
  id: string;
  sequence: string;
  topic_id: string;
  space: string;
  kind: z.infer<typeof topicNoteInput>["kind"];
  created_at: string;
  encrypted_content: string;
  content_hash: string;
}
export interface TopicNote {
  id: string;
  sequence: string;
  topic_id: string;
  space: string;
  kind: NoteRow["kind"];
  created_at: string;
  body: string;
  author: SessionAuthor;
}

// Fixed ancestry keeps paths and inherited archive state unambiguous. Each root
// starts in an authorized space; the composite FK keeps every child in it.
const tree = `WITH RECURSIVE topic_tree AS (
  SELECT t.*, ARRAY[t.id] AS ancestor_ids,
    jsonb_build_array(jsonb_build_object('id',t.id,'encrypted_name',t.encrypted_name)) AS path,
    t.archived_at IS NOT NULL AS effective_archived
  FROM ap_topics t WHERE t.parent_id IS NULL
  UNION ALL
  SELECT t.*, p.ancestor_ids || t.id,
    p.path || jsonb_build_array(jsonb_build_object('id',t.id,'encrypted_name',t.encrypted_name)),
    p.effective_archived OR t.archived_at IS NOT NULL
  FROM ap_topics t JOIN topic_tree p ON t.parent_id=p.id AND t.space=p.space AND t.tenant_id=p.tenant_id
)`;
function decodeTopic(database: Queryable, row: TopicRow): Topic {
  return {
    id: row.id,
    space: row.space,
    parent_id: row.parent_id,
    name: database.cipher!.decrypt<string>(
      `topic:${row.id}`,
      row.encrypted_name,
    ),
    created_at: row.created_at,
    archived_at: row.archived_at,
    effective_archived: row.effective_archived,
    path: row.path.map((item) => ({
      id: item.id,
      name: database.cipher!.decrypt<string>(
        `topic:${item.id}`,
        item.encrypted_name,
      ),
    })),
  };
}
function decodeNote(database: Queryable, row: NoteRow): TopicNote {
  return {
    id: row.id,
    sequence: String(row.sequence),
    topic_id: row.topic_id,
    space: row.space,
    kind: row.kind,
    created_at: row.created_at,
    ...database.cipher!.decrypt<{ body: string; author: SessionAuthor }>(
      `topic-note:${row.id}`,
      row.encrypted_content,
    ),
  };
}
function spaceFor(principal: Principal, space?: string) {
  const selected = space ?? principal.spaces?.[0] ?? "general";
  requireSpace(principal, selected);
  return selected;
}
async function lockSpace(tx: Queryable, space: string) {
  // Serialize archive/create/append so no write slips into a newly archived branch.
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `knowledge:${tx.tenantId}:${space}`,
  ]);
}
async function topicRow(database: Queryable, principal: Principal, id: string) {
  const row = (
    await database.query<TopicRow>(
      `${tree} SELECT * FROM topic_tree WHERE id=$1`,
      [z.uuid().parse(id)],
    )
  ).rows[0];
  if (!row) throw new AppError(404, "not_found", "Topic not found.");
  requireSpace(principal, row.space);
  return row;
}
function requireActive(row: TopicRow) {
  if (row.effective_archived)
    throw new AppError(
      409,
      "topic_archived",
      "This topic or an ancestor is archived. A human must restore it before new work is added.",
    );
}

export class KnowledgeStore {
  constructor(private database: Database) {}

  async ensureTopic(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:write");
    const input = topicPathInput.parse(raw);
    const space = spaceFor(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    return database.transaction(async (tx) => {
      await lockSpace(tx, space);
      if (
        !(await tx.query("SELECT slug FROM ap_spaces WHERE slug=$1", [space]))
          .rows.length
      )
        throw new AppError(404, "not_found", "Space not found.");
      let parent: string | null = null;
      let created = false;
      for (const rawName of input.path) {
        const name = rawName.normalize("NFC").replace(/\s+/g, " ");
        const nameHash = tx.cipher!.fingerprint(
          "topic-name",
          name.toLowerCase(),
        );
        const prior: { id: string; archived_at: string | null } | undefined = (
          await tx.query<{ id: string; archived_at: string | null }>(
            "SELECT id,archived_at FROM ap_topics WHERE space=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND name_hash=$3",
            [space, parent, nameHash],
          )
        ).rows[0];
        if (prior) {
          if (prior.archived_at)
            throw new AppError(
              409,
              "topic_archived",
              "This topic path is archived. A human must restore it.",
            );
          parent = prior.id;
          created = false;
        } else {
          const id = randomUUID();
          await tx.query(
            "INSERT INTO ap_topics(id,space,parent_id,name_hash,encrypted_name,created_by) VALUES($1,$2,$3,$4,$5,$6)",
            [
              id,
              space,
              parent,
              nameHash,
              tx.cipher!.encrypt(`topic:${id}`, name),
              principal.id,
            ],
          );
          parent = id;
          created = true;
        }
      }
      return {
        topic: decodeTopic(tx, await topicRow(tx, principal, parent!)),
        created,
      };
    });
  }

  async readTopic(principal: Principal, id: string) {
    requireScope(principal, "astropath:read");
    const database = await forPrincipal(this.database, principal);
    return {
      topic: decodeTopic(database, await topicRow(database, principal, id)),
    };
  }

  async listTopics(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:read");
    const input = listTopicsInput.parse(raw);
    if (input.space) requireSpace(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    if (input.parent_id) await topicRow(database, principal, input.parent_id);
    const matches: Topic[] = [];
    let after = input.after;
    const search = input.q?.toLowerCase();
    do {
      const page = (
        await database.query<TopicRow>(
          `${tree} SELECT * FROM topic_tree
        WHERE ($1::text[] IS NULL OR space=ANY($1)) AND ($2::text IS NULL OR space=$2)
        AND ($3::boolean OR NOT effective_archived)
        AND (CASE WHEN $4::uuid IS NOT NULL THEN parent_id=$4 WHEN $5::boolean THEN true ELSE parent_id IS NULL END)
        AND ($6::uuid IS NULL OR id>$6) ORDER BY id LIMIT 200`,
          [
            principal.spaces,
            input.space ?? null,
            input.include_archived,
            input.parent_id ?? null,
            !!search,
            after ?? null,
          ],
        )
      ).rows;
      for (const row of page) {
        const topic = decodeTopic(database, row);
        if (
          !search ||
          topic.path
            .map((part) => part.name)
            .join(" / ")
            .toLowerCase()
            .includes(search)
        )
          matches.push(topic);
        if (matches.length > input.limit) break;
      }
      if (matches.length > input.limit || page.length < 200) break;
      after = page.at(-1)!.id;
    } while (true);
    const topics = matches.slice(0, input.limit);
    return {
      topics,
      next_cursor: matches.length > input.limit ? topics.at(-1)!.id : null,
    };
  }

  async archiveTopic(principal: Principal, id: string, raw: unknown) {
    requireAccount(principal);
    requireScope(principal, "astropath:write");
    const input = archiveTopicInput.parse(raw);
    const database = await forPrincipal(this.database, principal);
    const initial = await topicRow(database, principal, id);
    return database.transaction(async (tx) => {
      await lockSpace(tx, initial.space);
      await tx.query(
        "UPDATE ap_topics SET archived_at=CASE WHEN $2 THEN COALESCE(archived_at,now()) ELSE NULL END,archived_by=CASE WHEN $2 THEN $3 ELSE NULL END WHERE id=$1",
        [id, input.archived, principal.id],
      );
      return { topic: decodeTopic(tx, await topicRow(tx, principal, id)) };
    });
  }

  async registerSession(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:write");
    const input = registerSessionInput.parse(raw);
    const space = spaceFor(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    return database.transaction(async (tx) => {
      await lockSpace(tx, space);
      if (
        !(await tx.query("SELECT slug FROM ap_spaces WHERE slug=$1", [space]))
          .rows.length
      )
        throw new AppError(404, "not_found", "Space not found.");
      const key = tx.cipher!.fingerprint("agent-session", input.session_key);
      let row = (
        await tx.query<SessionRow>(
          "SELECT * FROM ap_agent_sessions WHERE space=$1 AND principal_id=$2 AND session_key_hash=$3",
          [space, principal.id, key],
        )
      ).rows[0];
      const created = !row;
      if (!row) {
        const id = randomUUID();
        row = (
          await tx.query<SessionRow>(
            "INSERT INTO ap_agent_sessions(id,space,principal_id,session_key_hash,encrypted_content) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [
              id,
              space,
              principal.id,
              key,
              tx.cipher!.encrypt(`agent-session:${id}`, {
                name: input.name,
                session_key: input.session_key,
                author_name: principal.name,
              }),
            ],
          )
        ).rows[0];
      }
      return {
        session: {
          id: row.id,
          space: row.space,
          principal_id: row.principal_id,
          created_at: row.created_at,
          ...tx.cipher!.decrypt<{
            name: string;
            session_key: string;
            author_name: string;
          }>(`agent-session:${row.id}`, row.encrypted_content),
        },
        created,
      };
    });
  }

  async appendNote(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:write");
    const input = topicNoteInput.parse(raw);
    if (!input.session_id && !principal.userId)
      throw new AppError(
        400,
        "session_required",
        "Register your agent session and include its session_id with each note.",
      );
    const database = await forPrincipal(this.database, principal);
    const initial = await topicRow(database, principal, input.topic_id);
    return database.transaction(async (tx) => {
      await lockSpace(tx, initial.space);
      const topic = await topicRow(tx, principal, input.topic_id);
      const retryKey = tx.cipher!.fingerprint(
        "topic-note-retry",
        input.idempotency_key,
      );
      const contentHash = tx.cipher!.fingerprint(
        "topic-note-content",
        JSON.stringify([
          input.topic_id,
          input.session_id ?? null,
          input.kind,
          input.body,
        ]),
      );
      const prior = (
        await tx.query<NoteRow>(
          "SELECT * FROM ap_topic_notes WHERE space=$1 AND principal_id=$2 AND retry_key_hash=$3",
          [topic.space, principal.id, retryKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.content_hash !== contentHash)
          throw new AppError(
            409,
            "idempotency_conflict",
            "This retry key was already used for a different note.",
          );
        return { note: decodeNote(tx, prior), replayed: true };
      }
      requireActive(topic);
      const author: SessionAuthor = {
        principal_id: principal.id,
        name: principal.name,
        session_id: null,
        session_name: null,
        session_key: null,
      };
      if (input.session_id) {
        const session = (
          await tx.query<SessionRow>(
            "SELECT * FROM ap_agent_sessions WHERE id=$1 AND space=$2 AND principal_id=$3",
            [input.session_id, topic.space, principal.id],
          )
        ).rows[0];
        if (!session)
          throw new AppError(
            404,
            "not_found",
            "Session not found for this connection and space.",
          );
        const saved = tx.cipher!.decrypt<{
          name: string;
          session_key: string;
          author_name: string;
        }>(`agent-session:${session.id}`, session.encrypted_content);
        author.session_id = session.id;
        author.session_name = saved.name;
        author.session_key = saved.session_key;
        author.name = saved.author_name;
      }
      const id = randomUUID();
      const note = (
        await tx.query<NoteRow>(
          `INSERT INTO ap_topic_notes(id,space,topic_id,session_id,principal_id,kind,encrypted_content,retry_key_hash,content_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            id,
            topic.space,
            topic.id,
            input.session_id ?? null,
            principal.id,
            input.kind,
            tx.cipher!.encrypt(`topic-note:${id}`, {
              body: input.body,
              author,
            }),
            retryKey,
            contentHash,
          ],
        )
      ).rows[0];
      return { note: decodeNote(tx, note), replayed: false };
    });
  }

  async listNotes(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:read");
    const input = listTopicNotesInput.parse(raw);
    if (input.space) requireSpace(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    if (input.topic_id) await topicRow(database, principal, input.topic_id);
    const matches: (TopicNote & { topic: Topic })[] = [];
    let before = input.before;
    const search = input.q?.toLowerCase();
    do {
      const page = (
        await database.query<NoteRow & { topic: TopicRow }>(
          `${tree}
        SELECT n.*,n.sequence::text AS sequence,to_jsonb(t) AS topic
        FROM ap_topic_notes n JOIN topic_tree t ON n.topic_id=t.id
        WHERE ($1::text[] IS NULL OR n.space=ANY($1)) AND ($2::text IS NULL OR n.space=$2)
        AND ($3::boolean OR NOT t.effective_archived)
        AND ($4::uuid IS NULL OR n.topic_id=$4 OR ($5::boolean AND $4=ANY(t.ancestor_ids)))
        AND ($6::bigint IS NULL OR n.sequence<$6) ORDER BY n.sequence DESC LIMIT 200`,
          [
            principal.spaces,
            input.space ?? null,
            input.include_archived,
            input.topic_id ?? null,
            input.include_descendants,
            before ?? null,
          ],
        )
      ).rows;
      for (const row of page) {
        const note = decodeNote(database, row);
        if (!search || note.body.toLowerCase().includes(search))
          matches.push({ ...note, topic: decodeTopic(database, row.topic) });
        if (matches.length > input.limit) break;
      }
      if (matches.length > input.limit || page.length < 200) break;
      before = String(page.at(-1)!.sequence);
    } while (true);
    const notes = matches.slice(0, input.limit);
    return {
      notes,
      next_before: matches.length > input.limit ? notes.at(-1)!.sequence : null,
    };
  }
}
export const knowledge = new KnowledgeStore(db);
