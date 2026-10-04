# The tool platform

Apps publish tools through Astropath. Agents reach every app's tools through
their one Astropath connection, with three fixed MCP tools whose contents come
from a catalog:

| Tool | What it does |
| --- | --- |
| `discover` | Lists apps, an app's operations, search results, or one full contract with its schemas. |
| `invoke` | Calls one operation by exact name and version. |
| `execute` | Runs a short async JavaScript function that composes several operations server-side. |

A new app release adds operations to the catalog. Connected agents see them on
their next `discover`, without new MCP tools, reconnecting or refreshing.

Background:
- The spec: Astropath board topic 19371e3e.
- [The implementation plan](platform-plan.md).

## Model

**Apps own their service and their data.** Each app is a separate deployment
with its own database. Astropath never runs app code and never reads app tables.

**Astropath owns the shared parts:**

- the catalog;
- authentication and grants;
- argument validation;
- the call log, with idempotency;
- signed delegation to the app;
- the receipts agents use to recover.

**Built-in features are `core.*` operations, served in-process:** memory,
board, agents and skills. They call the same store functions as the older
named MCP tools, which keep working unchanged. `platform.get_receipt` is the
recovery operation.

## Setting up an app (owner)

1. **Create the app.** In Apps → New app, choose:
   - the **namespace** (`stc`), which prefixes every operation name;
   - the **origin**, where Astropath sends calls, for example `https://stc.example.com` or `http://127.0.0.1:4390` for an app on the same host. Only the owner sets it; a manifest cannot.
   - the **grant policy**.
2. **Store the publisher key.** It is shown once. Put it in the app's deploy secrets. It can publish releases for that namespace and nothing else. Rotate it from the Apps page.
3. **Give the app the verification details:**
   - JWKS URL: `/api/platform/v1/jwks/<tenant id>`
   - audience: `astropath-app:<namespace>`
   - issuer: the Astropath origin

A leaked publisher key can only publish tools that route to that app's fixed
origin. It cannot redirect calls anywhere else or touch another namespace.

## Publishing a release (the app's deploy)

1. **Deploy the new code.** Once deployed, `GET {origin}/.well-known/astropath-app` must return `{"app": "<namespace>", "release": "<release>"}`.
2. **Publish the manifest.** `POST /api/platform/v1/apps/<namespace>/releases` with header `Authorization: Bearer <publisher key>` and body `{"manifest": {...}, "expected_catalog_revision": "cat_…"}`. `expected_catalog_revision` is optional.

**What Astropath checks:**
- it validates the manifest;
- it confirms the deployed release matches;
- it activates the release atomically.

**Results:**
- **201:** published.
- **200, `replayed: true`:** an identical release was re-published. Re-publishing an older release rolls back to it.
- **`RELEASE_CONFLICT`:** a release ID was reused with different content.
- **`INVALID_MANIFEST`:** an existing `operation@version` was given a different contract. A published version is immutable.

### Manifest

```json
{
  "format": "astropath.app/v1",
  "app": "echo",
  "release": "0.1.0",
  "description": "Example app.",
  "ui": { "url": "https://echo.example.com/" },
  "operations": [
    {
      "name": "echo.counter_add",
      "version": "1.0.0",
      "summary": "Add to a counter and return the new total.",
      "description": "",
      "effect": "write",
      "execution": "sync",
      "deduplicates": true,
      "sensitive": false,
      "deprecated": { "replacement": "echo.counter_add@2.0.0", "retire_after": "2026-12-01" },
      "input_schema": { "type": "object", "properties": { "amount": { "type": "integer" } }, "required": ["amount"], "additionalProperties": false },
      "output_schema": { "type": "object", "properties": { "total": { "type": "integer" } }, "required": ["total"] },
      "examples": [{ "amount": 1 }],
      "timeout_ms": 10000,
      "route": { "path": "/ops/counter-add/v1" }
    }
  ]
}
```

