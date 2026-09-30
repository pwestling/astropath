import { z } from "zod";
import {
  rememberInput,
  recallInput,
  listSessionsInput,
  recordWorkNoteInput,
} from "./memory";

export function memoryPaths() {
  const responses = {
    "200": { description: "Successful operation" },
    "400": { description: "Invalid input or missing session_key" },
    "401": { description: "Authentication required" },
    "403": { description: "Insufficient scope" },
    "404": { description: "Outside accessible tenant/spaces or not found" },
    "409": { description: "Conflicting memory retry key" },
  };
  const body = (schema: z.ZodType) => ({
    required: true,
    content: { "application/json": { schema: z.toJSONSchema(schema) } },
  });
  const query = (schema: z.ZodObject) =>
    Object.entries(schema.shape).map(([name, value]) => ({
      name,
      in: "query",
      schema: z.toJSONSchema(value as z.ZodType),
    }));
  const created = {
    ...responses,
    "201": { description: "Created; 200 returns an exact retry" },
  };
  return {
    "/memories": {
      post: {
        operationId: "remember",
        summary: "Append a memory to this session's log",
        description:
          "Requires astropath:write. Log whenever you would write a memory: one fact per entry, usually 1-4 sentences, with no topic or category. Agents must supply a stable session_key for the conversation; the session is registered on first use with session_name and optional session_context, and never changes afterwards. Human accounts may omit it. idempotency_key is required: reuse it only for an exact retry. Returns memory, session and replayed. Memories are immutable.",
        requestBody: body(rememberInput),
        responses: created,
      },
      get: {
        operationId: "recall",
        summary: "Search or read the memory log, newest first",
        description:
          "Requires astropath:read. q matches memory text (decrypted in memory; there is no plaintext index). session_key limits to your own session with that key; session_id and principal_id narrow to one session or agent. Pass next_before as before. Memories copied from retired topic notes carry legacy.path and legacy.kind.",
        parameters: query(recallInput),
        responses,
      },
    },
    "/memory-sessions": {
      get: {
        operationId: "listMemorySessions",
        summary: "List sessions that have memories, most recently active first",
        description:
          "Requires astropath:read. Each row gives the agent, session name and context, entry count, first and last activity, and a preview of the latest entry. Account entries without a session are grouped per account. Pass next_before as before.",
        parameters: query(listSessionsInput),
        responses,
      },
    },
    "/work-notes": {
      post: {
        operationId: "recordWorkNote",
        summary: "Deprecated: append a memory using the retired topic call",
        description:
          "Kept for older clients; use POST /memories. Appends body to the session's memory log. path and kind are stored only as a hint; no topic is created. The /topics, /topic-notes and /agent-sessions endpoints now return 410.",
        requestBody: body(recordWorkNoteInput),
        responses: created,
      },
    },
  };
}
