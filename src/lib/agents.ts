import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, forPrincipal, type Database, type Queryable } from "./db";
import type { ContentCipher } from "./encryption";
import { AppError } from "./errors";
import { requireAccount, requireScope, type Principal } from "./policy";
import { decodeSession, sessionRef, type SessionRow } from "./memory";

export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,31}$/,
    "Use 1-32 lowercase letters, digits or hyphens.",
  );
const profileText = (max: number) => z.string().trim().max(max);
export const setProfileInput = z
  .object({
    display_name: profileText(80).min(1).optional(),
    harness: profileText(80).optional(),
    description: profileText(1000).optional(),
  })
  .strict();
export const updateAgentInput = setProfileInput
  .extend({ handle: handleSchema.optional() })
  .strict();
export const listAgentsInput = z
  .object({ include_inactive: z.boolean().default(false) })
  .strict();

export interface AgentProfile {
  display_name: string;
  harness?: string;
  description?: string;
}
export interface SessionSummary {
  ref: string;
  name: string;
  context?: string;
  last_active_at: string;
}
export interface Agent extends AgentProfile {
  id: string;
  handle: string;
  kind: "agent" | "human";
  active: boolean;
  last_active_at: string | null;
  created_at: string;
  // Mention one of these as @handle#ref.
  recent_sessions: SessionSummary[];
}
interface AgentRow {
  id: string;
  handle: string;
  kind: "agent" | "human";
  encrypted_profile: string;
  created_at: string;
}

function decodeProfile(cipher: ContentCipher, row: AgentRow) {
  return cipher.decrypt<AgentProfile>(`agent:${row.id}`, row.encrypted_profile);
}
// "Claude Code (Work)" -> "claude-code-work". Mentions use these handles.
export function handleFrom(name: string) {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/, "");
  return slug || "agent";
}
async function freeHandle(tx: Queryable, base: string) {
  for (let n = 1; ; n++) {
    const handle = n === 1 ? base : `${base}-${n}`;
    if (
      !(await tx.query("SELECT 1 FROM ap_agents WHERE handle=$1", [handle]))
        .rows.length
    )
      return handle;
  }
}
async function createAgent(
  tx: Queryable,
  kind: "agent" | "human",
  profile: AgentProfile,
  userId: string | null = null,
) {
  const id = randomUUID();
  const handle = await freeHandle(tx, handleFrom(profile.display_name));
  await tx.query(
    "INSERT INTO ap_agents(id,handle,kind,user_id,encrypted_profile) VALUES($1,$2,$3,$4,$5)",
    [id, handle, kind, userId, tx.cipher!.encrypt(`agent:${id}`, profile)],
  );
  return id;
}

// Attach a connection to its agent. A reconnect under the same name rejoins
// the agent it had before, so its handle and history carry over; an explicit
// agentId attaches it to a chosen existing agent instead.
export async function attachConnection(
  tx: Queryable,
  connection: { id: string; name: string },
  agentId?: string,
) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `agents:${tx.tenantId}`,
  ]);
  if (agentId) {
    if (
      !(
        await tx.query("SELECT 1 FROM ap_agents WHERE id=$1 AND kind='agent'", [
          agentId,
        ])
      ).rows.length
    )
      throw new AppError(404, "not_found", "Agent not found.");
  } else {
    const handle = handleFrom(connection.name);
    const vacant = (
      await tx.query<{ id: string }>(
        `SELECT a.id FROM ap_agents a WHERE a.handle=$1 AND a.kind='agent'
        AND NOT EXISTS (SELECT 1 FROM ap_connections c WHERE c.agent_id=a.id AND c.id<>$2
          AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>now()))`,
        [handle, connection.id],
      )
    ).rows[0];
    agentId =
      vacant?.id ??
      (await createAgent(tx, "agent", { display_name: connection.name }));
  }
  await tx.query("UPDATE ap_connections SET agent_id=$2 WHERE id=$1", [
    connection.id,
    agentId,
  ]);
  return agentId;
}

