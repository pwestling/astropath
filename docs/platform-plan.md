# Tool platform: implementation plan

Status: plan for review, 2026-10-03. Nothing here is built yet.

Sources:

- "Astropath Tool Platform and App Integration Specification — Proposed v1" (board topic `19371e3e`), called **the spec** below.
- The STC spec (`cb65dd4a`, revised reply `5f816d31`), which makes STC the first real app.
- The Arbites spec (`b983bf72`), which supplies approval behind `approval_required`.
- `../stc/docs/implementation-plan.md`, which already treats this registry and dispatcher as STC's prerequisite.

## What we are building

Agents keep one Astropath connection. That connection gains three fixed tools: `discover`, `invoke` and `execute`. Apps register versioned operations in a registry. Publishing a new tool means activating a new operation. Connected agents then see it through `discover` and call it through `invoke`, with no new MCP tool, no reconnect and no client restart. Apps' UIs call the same operations over HTTP.

## Where the spec meets the current code

| Spec assumes | Astropath today | Plan |
| --- | --- | --- |
| Python backend and handlers | Next.js 16 and TypeScript, Zod 4 schemas, `pg`, PGlite tests | Write handlers in TypeScript. Generate JSON Schema from the Zod source with `z.toJSONSchema`. The STC plan already agrees. |
| `astropath:read` and `astropath:write` scopes | The same two scopes, stored in `ap_connections.scopes text[]`, with optional `spaces text[]` | Reuse `scopes` for app permissions such as `stc:launch`. The two existing scopes map only to `core.*` operations and never cover new apps. |
| Tenant and space | Tenants with RLS and per-tenant AES keys; spaces | Invocations, jobs and outbox rows are tenant-scoped under RLS. Stored arguments and results use the tenant key, as messages do. |
| Idempotency | `ap_messages` already enforces principal-scoped keys with a request hash and a conflict on mismatch | Generalise this into one invocation ledger. |
| A registry of installable packages | ~33 hand-registered MCP tools in `src/lib/mcp.ts` | Add a registry beside them. The legacy tools keep working. |
| Workers and an outbox | None. Projects generation runs inline. | Add a Postgres job and outbox table, plus a worker process from the same release. |

## Deliberate simplifications (flag if you disagree)

1. **Apps are code, and installing one is a deploy.** The registry is built at boot from app modules in this repo, such as `src/apps/<id>/`. "Prepare" is the existing migrate step and "activate" is the release switch.
   - This meets the spec's rule that registering metadata never runs code.
   - The deviation is that there is no runtime upload of app packages and no admin `POST /admin/v1/apps/...` API in v1.
   - Remote apps are the exception: they register a binding to a service that has its own deploy.
2. **Catalog revision is a content hash of the active contract set.** Each new revision is persisted in `ap_catalog_snapshots` when the server boots, so receipts can cite it.
   - An invocation against an older revision succeeds if that exact `operation@version` still exists with the same contract hash. Otherwise it fails with `CATALOG_EXPIRED`.
   - Old versions are retained by leaving them defined in code, not by serving 30-day snapshots. In practice this gives the same guarantees: no silent substitution, and explicit expiry.
3. **Discovery search runs in memory.** It uses exact names, aliases and token ranking over the in-memory registry. That is enough for hundreds of operations. Postgres full-text search can come later.
4. **`execute` ships as a fixed schema that returns `NOT_AVAILABLE`.** The spec permits this. The sandbox is phase 5.
5. **One owner per tenant.** Grants are per connection, plus an optional owner auto-grant per app. There is no multi-party policy engine; Arbites adds approvals later.

## Phases

### Phase 1: registry, dispatcher and receipts (the core)

**`src/platform/`**

- `defineOperation({ name, version, summary, input, output, effect, execution, permissions, idempotency, examples, handler })`, where `input` and `output` are Zod schemas.
- `defineApp({ id, release, description, permissions, operations, ui })`.

**Registry validation at boot.** The server refuses to start, and tests fail, on any of:

- a bad name pattern, or a reserved word (`then`, `constructor`, `prototype`, `__proto__`, or the `platform` namespace);
- duplicate `operation@version` pairs;
- a schema that does not convert to self-contained JSON Schema;
- a contract over 32 KiB;
- an example that does not validate;
- a namespace not owned by its app.

**Dispatcher (`dispatch(principal, request)`)** steps:

1. Resolve the exact binding.
2. Check the grant: the connection's scopes must include each `required_permission`, and the space must be allowed.
3. Validate strictly: no coercion, no defaults, unknown keys rejected, duplicate JSON keys and non-finite numbers rejected.
4. Hash the arguments as SHA-256 of their JCS canonical form.
5. Reserve the invocation in its own committed transaction.
6. Run the handler in a transaction that also finalises the receipt, validating output before commit.
7. Shape the result into the receipt and error envelope from spec §4.4: `effect_state` and `retry_advice`.

**New tables:**

- `ap_catalog_snapshots`
- `ap_invocations`, unique on (tenant, principal, space, operation, version, idempotency_key), with the args hash, status, attempt fence, and encrypted args and result

**Operations and routes:**

- `platform.get_receipt`.
- HTTP `POST /api/v1/discover`, `/invoke` and `/execute`, and `GET /api/v1/invocations/{id}`.
- MCP `discover`, `invoke` and `execute`, returning `structuredContent` plus a short text form, with `isError` on failure.

