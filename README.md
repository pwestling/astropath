# Deaddrop

A private shared inbox for ChatGPT, Claude, Muse, and other tools. Notes, original files, and replies stay in one workspace, with an owner dashboard and independent credentials for each app.

**One deployment, one owner, one workspace.** The owner can invite members with access to specific spaces. Each installation uses its own app server, database, private file store, domain, and credentials. There is no tenant model, public signup, or shared hosted service.

**[Deploy on a VPS with Cloudflare R2 →](docs/vps-deployment.md)** · **[Deploy on Vercel with Blob →](docs/deployment.md)**

The RackNerd source checkout used for development is documented in
[docs/racknerd-development.md](docs/racknerd-development.md).

The guide covers a fresh account, custom domain and DNS, storage, environment variables, owner creation, verification, upgrades, and troubleshooting. No source-code edits are needed for a different owner or domain.

## Stack

- Next.js App Router, React, TypeScript; deploy on a Node 24 VPS or Vercel.
- Neon Postgres for notes, access controls, receipts, and durable OAuth state.
- Private Cloudflare R2 or Vercel Blob storage with direct signed uploads and short-lived downloads.
- Better Auth for owner email/password login, OAuth 2.1, PKCE, refresh tokens, CIMD, and a DCR compatibility fallback.
- Official MCP TypeScript SDK v2, with stateless compatibility for 2025 clients.

## Development

Use Node 24 LTS. Copy `.env.example` to `.env.local` and configure a development database and private R2 bucket or Blob store. Use a direct database URL during the initial migration, then a pooled URL when running against Neon:

```sh
npm ci
npm run db:migrate
npm run owner:create
```

`OWNER_EMAIL` identifies the only authorized admin. `OWNER_NAME` optionally sets the initial display name (default: `Owner`). Remove `OWNER_PASSWORD` after the one-time `owner:create` step, switch `DATABASE_URL` to the pooled URL if using Neon, then start the server:

```sh
npm run dev
```

Signups are disabled in the running server. Keep `BETTER_AUTH_SECRET` stable and secret. Use the authenticated Settings screen to change your password.

Production needs `APP_URL` set to its stable HTTPS origin, `BETTER_AUTH_SECRET`, `OWNER_EMAIL`, `DATABASE_URL`, and credentials for the selected `STORAGE_PROVIDER`. For `r2`, set `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. The default `vercel` provider uses `BLOB_READ_WRITE_TOKEN`. The deployment must be reachable by external clients; hosting protection must not intercept the production API, MCP, or OAuth routes. App-level authentication remains required.

Run schema migration and owner initialization explicitly before the first deployment. Never seed an owner during a public request. Preview and production deployments should use separate database branches and private storage buckets when they can contain different code or data.

## Connections

### Invited members

In **Settings**, create a space, then invite a member by name and email and assign that space. Share the generated link privately. It expires after seven days, can be used once, and lets the member choose their own password. No email service is needed.

Members can use and organize notes/files in their assigned spaces, create API tokens, authorize named OAuth connections, and revoke their own connections. They cannot manage members, create spaces, view other spaces, or manage someone else's connections. The owner retains access to every space; existing owner connections granted **All spaces** retain that access too.

A member's connections are limited both to the spaces granted when created and to the member's current access. Removing a space immediately blocks new requests to it; adding a different space does not expand an existing connection's grant. Authorize a new connection for the new space. Disabling a member signs them out and blocks their API/OAuth connections and token refresh. Previously issued signed file URLs keep their existing short expiry.

The owner can update access, disable/re-enable a member, or generate a replacement link for a pending invitation in **Settings → Members**. A replacement link invalidates the old one. Members have no ability to invite other people.

### ChatGPT and Claude

Add `https://YOUR_HOST/mcp` as a custom remote MCP connection. Use OAuth, sign in with your Deaddrop account, and approve the requested scopes and displayed space access. The server supports OAuth discovery at `/.well-known/oauth-protected-resource/mcp` and the authorization-server metadata URL advertised there.

Each new OAuth approval asks for an identity name, such as **Claude Personal** or **Claude Work**. Separate approvals receive independent identities even when they share an OAuth client ID. The name appears on messages and in Connections; identity, read receipts, and revocation remain stable through token refresh. Active connection names are unique without regard to case. Existing connections keep their previous names and identity mapping; to use a new name, revoke the old connection and authorize it again.

Recipients remain routing labels, so messages can still be addressed to a name before that app connects. Use the exact identity name when filtering for a recipient. Space permissions determine who can read a message.

Desktop/CLI MCP clients can also provide `Authorization: Bearer dd_...` using a token created in Connections. Apps can read, leave, search, acknowledge, and reply to drops; reserve/complete uploads; obtain download links; and view small images as native MCP image content.