async function humanAgent(tx: Queryable, userId: string, name: string) {
  const existing = (
    await tx.query<{ id: string }>(
      "SELECT id FROM ap_agents WHERE user_id=$1",
      [userId],
    )
  ).rows[0];
  if (existing) return existing.id;
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `agents:${tx.tenantId}`,
  ]);
  return (
    (
      await tx.query<{ id: string }>(
        "SELECT id FROM ap_agents WHERE user_id=$1",
        [userId],
      )
    ).rows[0]?.id ?? createAgent(tx, "human", { display_name: name }, userId)
  );
}

// The agent behind a principal, created on first use for older connections.
export async function agentFor(tx: Queryable, principal: Principal) {
  let id: string;
  if (principal.userId)
    id = await humanAgent(tx, principal.userId, principal.name);
  else {
    const connection = (
      await tx.query<{ id: string; name: string; agent_id: string | null }>(
        "SELECT id,name,agent_id FROM ap_connections WHERE id=$1",
        [principal.id],
      )
    ).rows[0];
    if (!connection)
      throw new AppError(403, "connection_revoked", "Connection not found.");
    id = connection.agent_id ?? (await attachConnection(tx, connection));
  }
  const row = (
    await tx.query<AgentRow>("SELECT * FROM ap_agents WHERE id=$1", [id])
  ).rows[0];
  return {
    id: row.id,
    handle: row.handle,
    kind: row.kind,
    ...decodeProfile(tx.cipher!, row),
  };
}

// Resolve @handles to agent ids, rejecting unknown handles so a typo is not
// silently ignored.
export async function resolveHandles(tx: Queryable, handles: string[]) {
  const wanted = [
    ...new Set(handles.map((h) => h.replace(/^@/, "").toLowerCase())),
  ];
  if (!wanted.length) return [];
  const rows = (
    await tx.query<{ id: string; handle: string }>(
      "SELECT id,handle FROM ap_agents WHERE handle=ANY($1::text[])",
      [wanted],
    )
  ).rows;
  const missing = wanted.filter((h) => !rows.some((row) => row.handle === h));
  if (missing.length)
    throw new AppError(
      400,
      "unknown_handle",
      `No agent has the handle ${missing.map((h) => `@${h}`).join(", ")}. Use list_agents to find handles.`,
    );
  return rows;
}

// "@handle" mentions an agent; "@handle#ref" one of its sessions, where ref
// is the start of the session id (see sessionRef). In body text, unknown
// handles are ignored; in an explicit mentions list they are an error.
export const mentionPattern =
  /(?:^|[^\w@.])@([a-z0-9][a-z0-9-]{0,31})(?:#([0-9a-f]{6,32}))?(?![\w-])/gi;
export function mentionsIn(text: string) {
  return [...text.matchAll(mentionPattern)].map((match) =>
    match[2] ? `${match[1]}#${match[2]}` : match[1],
  );
}
export async function resolveMentions(
  tx: Queryable,
  tokens: string[],
  strict: boolean,
) {
  const agentIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const raw of tokens) {
    const [handle, ref] = raw.replace(/^@/, "").toLowerCase().split("#");
    const agent = (
      await tx.query<{ id: string }>(
        "SELECT id FROM ap_agents WHERE handle=$1",
        [handle],
      )
    ).rows[0];
    if (!agent) {
      if (strict)
        throw new AppError(
          400,
          "unknown_handle",
          `No agent has the handle @${handle}. Use list_agents to find handles.`,
        );
      continue;
    }
    agentIds.add(agent.id);
    if (ref === undefined) continue;
    const sessions = /^[0-9a-f]{6,32}$/.test(ref)
      ? (
          await tx.query<{ id: string }>(
            `SELECT s.id FROM ap_agent_sessions s JOIN ap_connections c ON c.id::text=s.principal_id
            WHERE c.agent_id=$1 AND replace(s.id::text,'-','') LIKE $2`,
            [agent.id, `${ref}%`],
          )
        ).rows
      : [];
    if (sessions.length === 1) sessionIds.add(sessions[0].id);
    else if (strict)
      throw new AppError(
        400,
        sessions.length ? "ambiguous_session" : "unknown_session",
        sessions.length
          ? `@${handle}#${ref} matches several sessions; use a longer reference.`
          : `@${handle} has no session #${ref}. list_agents shows recent sessions.`,
      );
  }
  return { agents: [...agentIds], sessions: [...sessionIds] };
}

