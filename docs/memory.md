# Memory log

Astropath keeps an append-only memory log for each agent session. Agents log
whenever they would write a memory; they do not choose a topic, kind or tag.
This is the data-capture layer. Organizing the log (human curation, and an
Astropath AI that builds structure and surfaces what matters) is future work
on top of it.

Memories belong to a tenant and space. Bodies, session names, session keys and
context are encrypted with the tenant key. Keyed hashes support session lookup
and retry detection without storing plaintext lookup keys.

## Agent workflow

`remember` (MCP) or `POST /api/v1/memories` (HTTP):

```json
{
  "session_key": "codex:NATIVE_SESSION_ID",
  "session_name": "PETG experiments",
  "session_context": "Codex in ~/prints",
  "body": "PETG at 235°C gave the best layer adhesion; 245°C strings more.",
  "idempotency_key": "petg-2026-09-30-1"
}
```

- `session_key` identifies the conversation. Use the native session or thread ID
  where the client exposes one; otherwise keep one unique `client:` key for the
  conversation and label it as generated. Either way it is client-reported, not
  verified by the server.
- The session is registered on first use under the authenticated connection
  and space. `session_name` (default "Unnamed session") and the optional
  `session_context` are recorded then and never change; later values are
  ignored. Another connection using the same key gets a separate session.
- `space` is optional and defaults to the connection's first space.
- `idempotency_key` is required. An exact retry returns the saved memory with
  `replayed: true` (HTTP 200); reusing the key for different content is a 409.
- Bodies are 1–20,000 characters. Guidance is one fact per entry, usually 1–4
  sentences: a discovery, decision, preference, tested or failed approach,
  blocker, or state worth resuming. Skip chatter, unchanged status and secrets.
- Human accounts may omit `session_key`; their entries are grouped per account.

`recall` (MCP) or `GET /api/v1/memories` reads the log newest first:

| Parameter | Meaning |
| --- | --- |
| `q` | Case-insensitive text match on the body |
| `session_key` | Only this connection's session with that key |
| `session_id` | One session, from any connection in an accessible space |
| `principal_id` | One agent connection or account |
| `no_session` | Only entries without a session (with `principal_id`, one account's own notes) |
| `space` | One accessible space |
| `before`, `limit` | Pagination: pass `next_before` as `before`; limit up to 100 (default 30) |

Search decrypts authorized batches in memory; there is no plaintext index or
embedding service. `GET /api/v1/memory-sessions` lists sessions that have
memories, most recently active first, with the agent, session name and context,
entry count, first and last activity, and a preview of the latest entry.

The MCP server includes this guidance in its instructions. The
[client integration templates](../public/integrations/README.txt), served at
`/integrations/README.txt`, carry it into Claude Code/Codex skills and
CLAUDE.md/AGENTS.md policy, ChatGPT instructions and OpenClaw automations.
Astropath does not observe agents or schedule check-ins.

## Authorship and immutability

Each memory records the authenticated connection and a snapshot of its name,
plus its session's ID, name and key. Two sessions using one connection remain
distinguishable; another connection cannot write into a session it does not
own. Memories and sessions cannot be updated or deleted (database triggers and
grants enforce this); a correction is a new entry. Clients sharing a credential
share its authority.

## Human view

**Memory** in the web app lists sessions by latest activity. Opening one shows
its log oldest first, with earlier entries loaded on demand. Searching shows
matching entries across sessions, each linked to its session.

## Retired topic tree

Earlier releases filed notes under a hierarchy of topics. `db:migrate` copies
every topic note into the log once, keeping its author, session, timestamp and
retry fingerprint; the topic path and kind are kept on the entry as `legacy`
(`{"path": [...], "kind": "..."}`) for whatever later organizes the log. The
topic, session and note tables remain, read-only in practice, as history.

For older clients, `record_work_note` and `POST /api/v1/work-notes` still work:
they append the body to the session's log and keep `path` and `kind` as the
legacy hint. The other topic tools and the `/topics`, `/topic-notes` and
`/agent-sessions` endpoints are retired; the endpoints return 410.

## Upgrade

Run `npm run db:migrate` with the existing master key before deploying. It adds
`ap_memories` with row security, grants, immutability trigger and indexes, then
copies topic notes. It is repeatable: notes already copied are skipped. No new
secret or storage migration is required. Refresh MCP tool lists after deploying.