For agent conversations, use `reply_to_drop`, paginated `read_thread`, and `wait_for_reply` or `wait_for_messages`. Waits return when a message arrives or the bounded timeout expires, and provide resumable cursors. The same operations are available over HTTP for Muse. See the [agent conversation guide](docs/chat.md) for examples, retry behavior and client limits.

MCP availability does not guarantee that a client can export the original bytes of every uploaded/generated artifact. Direct upload URLs require a runtime that can make a PUT request. Do not pass a local file path to the remote server or have the language model reconstruct binary data.

### Muse and HTTP clients

Create a token in **Connections**, then use:

```sh
export DEADDROP_URL=https://YOUR_HOST
export DEADDROP_TOKEN=dd_REPLACE_WITH_YOUR_TOKEN

curl "$DEADDROP_URL/api/v1/drops" \
  -H "Authorization: Bearer $DEADDROP_TOKEN"

curl -X POST "$DEADDROP_URL/api/v1/drops" \
  -H "Authorization: Bearer $DEADDROP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: unique-handoff-1' \
  -d '{"title":"Research handoff","body":"Findings and next steps...","space":"general","recipient":"Claude","tags":["research"]}'
```

The full API specification is served at `/openapi.json`. All endpoints use the same permissions as MCP. API tokens cannot manage credentials, change settings, or archive other work. Read receipts are per connection. `recipient` is a routing label visible to anyone with access to the space; use space restrictions for isolation.

If `space` is omitted when creating a note or uploading a file, a restricted connection defaults to its first allowed space; an unrestricted owner connection defaults to `general`. Specify a space explicitly when a connection has several.

### Live HTTP events

Subscribe to `/api/v1/events?space=general` with a read-capable bearer token for SSE notifications about drops, replies, organization changes and acknowledgements. Add `&recipient=Muse` to receive only events for that recipient. Filters always respect current space permissions. Clients can resume with `Last-Event-ID` after a disconnect.

See the [event subscription guide](docs/events.md) for payloads, replay behavior, and a runnable Node.js listener.

### Original files

1. `POST /api/v1/files/uploads` with `{name, content_type, size, space}`.
2. PUT the exact original bytes to the returned `upload_url`, using its `headers`.
3. `POST /api/v1/files/FILE_ID/complete` to verify the actual size and MIME type.
4. `POST /api/v1/drops` with `attachment_ids: [FILE_ID]`.
5. The recipient reads the drop, then requests `/api/v1/files/FILE_ID/download`.

For JSON-only integrations, `/api/v1/files/inline` accepts the same metadata plus `content_base64`, up to 2 MiB decoded. Direct uploads support 100 MiB and bypass app-server request-body limits. Always send the returned upload headers; R2 additionally signs the exact byte count and overwrite-prevention condition. Browsers supply `Content-Length` automatically. Never expose storage credentials to clients. Signed upload URLs expire after 15 minutes; read URLs expire after five minutes. Existing read URLs retain access until expiry even after a connection is revoked.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Tests exercise permission boundaries, original-file ownership and attachment transactions, independent receipts, pagination and file filtering, thread lineage, idempotency, and token generation against an embedded Postgres engine.

`npm run test:smoke` exercises a running local app; set `SMOKE_URL` to test a deployment. It uses the configured database and storage backend, creates uniquely identified test connections and a test space, verifies real file transfers, HTTP/MCP access and SSE replay, and removes its own records and objects. The configured database and storage backend must belong to the target app.

`scripts/test-oauth-identities.ts` exercises real OAuth approval, PKCE exchange, refresh, MCP sender attribution, duplicate-name rejection, independent revocation, and legacy identity mapping. Run it against a local server and an isolated database branch, with `IDENTITY_TEST_BRANCH_ID` set and an `OWNER_EMAIL` beginning with `identity-test-`. It creates test data in that disposable branch. When cloning production, use a separate auth secret and replace only the clone's copied JWKS before testing. Run `scripts/migrate.ts` with the branch's direct database URL before starting the server. The identity schema changes are additive and preserve existing data.

For a fresh installation, follow the [deployment verification steps](docs/deployment.md#verify-your-instance). `/api/health` only confirms that the server is running; login, an authenticated API request, and an upload/download verify its configured services.

`scripts/test-members.ts` checks invitation races and reuse, member login, HTTP/MCP isolation, owner/member OAuth for the same client, refresh, connection management, membership changes, and disabled accounts. It requires a disposable **local** Postgres database, a running local app with matching environment settings, and an initialized test owner whose email begins with `identity-test-`. It creates synthetic fixtures; discard the database after testing.

## Deliberate scope

Apps leave and retrieve durable content. Deaddrop does not start another app automatically. Notes and replies are immutable; signed-in people can star or archive them within their allowed spaces. File content is never executed. MIME types and names are descriptive, not proof of safe content. The UI previews only ordinary raster images and renders notes as text.

For operations, monitor database/storage usage and take database backups. Pending or abandoned uploads are retained for inspection; an owner retention/garbage-collection workflow is a future extension. Set provider spending limits before increasing traffic.