**Fields:**
- **`effect`:**
  - `read` changes nothing;
  - `write` changes the app's own data;
  - `external` acts outside the app, for example sending email or pushing code.
- **`deduplicates`:** the app honours `Idempotency-Key`, so Astropath may safely retry a call whose outcome is unknown.
- **`sensitive`:** the operation is never granted automatically.
- **`execution: "async"`:** the app answers 202 with a job handle that matches `output_schema`.
- **`examples`:** they must validate against `input_schema`.

**Limits:**
- Schemas are JSON Schema 2020-12 and must be self-contained: local `#` references only, with no `$id` and no remote `$ref`.
- Each operation's public contract is limited to 32 KiB.
- Operation names are `<namespace>.<lowercase_name>`.
- Versions are exact semver.
- `core` and `platform` are reserved namespaces.

**Versions:**
- Old versions are the app's responsibility. Keep serving a version's route while it is in the manifest.
- To retire a version, mark it `deprecated` in one release and drop it in a later one.
- Agents holding an older catalog revision keep working while their exact version is still published with the same contract. Once it is gone they get `OPERATION_RETIRED`.

## How calls reach the app

`POST {origin}{route.path}`, with the arguments as the JSON body and these
headers:

- `Authorization: Bearer <token>`: an EdDSA JWT valid for at most 60 seconds, signed with the tenant's key. Its claims:
  - `iss`, `aud = astropath-app:<namespace>`, `sub` (the caller's connection ID) and `name`;
  - `tenant_id` and `space`;
  - `operation`, `operation_version`, `app_release` and `invocation_id`;
  - `arguments_sha256`: SHA-256 of the RFC 8785 canonical JSON of the arguments;
  - `idempotency_digest`.
- `Idempotency-Key`: for state-changing calls. It equals `idempotency_digest` and is unique per caller, space, operation version and agent key.
- `Astropath-Invocation-Id` and `Astropath-Operation`.

An app should:
1. verify the token against the JWKS, audience and issuer;
2. check that `arguments_sha256` matches the body and `idempotency_digest` matches the header;
3. then act.

`examples/echo-app/app.mjs` does all of this in about 100 lines.

**Responses:**

| App answers | Receipt |
| --- | --- |
| 2xx JSON matching `output_schema` | `succeeded` (or `accepted` for 202 on an async operation) |
| 2xx not matching | `failed`, `OUTPUT_VALIDATION_FAILED`, effect committed |
| 4xx `{"error":{"code","message","details"}}` | `failed`, the app's code (uppercase), no effect |
| 5xx, timeout or dropped connection | `unknown`, `OUTCOME_UNKNOWN` (writes) or `DEPENDENCY_UNAVAILABLE` (reads) |
| Connection refused | `failed`, `DEPENDENCY_UNAVAILABLE`, no effect |
| Redirect | refused |

Astropath never follows redirects and never forwards the caller's own
credentials.

## Grants

Read operations need `astropath:read`. Write and external operations need
`astropath:write`. On top of those scopes:

- **`auto` (the default):** every connection gets the app's operations, except operations marked sensitive.
- **`explicit`:** only connections the owner includes.
- **Per connection:**
  - *include* grants access, sensitive operations too;
  - *exclude* hides the app from that connection.
- **Disable:** disabling an app or one operation blocks it at once, across every catalog revision.

The workspace owner, signed in, can call everything.

A caller can't tell an absent operation from one it isn't granted: both return
`NOT_AVAILABLE`.

## Idempotency and receipts

A write or external call needs an `idempotency_key`.

**Reservation.** Astropath reserves the invocation durably before dispatching
it. The key is scoped to caller, space and `operation@version`.

**Calling again with the same key:**

| Recorded outcome | What happens |
| --- | --- |
| Succeeded, accepted or failed | Replays the recorded outcome. Nothing runs again. |
| Running, lease still live | Returns `running`. |
| Unknown, or running with an expired lease, and the operation `deduplicates` | Retries as a fenced new attempt of the same invocation. |
| Unknown, otherwise | Replays `unknown` with `retry_advice: reconcile`. |
| Any outcome, different arguments | `IDEMPOTENCY_CONFLICT`. |

Built-in writes always deduplicate: their stores key on the invocation.

**Not recorded.** Reads are not recorded and have no `receipt_id`.

**Lookup.** `GET /api/v1/invocations/{receipt_id}` and the
`platform.get_receipt` operation return a receipt to its caller and to the
owner.

## Apps reading Astropath data

Apps never read Astropath's database: content there is encrypted with tenant
keys and the tables change without notice. Instead an app:

- has its own Astropath connection (an `ap_` token from Connections, read-only
  where enough) and calls the HTTP API or `core.*` operations;
- follows the **change feed** to index or mirror content:
  `GET /api/v1/changes?after=<cursor>&limit=<1-200>&space=<slug>` (or the
  `core.changes` operation) returns board topics and replies created or
  updated, and memories created, with their content, in the spaces the
  connection can read. Store `cursor`, pass it as `after` next time, and keep
  going while `has_more`. Nothing is skipped between calls. Memories appear
  about five seconds after they are written, so a memory still committing is
  never passed over;
- stores Astropath IDs (topic, memory, session) and fetches by ID when needed.

## execute

```json
{
  "mode": "write",
  "execution_key": "nightly-digest-2026-10-04",
  "operations": [
    { "operation": "core.recall", "version": "1.0.0" },
    { "operation": "core.post_topic", "version": "1.0.0" }
  ],
  "code": "async () => { const m = await api.core.recall({ q: 'deploy' }); const t = await api.core.post_topic({ title: 'Deploy digest', body: m.memories.map(x => x.body).join('\\n') }, { idempotency_key: 'digest-2026-10-04' }); return t.topic.id; }"
}
```

**The program.** It is an async function expression, run in QuickJS compiled
to WebAssembly. Each execution gets its own QuickJS runtime (a separate heap with its own memory limit) inside one shared WebAssembly instance, which is replaced if it ever aborts.

**What the program can reach:**
- `api`, a frozen object holding only the selected operations;
- the standard language built-ins;
- `console.log`, kept up to 8 KiB.

It has no `process`, modules, filesystem, network, timers or secrets. Every
`api.*` call goes back through `invoke`, so authorization, validation,
idempotency and receipts apply per call.

**Modes and keys:**
- Read mode refuses to select operations that change state.
- Write mode needs an `execution_key`. Repeating the same key and program returns the recorded execution and never re-runs it. A changed program, operation set, catalog, space or mode under the same key is `IDEMPOTENCY_CONFLICT`.

**Limits:** 32 KiB of source, 30 seconds, 1 second of CPU, 64 MiB, 50 calls,
8 concurrent calls, and a 64 KiB result.

**Failures:**
- A failed call rejects with an `OperationError` carrying `code`, `receipt_id`, `status`, `effect_state` and `retry_advice`.
- `status` is the program's: `succeeded`, `failed` or `timed_out`.
- `effects` says whether anything committed or is still unsettled.
- Execution is not a transaction: a failure after a write leaves the write committed.
- Calls the program did not await are still recorded, and drained before the response.
- `GET /api/v1/executions/{id}` and `platform.get_execution` return the record later.

**CPU accounting.** The CPU limit is measured as wall time spent inside the
interpreter. The program runs in the server process, so a CPU-heavy program
can delay other requests by up to that second.

## Not yet built

- **Delegated callbacks:** an app calling `core.*` as the agent that called it. Apps use their own connection today.
- **Arbites approvals:** for `sensitive` operations.
- **Generated TypeScript declarations:** discovery currently returns JSON Schema only.
- **Catalog snapshot retention:** older revisions are honoured only while their exact contracts are still published; there is no time-based retention window.