// Recent sessions per agent, most recently active first.
async function recentSessions(
  tx: Queryable,
  spaces: string[] | null,
  perAgent = 5,
) {
  const rows = (
    await tx.query<SessionRow & { agent_id: string; last_active_at: string }>(
      `SELECT s.*,c.agent_id,GREATEST(s.created_at,
          (SELECT max(m.created_at) FROM ap_memories m WHERE m.session_id=s.id),
          (SELECT max(p.created_at) FROM ap_messages p WHERE p.session_id=s.id)) AS last_active_at
        FROM ap_agent_sessions s JOIN ap_connections c ON c.id::text=s.principal_id
        WHERE c.agent_id IS NOT NULL AND ($1::text[] IS NULL OR s.space=ANY($1))
        ORDER BY last_active_at DESC`,
      [spaces],
    )
  ).rows;
  const byAgent = new Map<string, SessionSummary[]>();
  for (const row of rows) {
    const list = byAgent.get(row.agent_id) ?? [];
    if (list.length >= perAgent) continue;
    const session = decodeSession(tx.cipher!, row);
    list.push({
      ref: sessionRef(row.id),
      name: session.name,
      ...(session.context ? { context: session.context } : {}),
      last_active_at: row.last_active_at,
    });
    byAgent.set(row.agent_id, list);
  }
  return byAgent;
}

export class AgentStore {
  constructor(private database: Database) {}

  async list(principal: Principal, raw: unknown = {}) {
    requireScope(principal, "astropath:read");
    const input = listAgentsInput.parse(raw);
    const database = await forPrincipal(this.database, principal);
    const [rows, sessions] = await database.transaction(async (tx) => {
      await ensureMemberAgents(tx);
      const rows = (
        await tx.query<
          AgentRow & { active: boolean; last_active_at: string | null }
        >(
          `SELECT a.*,
          (a.kind='human' AND EXISTS (SELECT 1 FROM ap_members m WHERE m.user_id=a.user_id AND m.disabled_at IS NULL))
          OR EXISTS (SELECT 1 FROM ap_connections c WHERE c.agent_id=a.id AND c.revoked_at IS NULL
            AND (c.expires_at IS NULL OR c.expires_at>now())) AS active,
          (SELECT max(c.last_used_at) FROM ap_connections c WHERE c.agent_id=a.id) AS last_active_at
        FROM ap_agents a ORDER BY a.kind, a.handle`,
        )
      ).rows;
      return [rows, await recentSessions(tx, principal.spaces)] as const;
    });
    const agents: Agent[] = rows
      .filter((row) => input.include_inactive || row.active)
      .map((row) => ({
        id: row.id,
        handle: row.handle,
        kind: row.kind,
        active: row.active,
        last_active_at: row.last_active_at,
        created_at: row.created_at,
        ...decodeProfile(database.cipher!, row),
        recent_sessions: sessions.get(row.id) ?? [],
      }));
    return { agents };
  }

  async me(principal: Principal) {
    requireScope(principal, "astropath:read");
    const database = await forPrincipal(this.database, principal);
    return {
      agent: await database.transaction((tx) => agentFor(tx, principal)),
    };
  }

  // An agent keeps its own directory entry current.
  async setProfile(principal: Principal, raw: unknown) {
    requireScope(principal, "astropath:write");
    const input = setProfileInput.parse(raw);
    const database = await forPrincipal(this.database, principal);
    return database.transaction(async (tx) => {
      const agent = await agentFor(tx, principal);
      return { agent: await writeProfile(tx, agent.id, input) };
    });
  }

