# Tool platform: implementation plan

**Status:** revision 2, 2026-10-03. Phase 1 was built on 2026-10-04: see [platform.md](platform.md).

**Sources:**
- **The spec:** "Astropath Tool Platform and App Integration Specification — Proposed v1", board topic `19371e3e`.
- **The STC spec:** `cb65dd4a`, revised in reply `5f816d31`. STC is the first real app.
- **The Arbites spec:** `b983bf72`, which supplies approval behind `approval_required`.
- **STC's plan:** `../stc/docs/implementation-plan.md`, which treats this registry and dispatcher as STC's prerequisite.

## The model

Astropath is a **front door and catalog** for tools that other apps serve.

- **Apps own their tools and data.** Each app is its own service with its own database and its own deploy. Astropath does not host app code or app tables.
- **Apps register themselves when they deploy.** An app's deploy step sends its manifest (operations, schemas, routes) to Astropath. Astropath validates it and publishes a new catalog. **Astropath itself does not redeploy.**
- **Agents keep one connection.** That connection gains three fixed tools:
  - `discover` searches the catalog;
  - `invoke` forwards one call to the owning app;
  - `execute` runs a short script that chains calls.
  New tools show up on the next `discover`, with no new MCP tool, reconnect or restart.
- **Astropath keeps the shared parts:**
  - authentication and the grant check;
  - a durable log of every call, with idempotency;
  - forwarding as the calling agent;
  - turning a downstream timeout into "outcome unknown" instead of a blind retry.
- **Astropath's own features are built-in apps.** Memory, the board, files and skills register as `core.*` operations served in-process. The existing MCP tools keep working unchanged.

## Where the spec meets the current code

| Spec assumes | Astropath today | Plan |
| --- | --- | --- |
| Python backend and handlers | Next.js 16 / TypeScript, Zod 4, `pg`, PGlite tests | The dispatcher, adapter and core handlers are TypeScript. Remote apps can use any language. |
| Scopes `astropath:read`/`write` | The same two, in `ap_connections.scopes text[]`, with optional `spaces text[]` | They keep covering `core.*`. App access is decided by grant policy (below), not by these scopes. |
| Tenant and space | Tenants with RLS and per-tenant AES keys; spaces | Invocation, app and catalog rows are tenant-scoped under RLS. Stored arguments and results are encrypted with the tenant key. |
| Idempotency | `ap_messages` enforces principal-scoped keys, with a request hash and conflict | Generalise this into one invocation log, and pass the key downstream. |
| Change notifications | An `ap_events` table and an SSE stream exist | Expose them as a durable, cursor-based change feed for indexing apps. |

## How an app joins

### One-time setup (you, in the Console)

1. Create the app and choose its namespace (`stc`).
2. Set its **origin**, the base URL Astropath forwards to. Only the owner sets this; a manifest cannot. That way a leaked publisher key cannot point tools somewhere else.
3. Choose its **grant policy** (see below).
4. Astropath issues a **publisher key**. It can publish manifests for that namespace and nothing else, and goes into the app's deploy secrets.

### Every deploy

1. The deploy script calls `POST /api/platform/v1/apps/{app}/releases`, with the manifest and the publisher key.
2. Astropath validates the manifest:
   - names, and reserved words (`then`, `constructor`, `prototype`, `__proto__`, and the `platform` namespace);
   - unique `operation@version`;
   - self-contained JSON Schema 2020-12, with no remote `$ref`;
   - at most 32 KiB per contract;
   - examples validate against their input schemas;
   - every route is a relative path under the fixed origin.
3. Astropath probes the app's health endpoint, plus a manifest-digest endpoint that confirms the deployed code serves the release being registered.
4. Activation is atomic and uses an expected-current-catalog precondition, so two concurrent deploys can't overwrite each other.
5. Re-sending the same release with the same content does nothing. Different content under the same release ID is rejected.

### Versions

