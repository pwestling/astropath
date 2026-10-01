import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, forPrincipal, type Database, type Queryable } from "./db";
import type { ContentCipher } from "./encryption";
import { AppError } from "./errors";
import { requireScope, requireSpace, type Principal } from "./policy";
import { identityName, spaceSlug } from "./validation";

const sessionKey = z.string().trim().min(1).max(200);
const sequenceCursor = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const legacyKinds = [
  "note",
  "progress",
  "milestone",
  "decision",
  "question",
  "handoff",
] as const;

export const rememberInput = z
  .object({
    space: spaceSlug.optional(),
    session_key: sessionKey.optional(),
    session_name: identityName.optional(),
    session_context: z.string().trim().min(1).max(500).optional(),
    body: z.string().trim().min(1).max(20000),
    idempotency_key: z.string().min(1).max(150),
  })
  .strict();
export const recallInput = z
  .object({
    space: spaceSlug.optional(),
    q: z.string().trim().max(200).optional(),
    session_key: sessionKey.optional(),
    session_id: z.uuid().optional(),
    principal_id: z.string().min(1).max(200).optional(),
    // Entries written by a human account without an agent session.
    no_session: z.boolean().default(false),
    before: sequenceCursor.optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export const listSessionsInput = z
  .object({
    space: spaceSlug.optional(),
    principal_id: z.string().min(1).max(200).optional(),
    before: sequenceCursor.optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
// The retired topic workflow's atomic call. The path and kind are kept on the
// entry as a hint; nothing is filed under a topic any more.
export const recordWorkNoteInput = z
  .object({
    space: spaceSlug.optional(),
    path: z.array(z.string().trim().min(1).max(100)).min(1).max(32),
    session_key: sessionKey,
    session_name: identityName,
    kind: z.enum(legacyKinds).default("note"),
    body: z.string().trim().min(1).max(20000),
    idempotency_key: z.string().min(1).max(150),
  })
  .strict();

export interface MemoryAuthor {
  principal_id: string;
  name: string;
  session_id: string | null;
  session_name: string | null;
  session_key: string | null;
  session_context?: string;
}
export interface LegacyHint {
  path: string[];
  kind: (typeof legacyKinds)[number];
}
export interface Memory {
  id: string;
  sequence: string;
  space: string;
  created_at: string;
  body: string;
  author: MemoryAuthor;
  legacy?: LegacyHint;
}
export interface AgentSession {
  id: string;
  space: string;
  principal_id: string;
  created_at: string;
  name: string;
  session_key: string;
  author_name: string;
  context?: string;
}
export interface MemorySession {
  space: string;
  session_id: string | null;
  principal_id: string;
  author_name: string;
  session_name: string | null;
  context: string | null;
  count: number;
  first_at: string;
  last_at: string;
  last_sequence: string;
  latest: string;
}
interface MemoryRow {
  id: string;
  sequence: string;
  space: string;
  created_at: string;
  encrypted_content: string;
  content_hash: string;
}
export interface SessionRow {
  id: string;
  space: string;
  principal_id: string;
  encrypted_content: string;
  created_at: string;
}
type SessionContent = Omit<
  AgentSession,
  "id" | "space" | "principal_id" | "created_at"
>;

function decodeMemory(cipher: ContentCipher, row: MemoryRow): Memory {
  return {
    id: row.id,
    sequence: String(row.sequence),
    space: row.space,
    created_at: row.created_at,
    ...cipher.decrypt<{
      body: string;
      author: MemoryAuthor;
      legacy?: LegacyHint;
    }>(`memory:${row.id}`, row.encrypted_content),
  };
}
export function decodeSession(
  cipher: ContentCipher,
  row: SessionRow,
): AgentSession {
  return {
    id: row.id,
    space: row.space,
    principal_id: row.principal_id,
    created_at: row.created_at,
    ...cipher.decrypt<SessionContent>(
      `agent-session:${row.id}`,
      row.encrypted_content,
    ),
  };
}
function spaceFor(principal: Principal, space?: string) {
  const selected = space ?? principal.spaces?.[0] ?? "general";
  requireSpace(principal, selected);
  return selected;
}

// The short, typeable reference used in session mentions: @handle#ref.
export function sessionRef(id: string) {
  return id.replace(/-/g, "").slice(0, 8);
}

// Sessions are registered on first use and never change afterwards; a later
// call with a different name or context returns the original identity. The
// memory log and the board share these records.
export async function ensureSession(
  tx: Queryable,
  principal: Principal,
  space: string,
  input: { session_key: string; name?: string; context?: string },
) {
  const keyHash = tx.cipher!.fingerprint("agent-session", input.session_key);
  const find = async () =>
    (
      await tx.query<SessionRow>(
        "SELECT * FROM ap_agent_sessions WHERE space=$1 AND principal_id=$2 AND session_key_hash=$3",
        [space, principal.id, keyHash],
      )
    ).rows[0];
  const existing = await find();
  if (existing) return decodeSession(tx.cipher!, existing);
  const id = randomUUID();
  const content: SessionContent = {
    name: input.name ?? "Unnamed session",
    session_key: input.session_key,
    author_name: principal.name,
    ...(input.context ? { context: input.context } : {}),
  };
  await tx.query(
    `INSERT INTO ap_agent_sessions(id,space,principal_id,session_key_hash,encrypted_content)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [
      id,
      space,
      principal.id,
      keyHash,
      tx.cipher!.encrypt(`agent-session:${id}`, content),
    ],
  );
  return decodeSession(tx.cipher!, (await find())!);
}

export class MemoryStore {
  constructor(private database: Database) {}

  async remember(principal: Principal, raw: unknown, legacy?: LegacyHint) {
    requireScope(principal, "astropath:write");
    const input = rememberInput.parse(raw);
    if (!input.session_key && !principal.userId)
      throw new AppError(
        400,
        "session_required",
        "Include a stable session_key for this conversation with each memory.",
      );
    const space = spaceFor(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    return database.transaction(async (tx) => {
      if (
        !(await tx.query("SELECT slug FROM ap_spaces WHERE slug=$1", [space]))
          .rows.length
      )
        throw new AppError(404, "not_found", "Space not found.");
      const session = input.session_key
        ? await ensureSession(tx, principal, space, {
            session_key: input.session_key,
            name: input.session_name,
            context: input.session_context,
          })
        : null;
      const retryKey = tx.cipher!.fingerprint(
        "memory-retry",
        input.idempotency_key,
      );
      const contentHash = tx.cipher!.fingerprint(
        "memory-content",
        JSON.stringify([session?.id ?? null, input.body, legacy ?? null]),
      );
      const prior = (
        await tx.query<MemoryRow>(
          "SELECT *,sequence::text AS sequence FROM ap_memories WHERE space=$1 AND principal_id=$2 AND retry_key_hash=$3",
          [space, principal.id, retryKey],
        )
      ).rows[0];
      if (prior) {
        if (prior.content_hash !== contentHash)
          throw new AppError(
            409,
            "idempotency_conflict",
            "This retry key was already used for a different memory.",
          );
        return {
          memory: decodeMemory(tx.cipher!, prior),
          session,
          replayed: true,
        };
      }
      const author: MemoryAuthor = {
        principal_id: principal.id,
        name: session?.author_name ?? principal.name,
        session_id: session?.id ?? null,
        session_name: session?.name ?? null,
        session_key: session?.session_key ?? null,
        ...(session?.context ? { session_context: session.context } : {}),
      };
      const id = randomUUID();
      const row = (
        await tx.query<MemoryRow>(
          `INSERT INTO ap_memories(id,space,session_id,principal_id,encrypted_content,retry_key_hash,content_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *,sequence::text AS sequence`,
          [
            id,
            space,
            session?.id ?? null,
            principal.id,
            tx.cipher!.encrypt(`memory:${id}`, {
              body: input.body,
              author,
              ...(legacy ? { legacy } : {}),
            }),
            retryKey,
            contentHash,
          ],
        )
      ).rows[0];
      return {
        memory: decodeMemory(tx.cipher!, row),
        session,
        replayed: false,
      };
    });
  }

  async recordWorkNote(principal: Principal, raw: unknown) {
    const input = recordWorkNoteInput.parse(raw);
    return this.remember(
      principal,
      {
        space: input.space,
        session_key: input.session_key,
        session_name: input.session_name,
        body: input.body,
        idempotency_key: input.idempotency_key,
      },
      { path: input.path, kind: input.kind },
    );
  }

  async recall(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:read");
    const input = recallInput.parse(raw);
    if (input.space) requireSpace(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    const sessionHash = input.session_key
      ? database.cipher!.fingerprint("agent-session", input.session_key)
      : null;
    const search = input.q?.toLowerCase();
    const matches: Memory[] = [];
    let before = input.before;
    do {
      // Keyword search decrypts authorized batches in memory; there is no
      // plaintext index. A session_key only matches this connection's sessions.
      const page = (
        await database.query<MemoryRow>(
          `SELECT m.*,m.sequence::text AS sequence FROM ap_memories m
          LEFT JOIN ap_agent_sessions s ON s.id=m.session_id
          WHERE ($1::text[] IS NULL OR m.space=ANY($1)) AND ($2::text IS NULL OR m.space=$2)
          AND ($3::text IS NULL OR (s.session_key_hash=$3 AND s.principal_id=$4))
          AND ($5::uuid IS NULL OR m.session_id=$5)
          AND ($6::text IS NULL OR m.principal_id=$6)
          AND ($7::bigint IS NULL OR m.sequence<$7)
          AND (NOT $8::boolean OR m.session_id IS NULL)
          ORDER BY m.sequence DESC LIMIT 200`,
          [
            principal.spaces,
            input.space ?? null,
            sessionHash,
            principal.id,
            input.session_id ?? null,
            input.principal_id ?? null,
            before ?? null,
            input.no_session,
          ],
        )
      ).rows;
      for (const row of page) {
        const memory = decodeMemory(database.cipher!, row);
        if (!search || memory.body.toLowerCase().includes(search))
          matches.push(memory);
        if (matches.length > input.limit) break;
      }
      if (matches.length > input.limit || page.length < 200) break;
      before = String(page.at(-1)!.sequence);
    } while (true);
    const memories = matches.slice(0, input.limit);
    return {
      memories,
      next_before:
        matches.length > input.limit ? memories.at(-1)!.sequence : null,
    };
  }

  async sessions(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:read");
    const input = listSessionsInput.parse(raw);
    if (input.space) requireSpace(principal, input.space);
    const database = await forPrincipal(this.database, principal);
    const rows = (
      await database.query<{
        space: string;
        session_id: string | null;
        principal_id: string;
        count: number;
        first_at: string;
        last_at: string;
        last_sequence: string;
        session: SessionRow | null;
        latest: MemoryRow;
      }>(
        `SELECT m.space,m.session_id,m.principal_id,count(*)::int AS count,
          min(m.created_at) AS first_at,max(m.created_at) AS last_at,max(m.sequence)::text AS last_sequence,
          (array_agg(to_jsonb(s)))[1] AS session,
          (array_agg(jsonb_build_object('id',m.id,'sequence',m.sequence::text,'space',m.space,
            'created_at',m.created_at,'encrypted_content',m.encrypted_content) ORDER BY m.sequence DESC))[1] AS latest
        FROM ap_memories m LEFT JOIN ap_agent_sessions s ON s.id=m.session_id
        WHERE ($1::text[] IS NULL OR m.space=ANY($1)) AND ($2::text IS NULL OR m.space=$2)
        AND ($3::text IS NULL OR m.principal_id=$3)
        GROUP BY m.space,m.session_id,m.principal_id
        HAVING ($4::bigint IS NULL OR max(m.sequence)<$4)
        ORDER BY max(m.sequence) DESC LIMIT $5`,
        [
          principal.spaces,
          input.space ?? null,
          input.principal_id ?? null,
          input.before ?? null,
          input.limit + 1,
        ],
      )
    ).rows;
    const sessions: MemorySession[] = rows.slice(0, input.limit).map((row) => {
      const latest = decodeMemory(database.cipher!, row.latest);
      const session = row.session
        ? decodeSession(database.cipher!, row.session)
        : null;
      return {
        space: row.space,
        session_id: row.session_id,
        principal_id: row.principal_id,
        author_name: session?.author_name ?? latest.author.name,
        session_name: session?.name ?? null,
        context: session?.context ?? null,
        count: row.count,
        first_at: row.first_at,
        last_at: row.last_at,
        last_sequence: String(row.last_sequence),
        latest: latest.body.slice(0, 280),
      };
    });
    return {
      sessions,
      next_before:
        rows.length > input.limit ? sessions.at(-1)!.last_sequence : null,
    };
  }
}
export const memory = new MemoryStore(db);

// One-time, repeatable copy of the retired topic notes into the log. Each note
// keeps its author, session, timestamp and retry fingerprint; its topic path
// and kind become a hint for whatever later organizes the log.
export async function migrateTopicNotes(
  tx: Queryable,
  tenantId: string,
  cipher: ContentCipher,
) {
  const topics = new Map(
    (
      await tx.query<{
        id: string;
        parent_id: string | null;
        encrypted_name: string;
      }>(
        "SELECT id,parent_id,encrypted_name FROM ap_topics WHERE tenant_id=$1",
        [tenantId],
      )
    ).rows.map((row) => [row.id, row]),
  );
  const pathOf = (id: string) => {
    const names: string[] = [];
    for (let at = topics.get(id); at; at = topics.get(at.parent_id ?? ""))
      names.unshift(
        cipher.decrypt<string>(`topic:${at.id}`, at.encrypted_name),
      );
    return names;
  };
  const notes = (
    await tx.query<{
      id: string;
      space: string;
      topic_id: string;
      session_id: string | null;
      principal_id: string;
      kind: LegacyHint["kind"];
      encrypted_content: string;
      retry_key_hash: string;
      content_hash: string;
      created_at: string;
    }>(
      `SELECT n.* FROM ap_topic_notes n WHERE n.tenant_id=$1
      AND NOT EXISTS (SELECT 1 FROM ap_memories m WHERE m.legacy_note_id=n.id)
      ORDER BY n.sequence`,
      [tenantId],
    )
  ).rows;
  for (const note of notes) {
    const saved = cipher.decrypt<{ body: string; author: MemoryAuthor }>(
      `topic-note:${note.id}`,
      note.encrypted_content,
    );
    const id = randomUUID();
    await tx.query(
      `INSERT INTO ap_memories(id,tenant_id,space,session_id,principal_id,encrypted_content,retry_key_hash,content_hash,legacy_note_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        tenantId,
        note.space,
        note.session_id,
        note.principal_id,
        cipher.encrypt(`memory:${id}`, {
          body: saved.body,
          author: saved.author,
          legacy: { path: pathOf(note.topic_id), kind: note.kind },
        }),
        note.retry_key_hash,
        note.content_hash,
        note.id,
        note.created_at,
      ],
    );
  }
  return notes.length;
}