  // Signed-in humans curate the directory, including renaming handles.
  async update(principal: Principal, id: string, raw: unknown) {
    requireAccount(principal);
    requireScope(principal, "astropath:write");
    const input = updateAgentInput.parse(raw);
    const database = await forPrincipal(this.database, principal);
    return database.transaction(async (tx) => {
      const { handle, ...profile } = input;
      if (handle) {
        if (!principal.owner)
          throw new AppError(
            403,
            "owner_required",
            "Only the workspace owner can change handles.",
          );
        const taken = await tx.query(
          "SELECT 1 FROM ap_agents WHERE handle=$1 AND id<>$2",
          [handle, z.uuid().parse(id)],
        );
        if (taken.rows.length)
          throw new AppError(
            409,
            "handle_taken",
            `@${handle} is already taken.`,
          );
        await tx.query(
          "UPDATE ap_agents SET handle=$2,updated_at=now() WHERE id=$1",
          [id, handle],
        );
      }
      return { agent: await writeProfile(tx, z.uuid().parse(id), profile) };
    });
  }
}

async function writeProfile(
  tx: Queryable,
  id: string,
  input: z.infer<typeof setProfileInput>,
) {
  const row = (
    await tx.query<AgentRow>("SELECT * FROM ap_agents WHERE id=$1", [id])
  ).rows[0];
  if (!row) throw new AppError(404, "not_found", "Agent not found.");
  const profile: AgentProfile = { ...decodeProfile(tx.cipher!, row) };
  if (input.display_name) profile.display_name = input.display_name;
  // An empty string clears an optional field.
  for (const key of ["harness", "description"] as const)
    if (input[key] !== undefined) {
      if (input[key]) profile[key] = input[key];
      else delete profile[key];
    }
  const saved = (
    await tx.query<{ handle: string }>(
      "UPDATE ap_agents SET encrypted_profile=$2,updated_at=now() WHERE id=$1 RETURNING handle",
      [id, tx.cipher!.encrypt(`agent:${id}`, profile)],
    )
  ).rows[0];
  return { id: row.id, handle: saved.handle, kind: row.kind, ...profile };
}

// Repeatable migration: every connection and member gets an agent. Connections
// are processed oldest first, so successive reconnects under one name share an
// agent (and a handle) instead of splitting their history.
export async function migrateAgents(
  tx: Queryable,
  tenantId: string,
  cipher: ContentCipher,
) {
  const scoped: Queryable = {
    query: tx.query.bind(tx),
    tenantId,
    cipher,
  };
  // The migration connects as the table owner, which bypasses row security;
  // switch to the tenant role so lookups and handles stay within this tenant.
  await tx.query("SELECT set_config('astropath.tenant_id',$1,true)", [
    tenantId,
  ]);
  await tx.query("SET LOCAL ROLE astropath_tenant");
  try {
    const connections = (
      await tx.query<{ id: string; name: string }>(
        "SELECT id,name FROM ap_connections WHERE agent_id IS NULL ORDER BY created_at,id",
      )
    ).rows;
    for (const connection of connections)
      await attachConnection(scoped, connection);
    await ensureMemberAgents(scoped);
  } finally {
    await tx.query("RESET ROLE");
  }
}

// Every active member and connection is mentionable before it first acts:
// OAuth approvals and older connections are attached here or on first use.
async function ensureMemberAgents(tx: Queryable) {
  const connections = (
    await tx.query<{ id: string; name: string }>(
      `SELECT id,name FROM ap_connections WHERE agent_id IS NULL AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at,id`,
    )
  ).rows;
  for (const connection of connections) await attachConnection(tx, connection);
  const members = (
    await tx.query<{ user_id: string; name: string }>(
      `SELECT m.user_id,m.name FROM ap_members m WHERE m.user_id IS NOT NULL
      AND m.disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM ap_agents a WHERE a.user_id=m.user_id)`,
    )
  ).rows;
  for (const member of members)
    await humanAgent(tx, member.user_id, member.name);
}

export const agents = new AgentStore(db);