- **Old versions are the app's responsibility.** It serves versioned routes. To retire a version it first marks it `deprecated` (with a date) in a manifest, then omits it.
- **Each catalog revision is a hash of the active contract set.** An invocation that names an older revision succeeds if that exact `operation@version` is still active with the same contract hash. Otherwise it gets `CATALOG_EXPIRED` or `OPERATION_RETIRED` and never falls forward to a newer version.
- **The owner can disable an app or an operation instantly** from the Console, across all revisions.

## Grants: auto by default

You want more automatic than explicit, so the default for apps you set up is **auto-grant**:

- **App policies.** Each app has one of:
  - `auto`, the default: every connection that has `astropath:write` gets the app's read and write operations. Connections with only `astropath:read` get its read operations.
  - `explicit`: nothing is granted until it is toggled per connection.
  - `disabled`.
- **External effects.** Operations whose effect is `external` (outside the app's own data: sending email, pushing code, spending money) follow the same policy by default. An app can mark operations `sensitive`, which routes them to explicit grants, and later to Arbites approval.
- **Per-connection opt-outs.** Any connection can be excluded from a given app, for example a low-trust agent that gets only `core.*`.
- **Why this is reasonable.** A publisher key can only add tools that route to its own fixed origin. A compromised publisher therefore exposes nothing beyond what that app could already do. The risk is bounded by the app, not by Astropath.
- **The Console Apps view** shows each app, its operations and policy, the per-connection exceptions, and recent calls.

## Calls and identity

### Dispatcher

`dispatch(principal, request)` runs these steps in order:

1. Resolve the exact binding.
2. Check the grant.
3. Validate strictly: no coercion or defaults; reject unknown keys, duplicate JSON keys and non-finite numbers.
4. Hash the arguments as SHA-256 of their JCS canonical form.
5. Reserve the invocation in its own committed transaction.
6. Forward the call, or run a local `core.*` handler.
7. Validate the output.
8. Finalise the receipt.

Errors use the spec's §4.4 envelope: a `code`, plus `effect_state` and `retry_advice`.

### Forwarding

- **Delegated token.** Each forwarded call carries a signed, audience-bound token valid for at most 60 seconds. Its claims cover:
  - who and where: principal, tenant, space and connection;
  - what: the operation, its version and the invocation ID;
  - which request: the argument hash and the idempotency digest.
- **Signing.** The token is signed with Ed25519, using a key in SOPS. Apps verify it against `GET /.well-known/jwks.json`.
- **Idempotency.** The idempotency key travels downstream so the app can deduplicate.
- **Safety.** The adapter never forwards caller credentials, refuses redirects and origin changes, and enforces the timeout. A timeout after dispatch yields `unknown`, which needs reconciling with the same key; it is never retried with a fresh key.

### Receipts

- `platform.get_receipt` and `GET /api/v1/invocations/{id}` return a call's recorded outcome.
- Async app operations return `accepted` with the app's own job handle. The app owns its job lifecycle; Astropath records the handle.

### Agent surface

- **MCP:** `discover`, `invoke` and `execute` return `structuredContent` plus a short text form, with `isError` on failure.
- **HTTP:** `POST /api/v1/discover`, `POST /api/v1/invoke` and `POST /api/v1/execute`.
- **`execute`:** ships first with its fixed schema, returning `NOT_AVAILABLE`.

## Apps reading Astropath data

Apps do **not** read Astropath's database directly:
- Message, memory and profile content is encrypted with per-tenant keys. A direct reader would see ciphertext unless it held the master key.
- RLS and frequent migrations would make apps break on internal changes.

The spec agrees: cross-app reads go through published operations or versioned read contracts. Apps that index or reference Astropath data use three things instead:

- **A service connection.** An app gets its own read (or read and write) connection and calls `core.*` operations, the same API agents use. Results come back decrypted and checked against permissions.
- **A change feed.** `GET /api/platform/v1/changes?after=<cursor>` returns a durable, resumable stream of created and updated board topics, replies, memories and files, built on `ap_events`. An indexer stores its cursor and catches up after downtime. The feed carries IDs and change kinds, with content included if the connection may read it.
- **References by ID.** Apps store Astropath IDs (topic, memory, session, file) and fetch content when they need it.

When an app acts on behalf of a calling agent, it can call back into `core.*` with that call's delegated token. The callback then runs with the agent's permissions, not with the app's broader service connection.

## Phases

### Phase 1: catalog, dispatcher and forwarding

**Tables**
- `ap_apps`: namespace, origin, grant policy, and the publisher key hash.
- `ap_app_releases`
- `ap_catalog_snapshots`
- `ap_connection_app_exclusions`
- `ap_invocations`: a unique key on (tenant, principal, space, operation, version, idempotency_key), plus the argument hash, status, attempt fence, and encrypted arguments and result.

**Endpoints and routes**
- The publisher endpoint, the JWKS route and the remote adapter.
- The `core.*` operations, served in-process by the existing store functions.
- MCP and HTTP `discover`, `invoke` and `execute`, with `execute` returning `NOT_AVAILABLE`.

**Console:** an Apps view with setup, policy, exclusions and recent calls.

**Agent docs:** update `llms.txt`, the guidance template and `GUIDANCE_VERSION`.

**Test app:** a small `echo` service in `examples/` that registers on start, used for the end-to-end tests.

**Acceptance.** These are tests from the spec's §14:
- While a client stays connected, the example app deploys a new operation, which is discovered and invoked with unchanged outer schemas (#1).
- An older catalog is honoured or fails explicitly (#3, #4).
- Hidden operations reveal nothing (#6).
- Replay, conflict and lost-response cases pass (#9, #10, #22).
- A remote timeout reports `unknown` (#11).
- A wrong-audience or expired token is rejected (#19).
- A token replayed with changed arguments is rejected (#24).
- The legacy tools still work (#20).

### Phase 2: change feed and service connections

- The cursor-based change feed and service connections for apps.
- The callback path with delegated tokens.
- A small indexing app to exercise it, for example search over topics and memories.

### Phase 3: STC as the first real app

STC's own plan covers its database, the forgeworld host, `stcd` and the Claude launcher. On the Astropath side:

- STC registers the nine `stc.*` operations on deploy.
- Launch operations are async and return STC job handles.
- **Bounded session grants:** STC asks Astropath, through a `platform.mint_session_connection` operation, for a connection for a spawned Claude session. That connection's scopes are the intersection of the caller's and the project's, and it is minted by Astropath, never by `stcd`.
- **End-to-end acceptance**, STC's check #13: a connected agent runs `discover`, then `stc.create_project` with an `initial_prompt`, then `stc.get_session`.

### Phase 4: `execute`

- **Runtime:** QuickJS compiled to WASM (`quickjs-emscripten`), in a separate child process with rlimit and systemd memory and CPU caps. It has no host modules and no network.
- **Calls:** `api.*` calls return over IPC to `dispatch()`, so every inner call is a normal invocation with its own receipt.
- **Tables:** `ap_executions` and `ap_execution_calls`, enforcing the spec's §5.3 budgets.
- **No Node `vm`:** it is not a security boundary.
- **Alternative runtime:** Cloudflare Code Mode isolates better, but adds an external hop and a dependency.
- **Acceptance:** tests #12, #13, #14 and #21.

### Later

- **Arbites as the approval provider.** For `sensitive` operations, the dispatcher returns `APPROVAL_REQUIRED` with an `approval_request_id`, and the same invocation resumes after approval.
- **Schema-only record apps.** Shelved; see the board topic "Idea for later: schema-only record apps".

## Open decisions

1. **First app to prove the loop.** I'd use the `echo` example for the tests, then STC. Name something smaller and genuinely useful if you have one.
2. **Policy for external effects.** Should `external` operations under `auto` stay auto, or always need explicit grants? Under this plan they stay auto unless the app marks them `sensitive`.
3. **Runtime for `execute`.** Local QuickJS is my default.

## Not in scope

- A third-party marketplace.
- Running app code inside Astropath.
- Direct database access for apps.
- Semantic search.
- Distributed transactions.
- Retiring the legacy MCP tools before clients are seen to have migrated.
