import { z } from "zod";
import {
  topicPathInput,
  listTopicsInput,
  registerSessionInput,
  topicNoteInput,
  listTopicNotesInput,
  archiveTopicInput,
} from "./knowledge";

export function knowledgePaths() {
  const responses = {
    "200": { description: "Successful operation" },
    "400": { description: "Invalid input or missing agent session" },
    "401": { description: "Authentication required" },
    "403": { description: "Insufficient scope or human account required" },
    "404": { description: "Outside accessible tenant/spaces or not found" },
    "409": { description: "Archived topic or conflicting note retry key" },
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
    "201": { description: "Created or existing result returned" },
  };
  return {
    "/topics": {
      get: {
        operationId: "listTopics",
        summary: "Browse or search hierarchical knowledge topics",
        description:
          "Without q, lists roots or direct children of parent_id. q searches full paths; parent_id limits it to direct children. Archived branches are hidden by default. Pass next_cursor as after.",
        parameters: query(listTopicsInput),
        responses,
      },
      post: {
        operationId: "ensureTopic",
        summary: "Find or create a topic path",
        description:
          "Requires astropath:write. Creates missing path segments and reuses existing names ignoring case and repeated whitespace. Returns topic with breadcrumbs and created. Rejects archived ancestors. Defaults space to the first accessible space, or general for unrestricted accounts.",
        requestBody: body(topicPathInput),
        responses: created,
      },
    },
    "/topics/{id}": {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      get: {
        operationId: "readTopic",
        summary: "Read topic path and inherited archive state",
        responses,
      },
      patch: {
        operationId: "archiveTopic",
        summary: "Manually archive or restore a topic branch",
        description:
          "Human session only; bearer and OAuth connections cannot archive. Requires write scope and space access. Archived branches remain readable but reject new notes and subtopics. Restoring an ancestor preserves independently archived children.",
        requestBody: body(archiveTopicInput),
        responses,
      },
    },
    "/agent-sessions": {
      post: {
        operationId: "registerAgentSession",
        summary:
          "Register a session under the authenticated connection and space",
        description:
          "Requires astropath:write. session_key is the client-reported native thread/conversation ID. Repeated registration returns the original immutable session identity. Save session.id for note authorship. This is attribution, not verified runtime presence.",
        requestBody: body(registerSessionInput),
        responses: created,
      },
    },
    "/topic-notes": {
      get: {
        operationId: "listTopicNotes",
        summary: "Read and search notes with connection and session authorship",
        description:
          "Requires astropath:read. Includes descendants by default when topic_id is supplied; omitting it searches all accessible topics. q searches note bodies. Returns notes and next_before. Archived branches require include_archived:true.",
        parameters: query(listTopicNotesInput),
        responses,
      },
      post: {
        operationId: "appendTopicNote",
        summary: "Append an immutable session-attributed note",
        description:
          "Requires astropath:write. Agents must include a session_id registered by their own connection in the topic's space. Human sessions may omit it. Authorship is assigned by the server. idempotency_key is required: reuse only for retries of the same note. Returns note and replayed. There is no update/delete endpoint.",
        requestBody: body(topicNoteInput),
        responses: created,
      },
    },
  };
}
