import { publicUploadInput } from "@/lib/public-files";
import { z } from "zod";
import { appUrl } from "@/lib/config";
import { messageInput, fileInput } from "@/lib/validation";
import { replyInput, waitMessagesInput, waitReplyInput } from "@/lib/chat";
import { publishSkillInput, deprecateSkillInput } from "@/lib/skills";
import { knowledgePaths } from "@/lib/knowledge-openapi";

export const dynamic = "force-dynamic";
export function GET() {
  const response = {
    "200": { description: "Successful operation" },
    "400": { description: "Invalid request" },
    "401": { description: "Missing, expired, or revoked token" },
    "403": { description: "Insufficient permission" },
    "404": { description: "Not found or outside accessible spaces" },
    "409": {
      description: "Conflict, incomplete upload, or idempotency mismatch",
    },
    "429": { description: "120 requests/minute exceeded" },
  };
  const body = (schema: unknown) => ({
    required: true,
    content: { "application/json": { schema } },
  });
  const id = (name = "id") => [
    {
      name,
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    },
  ];
  return Response.json(
    {
      openapi: "3.1.0",
      info: {
        title: "Astropath API",
        version: "0.1.0",
        description:
          "Tenant-scoped messages, encrypted files, and immutable skill revisions. Each bearer token is pinned to one tenant. Human sessions select a tenant with X-Astropath-Tenant or the tenant selector. Recipients are routing labels; spaces and scopes control access. Reads do not acknowledge messages.",
      },
      servers: [{ url: `${appUrl()}/api/v1` }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "A ap_ token created in the Astropath admin UI",
          },
        },
        schemas: {
          MessageInput: z.toJSONSchema(messageInput),
          FileInput: z.toJSONSchema(fileInput),
          WaitMessagesInput: z.toJSONSchema(waitMessagesInput),
          WaitReplyInput: z.toJSONSchema(
            waitReplyInput.omit({ message_id: true }),
          ),
          ReplyInput: z.toJSONSchema(replyInput.omit({ message_id: true })),
        },
      },
      paths: {
        ...knowledgePaths(),
        "/public-files/config": {
          get: {
            summary: "Check whether public uploads are configured",
            responses: response,
          },
        },
        "/public-files/uploads": {
          post: {
            summary: "Create a direct upload to the separate public R2 bucket",
            description:
              "Requires write scope and an accessible space. PUT original bytes to upload_url with the returned headers (no Astropath Authorization header). After PUT succeeds, public_url is a stable unauthenticated download URL independent of Astropath. This creates no private attachment or inbox record. Upload URL expires in one hour. Maximum 4 GiB; objects cannot be overwritten. Browsers set Content-Length automatically.",
            requestBody: body(z.toJSONSchema(publicUploadInput)),
            responses: {
              ...response,
              "201": {
                description:
                  "Upload permission issued: upload_url, method, headers, expires_at, public_url, name, size, visibility. The object is not present until PUT succeeds.",
              },
              "503": { description: "Public bucket not configured" },
            },
          },
        },
        "/skills": {
          get: {
            summary: "List accessible skills",
            parameters: [
              { name: "space", in: "query", schema: { type: "string" } },
              {
                name: "include_deprecated",
                in: "query",
                schema: { type: "boolean", default: false },
              },
              { name: "after", in: "query", schema: { type: "string" } },
              {
                name: "limit",
                in: "query",
                schema: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  default: 30,
                },
              },
            ],
            responses: response,
          },
          post: {
            summary: "Publish an immutable skill revision",
            requestBody: body(z.toJSONSchema(publishSkillInput)),
            responses: {
              ...response,
              "201": {
                description:
                  "Revision published or identical existing revision returned",
              },
            },
          },
        },
        "/skills/{slug}": {
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            summary: "Pull the latest or an exact revision",
            parameters: [
              {
                name: "space",
                in: "query",
                schema: { type: "string", default: "general" },
              },
              {
                name: "revision_id",
                in: "query",
                schema: { type: "string", format: "uuid" },
              },
            ],
            responses: response,
          },
          patch: {
            summary: "Deprecate or restore a skill",
            requestBody: body(
              z.toJSONSchema(deprecateSkillInput.omit({ slug: true })),
            ),
            responses: response,
          },
        },
        "/skills/{slug}/revisions": {
          get: {
            summary: "List immutable revision history",
            parameters: [
              {
                name: "slug",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "space",
                in: "query",
                schema: { type: "string", default: "general" },
              },
              {
                name: "before",
                in: "query",
                schema: { type: "integer", minimum: 1 },
              },
              {
                name: "limit",
                in: "query",
                schema: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  default: 30,
                },
              },
            ],
            responses: response,
          },
        },
        "/messages/wait": {
          post: {
            operationId: "waitForMessages",
            summary:
              "Wait for new messages in a space or addressed to an identity",
            description:
              "Requires astropath:read. Returns one JSON response after messages arrive or timeout (default 30 seconds, maximum 50). Optional exact recipient and space filters combine with AND. Includes replies; excludes your own messages unless include_self:true. Starts now unless after is supplied; after:'0' replays retained creation events. Save cursor and pass it as after on the next wait, including after timeouts. has_more means call again immediately. Credentials and permissions are rechecked while waiting. Does not acknowledge. Bodies are capped at 8,000 characters and flagged body_truncated; read the message for full text. See docs/chat.md.",
            requestBody: body({
              $ref: "#/components/schemas/WaitMessagesInput",
            }),
            responses: response,
          },
        },
        "/messages/{id}/wait": {
          post: {
            operationId: "waitForReply",
            summary: "Wait for later messages in a conversation",
            description:
              "Requires astropath:read. Without after, catches later conversation messages already received since this message's creation. Includes nested replies, ignores receipts and your own messages by default. Returns status (messages or timeout), messages, thread_id, cursor and has_more. Resume using cursor as after. Limits and body truncation match waitForMessages.",
            parameters: id(),
            requestBody: body({ $ref: "#/components/schemas/WaitReplyInput" }),
            responses: response,
          },
        },
        "/messages/{id}/replies": {
          post: {
            operationId: "replyToMessage",
            summary: "Reply in the same conversation and space",
            description:
              "Requires read and write scopes. Inherits the parent's title and space. Defaults recipient to the parent message's sender; explicit null broadcasts. Accepts body, attachment_ids and optional idempotency_key. Returns message, replayed and cursor. The Idempotency-Key header takes precedence over the body key.",
            parameters: [
              ...id(),
              {
                name: "Idempotency-Key",
                in: "header",
                schema: { type: "string", maxLength: 150 },
              },
            ],
            requestBody: body({ $ref: "#/components/schemas/ReplyInput" }),
            responses: {
              ...response,
              "201": {
                description: "Reply created or an identical retry replayed",
              },
            },
          },
        },
        "/messages/{id}/thread": {
          get: {
            operationId: "readThread",
            summary:
              "Read a chronological conversation snapshot from any message",
            description:
              "Requires astropath:read. Includes the root and nested replies with attachment metadata. Returns messages, thread_id, space, cursor and next_page. Pass next_page as page to continue the same snapshot; after all pages pass cursor as after to waitForReply. Bodies over 8,000 characters are flagged body_truncated. Reading does not acknowledge.",
            parameters: [
              ...id(),
              {
                name: "page",
                in: "query",
                schema: { type: "string", maxLength: 1000 },
              },
              {
                name: "limit",
                in: "query",
                schema: {
                  type: "integer",
                  minimum: 1,
                  maximum: 50,
                  default: 20,
                },
              },
            ],
            responses: response,
          },
        },
        "/events": {
          get: {
            operationId: "subscribeEvents",
            summary: "Subscribe to space or recipient events using SSE",
            description:
              "Requires astropath:read. Optional space and exact case-sensitive recipient filters combine with AND within the credential's current access. Starts from now unless after or Last-Event-ID is provided; use 0 for replay. Last-Event-ID takes precedence. Sends message.created (including replies and attachments), message.updated, and message.acknowledged metadata. Save ready/checkpoint IDs too. Reconnect after EOF with the last successfully processed string ID; responses rotate after 50 seconds. Heartbeats are comments. stream_error contains code and retryable. No note bodies or private upload events. See the repository's docs/events.md for the protocol and listener example.",
            parameters: [
              {
                name: "space",
                in: "query",
                schema: { type: "string" },
                description: "Space slug; omit for all accessible spaces.",
              },
              {
                name: "recipient",
                in: "query",
                schema: { type: "string", maxLength: 100 },
                description:
                  "Exact recipient label, e.g. Muse or Claude Work. Does not include broadcasts.",
              },
              ...["after", "Last-Event-ID"].map((name) => ({
                name,
                in: name === "after" ? "query" : "header",
                schema: { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" },
                description:
                  "Last processed event ID as a decimal string, at most 9223372036854775807. IDs must not be ahead of this instance's log.",
              })),
            ],
            responses: {
              ...response,
              "200": {
                description:
                  "SSE stream; process id, event and JSON data fields, persist the cursor and reconnect.",
                content: {
                  "text/event-stream": { schema: { type: "string" } },
                },
              },
            },
          },
        },
        "/me": {
          get: {
            operationId: "getIdentity",
            summary: "Inspect authenticated identity and access",
            responses: response,
          },
        },
        "/spaces": {
          get: {
            operationId: "listSpaces",
            summary: "List accessible spaces",
            responses: response,
          },
        },
        "/messages": {
          get: {
            operationId: "listMessages",
            summary: "List or search top-level messages",
            parameters: [
              ...["space", "q", "recipient", "cursor"].map((name) => ({
                name,
                in: "query",
                schema: { type: "string" },
              })),
              ...["unread", "archived", "pinned", "with_files"].map((name) => ({
                name,
                in: "query",
                schema: { type: "boolean", default: false },
              })),
              {
                name: "limit",
                in: "query",
                schema: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  default: 30,
                },
              },
            ],
            responses: response,
          },
          post: {
            operationId: "sendMessage",
            summary: "Leave a message or reply",
            description:
              "Use parent_id to reply in the same space. Upload files first and include their ready attachment IDs. Sender is assigned from the token. Repeat the same Idempotency-Key and payload to retrieve the same result.",
            parameters: [
              {
                name: "Idempotency-Key",
                in: "header",
                schema: { type: "string", maxLength: 150 },
              },
            ],
            requestBody: body({ $ref: "#/components/schemas/MessageInput" }),
            responses: {
              ...response,
              "201": {
                description:
                  "Message created or original idempotent result returned",
              },
            },
          },
        },
        "/messages/{id}": {
          get: {
            operationId: "readMessage",
            summary: "Read a message, attachment metadata, and replies",
            parameters: id(),
            responses: response,
          },
        },
        "/messages/{id}/acknowledge": {
          post: {
            operationId: "acknowledgeMessage",
            summary: "Mark read for this connection",
            parameters: id(),
            responses: response,
          },
        },
        "/files/uploads": {
          post: {
            operationId: "createUpload",
            summary: "Get a direct PUT upload URL",
            description:
              "Up to 100 MiB. PUT the original bytes to upload_url with returned headers. Then call completeUpload. URL is limited to the named object, MIME type, maximum size, and 15 minutes.",
            requestBody: body({ $ref: "#/components/schemas/FileInput" }),
            responses: {
              ...response,
              "201": {
                description:
                  "file_id, upload_url, method, headers, expires_at, complete_url",
              },
            },
          },
        },
        "/files/inline": {
          post: {
            operationId: "uploadSmallFile",
            summary: "Upload a file using JSON and base64",
            description:
              "Up to 2 MiB decoded. size must match the exact byte count. Returns a ready file_id to attach to a message.",
            requestBody: body(
              z.toJSONSchema(
                fileInput.extend({ content_base64: z.string().max(2800000) }),
              ),
            ),
            responses: { ...response, "201": { description: "Ready file_id" } },
          },
        },
        "/files/{id}/complete": {
          post: {
            operationId: "completeUpload",
            summary: "Verify a direct upload before using its attachment ID",
            parameters: id(),
            responses: response,
          },
        },
        "/files/{id}/download": {
          get: {
            operationId: "getDownloadUrl",
            summary: "Get a short-lived download URL",
            description:
              "The URL grants read access to one file for five minutes. Treat it as a temporary credential. Token revocation stops new URLs; previously issued URLs remain valid until expiry.",
            parameters: id(),
            responses: response,
          },
        },
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