**Core operations.** Register `core.*` operations (memory, board, files, skills) whose handlers call the same store functions the legacy tools use. That gives equivalence without a rewrite. Legacy tools can move onto `dispatch()` later.

**Console: Apps view.**

- Installed apps and their operations, with the JSON Schema shown.
- Per-connection grant toggles, which edit `ap_connections.scopes`.
- Recent receipts.

**Housekeeping:** update `llms.txt` and the guidance template, and bump `GUIDANCE_VERSION` so agents learn to call `discover`.

**Acceptance (from spec §14):**

- Add an operation in a deploy while a client stays connected; it is discovered and invoked with the outer schemas unchanged (#1).
- An old catalog is honoured or fails explicitly (#3, #4).
- A hidden operation reveals nothing (#6).
- The idempotency replay, conflict and lost-response cases pass (#9, #10, #22).
- The legacy tools still pass (#20).

**Size:** the bulk of the work, about 1.5–2k lines including tests.

### Phase 2: jobs, outbox and a worker

- Tables `ap_jobs` (lease plus a monotonic fencing generation) and `ap_outbox`.
- Async operations return `accepted` with a job handle. Add `platform.get_job` and `platform.cancel_job`.
- Add an `astropath-worker` systemd unit, in the vps repo, that runs `node worker.js` from the current release.
  - It claims jobs with `FOR UPDATE SKIP LOCKED`, renews leases, re-authorises before effects and delivers outbox events.
- Move Projects generation onto it, as a real first user that is not on STC's critical path.
- Acceptance: #8, #17 and #23.

### Phase 3: remote apps and delegated tokens (what STC needs for `stcd`)

- Service bindings live in deployment config (NixOS env or SOPS), never in a manifest: the service ID, origin, route templates and timeouts.
- Signed, audience-bound delegated tokens valid for at most 60 s, with the claims from spec §8 including the args hash and idempotency digest. Use an Ed25519 signing key in SOPS and publish a JWKS route for backends.
- The adapter refuses redirects and origin changes and never forwards caller credentials. It maps a downstream timeout to `unknown`, plus reconciliation.
- Acceptance: #11, #19 and #24.

### Phase 4: STC as the first app

STC's own plan covers the forgeworld host, `stcd` and the Claude launcher. On the Astropath side:

- An `src/apps/stc/` module with project, workspace and session tables and the nine `stc.*` operations.
  - The launch and stop operations are async jobs that the worker hands to `stcd` through the phase-3 adapter.
- A small STC view in the Console.
- Bounded session grants for spawned Claude sessions: a new connection whose scopes are the intersection of the caller's and the project's scope. These are minted by the dispatcher, never by `stcd`.
- The end-to-end acceptance is STC's #13: a connected agent runs discover, then `stc.create_project` with `initial_prompt`, then `stc.get_session`.

### Phase 5: `execute`

- Use QuickJS compiled to WASM (`quickjs-emscripten`) in a separate child process with an rlimit and systemd memory and CPU caps.
- It gets no host modules and no network. `api.*` callbacks go back over IPC to `dispatch()`, so every inner call is a normal invocation.
- An execution ledger lives in `ap_executions` and `ap_execution_calls`, enforcing the spec §5.3 budgets.
- Node `vm` is not used; the spec is right that it is not a security boundary.
- Cloudflare Code Mode is the alternative. It isolates better, but adds an external hop and an external dependency.
- Acceptance: #12, #13, #14 and #21.

### Phase 6: schema-only "record apps", so agents can publish tools themselves

This is the only path where publishing a tool needs no deploy, which is likely the long-run "share new tools to the agent net" experience.

- An agent submits a manifest of record collections: a JSON Schema per collection, plus permissions and indexes.
- It lands as a pending app. You approve it in the Console.
- The platform then generates `app.create_x`, `get_x`, `list_x`, `update_x` (optimistic `expected_version`) and `archive_x` over a shared, RLS-protected `ap_app_records(app, collection, id, version, data jsonb)` table.
- No code runs. Grants are still explicit. Anything with real behaviour (side effects, state machines) graduates to a code app.

### Later, in parallel

- **Arbites approval provider:** the dispatcher returns `APPROVAL_REQUIRED` with `approval_request_id`, and the same invocation resumes after approval.
- Moving the skills UI and other features into app modules (spec phase 4).

## Decisions I need from you

1. **First app to prove the loop.** STC is the stated first app, but it also needs the forgeworld host, `stcd` and the Claude adapter proof. I'd prove phases 1–2 with a tiny local app first: for example a `notes` record app, or a genuinely useful small tool you name. STC then lands on a working platform rather than co-developing with it.
2. **Who can publish tools.** Option A: only you, via code in this repo (phases 1–4). Option B: agents can also propose schema-only record apps for your one-click approval (phase 6). Phase 6 is cheap once phase 1 exists.
3. **Grant default for new apps.** Should a newly deployed app's operations be granted to existing connections automatically (owner auto-grant per app), or only by toggling them in the Console? The spec defaults to explicit grants.
4. **`execute` runtime.** Local QuickJS is my default; Cloudflare is the alternative.

## Not in scope

- A third-party marketplace.
- Running untrusted code in-process.
- Semantic search.
- Distributed transactions.
- A generic UI generated from every schema.
- Retiring the legacy MCP tools before clients are seen to have migrated.
