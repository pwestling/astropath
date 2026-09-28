# Tenants, sharing, and privacy

Status: proposed design, September 28, 2026. The running application still uses
one workspace per installation. Tenant isolation and application-level content
encryption are not implemented. The chosen initial direction is server-held
keys, with protection against accidental access. Tenant-held keys remain an
exploratory option, not an implementation requirement.

## Chosen privacy model: server-held keys

Users trust the operator; the goal is to prevent incidental content exposure in
administration, database inspection, logs, and backups. Keep hosted connectors
and server-side processing. The application can decrypt authorized content, and
a determined operator controlling the application and keys can do so too. Do not
describe this mode as end-to-end encrypted or inaccessible to the operator.

Use envelope encryption with separate tenant data keys, wrapped by a server-held
key kept outside the content database and its backups. Version keys and ciphertext
formats so rotation and recovery are possible. Bind ciphertext to its tenant and
record context with authenticated encryption. Keep key use behind tenant/space
authorization; encrypting content does not replace those checks. Key storage and
recovery need deliberate handling; see
[OWASP's key-management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html).

The platform-admin UI exposes operational metadata without an inbox for every
tenant. Exclude content, secrets, and signed URLs from logs and error reports.
Audit privileged administrative actions. Keep decrypted previews and support
exports out of routine operational views.

Account for every plaintext derivative: titles, filenames, activity details,
notification payloads, search indexes, embeddings, and temporary upload files.
The current SQL full-text index and direct file-transfer path need explicit
changes before claiming a database or object-store dump hides content. Search
can remain server-operated, but any retained plaintext index must be separately
protected or documented as a limitation of the initial storage guarantee.

## Membership model

A human account can belong to several tenants. A tenant is the isolation boundary
and owns its spaces, connections, messages, files, agent registrations, presence,
and work history. A personal tenant has one human member; a shared tenant has
several. They use the same data model and permission checks.

For example, Porter can own **Porter Private** and belong to **Shared Project**.
Another Shared Project member has no access to Porter Private, its roster, or
its activity. Having one account in both tenants does not join their data.

| Entity | Boundary and relationship |
| --- | --- |
| Human account | Global login identity; may have many tenant memberships. |
| Tenant membership | Account, tenant, role, status, and any space restrictions. |
| Space | Belongs to exactly one tenant; its slug is unique within that tenant. |
| Connection | API/OAuth grant for exactly one tenant and a bounded set of spaces. |
| Agent/thread registration | Tenant-specific identity and visibility, even when the same local runtime participates in several tenants. |
| Device relay | Can maintain several separately authorized tenant connections and key stores. |
| Message, file, work entry, event | Belongs to exactly one tenant; related records must belong to that tenant too. |

Tenant owners manage their tenant's spaces, invitations, memberships, and app
grants. Members use the spaces they have been granted. The UI provides a tenant
switcher and shows the active tenant on composers, upload screens, and OAuth
approvals. A browser's active tenant never changes an already-issued app token.

## Platform administration

Porter is the platform administrator. That role manages tenant provisioning,
suspension, quotas, account status, and operational health across the service.
It grants no automatic membership, message/file access, impersonation, or
decryption keys. Porter accesses content through ordinary membership, including
membership in his own private tenant and any shared tenants he joins.

Keep platform administration separate from content APIs and tenant-owner checks.
Administrative views should expose only the operational metadata they need.
Record administrative changes in an audit trail. Such controls reduce accidental
or routine access, but a server operator can alter application/database code;
they cannot establish a cryptographic guarantee by themselves.

## Agent access and deliberate sharing

An agent uses a named connection such as **Porter Private / Claude** or
**Shared Project / Claude**. Each connection is pinned to its tenant and subject
to the authorizing user's current membership. The same runtime can hold both
connections when the user grants both. Resolve names, recipients, thread IDs,
searches, and event cursors within the connection's tenant.

Sharing is an explicit copy into a destination tenant, with source-read and
destination-write authorization and a visible destination. The copy includes
only the selected message, file, or authored summary. Do not implicitly include
its private thread history, progress journal, source-tenant name, or other
attachments. A source identifier in provenance must not grant access or cause
the destination UI to fetch private source metadata. Idempotency should prevent
a retried share from creating duplicate copies.

In the chosen server-held-key mode, the authorized service decrypts the source
and encrypts the selected copy for the destination. In a future tenant-held-key
mode, a trusted client/relay performs that work. Source ciphertext and keys cannot
simply be reused across unrelated tenants. A shared copy follows the destination
tenant's access and retention; deleting the source cannot recall copies already
received.

Giving one agent both credentials also lets that agent read private material and
write to the shared tenant. Cryptography cannot prevent an authorized agent from
copying what it can read. Separate agent runs/connections and an explicit sharing
policy are needed when accidental disclosure between those contexts is a concern.

## Database and request boundaries

Introduce a mandatory `tenant_id` on every tenant-owned record. Use a membership
table keyed by `(tenant_id, user_id)` rather than putting one tenant on a user.
Use composite uniqueness and foreign keys so a message cannot reference another
tenant's space, parent, attachment, thread, or delivery, even when IDs are known.
Connection names and space slugs should be unique within a tenant.

Derive the tenant from an authenticated session selection or the stored app grant;
a client-supplied tenant ID is never sufficient authorization. Check membership
on every request and recheck it during long waits/streams. Scope lists, counts,
search, receipts, invitations, file reservation/completion/download, OAuth
approval/refresh, event replay, and background jobs as well as individual reads.
An inaccessible ID should not reveal whether it exists in another tenant.

Use explicit tenant-aware data access with PostgreSQL row-level security as
defense in depth. The runtime role must not be a superuser or have `BYPASSRLS`;
use forced policies where it owns tables, and keep migration privileges separate.
Set request context on a checked-out transaction, never on a pooled connection
that can leak its settings to the next tenant. These constraints follow
[PostgreSQL's RLS behavior](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

New object keys should include an opaque tenant ID and random file ID. Access
checks happen before signing any URL. Old objects can retain their pathnames
while their metadata is assigned to the original tenant; moving all bytes is
unnecessary. Already-issued download URLs retain their short expiry.

## Exploratory alternative: tenant-held keys

For that claim, encrypt content before it reaches Astropath, with decryption
keys held only by authorized tenant clients/relays. The service stores ciphertext
and encrypted key envelopes. Content includes titles, bodies, filenames,
attachments, work summaries, and sensitive presence descriptions—not just file
bytes. Routing, sizes, timing, IP addresses, and some membership/usage metadata
will still be visible unless the design specifically hides them.

Server-held encryption keys, including a KMS the running server may use, do not
meet this goal: the application still has a path to plaintext. Encryption must
match the threat being addressed, as described in
[OWASP's storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html).

Selective space access requires separate space/content keys and explicit device
enrollment. A single key handed to every tenant member would defeat space
restrictions. Existing authorized devices must approve new key recipients; a
platform-admin database edit alone must not add a decrypting device. Design
membership removal, key rotation, history access for new members, and encrypted
backup/recovery together using reviewed cryptographic components. Removal can
stop future access but cannot erase plaintext or keys already copied.

Password reset and account recovery must be separate from content-key recovery.
Users need another trusted device or their own recovery material. An operator
who can recover every content key can also read the content.

A web client served by the same operator still trusts the code delivered on each
visit: modified JavaScript could capture plaintext after unlock. A stronger
claim against an actively malicious operator requires a tenant-controlled client
or relay and a considered software-update trust model. Running that relay under
the operator's root account on the same VPS does not create this separation.

## Consequences of tenant-held keys for existing features

The current remote MCP server receives and returns plaintext. In a tenant-held
key design, a trusted client or tenant-operated MCP gateway performs decryption
and tool execution; the central service routes/stores encrypted records. Native
hosted connectors cannot gain this guarantee merely by adding encryption to the
database. A tenant gateway's hosting, reachability, and authentication need an
end-to-end test with the intended AI clients.

Full-text search, embeddings, previews, and automatic summaries run where the
keys live. A central plaintext search index would disclose the same content the
encryption is intended to protect. Models chosen by the tenant still receive
the plaintext provided to them; this protects against the Astropath operator,
not an authorized AI provider or recipient.

## Where PAKE and agent relays could fit

OPAQUE is a password-authenticated key-exchange protocol described in
[RFC 9807](https://www.rfc-editor.org/rfc/rfc9807.html). Its client and server
share an authenticated session secret, while the client also recovers an export
key unavailable to the server during normal protocol operation. Applications can
use that export key for protected client data; see
[the export-key guidance](https://www.rfc-editor.org/rfc/rfc9807.html#section-10.4).
The shared session secret is not an operator-inaccessible content key. Server
compromise still permits password-guessing attacks, and trusted client code is
still required.

One possible design uses client recovery of an encrypted account key, followed
by access to separately wrapped tenant/space keys. Members do not share a login
password. Each member/device receives the authorized keys through authenticated
enrollment. PAKE would address password-based unlocking; invitations, membership
changes, device enrollment, and group-key distribution remain separate problems.

For unattended agents, a relay could hold an enrolled device key in a protected
local credential store and decrypt/encrypt through its tools. A human unlocks or
enrolls it once; it does not require the language model to perform cryptography
or remember the user's password on each run. The relay's host and update path
become part of the trusted boundary. PAKE is optional for that design: existing
device approval or a high-entropy one-time enrollment mechanism could provision
the device without replacing the application's login protocol.

Do not embed raw keys or recovery secrets in skills, prompts, or agent memory.
Those are instruction/context distribution surfaces, can be copied into provider
logs or shared contexts, and are hard to revoke reliably. A skill should identify
a local relay/profile and its tools. The implementation retrieves the key from
its credential store without including it in model-visible tool results. The
agent will still see the plaintext it is authorized to process.

This alternative is feasible, but its major costs are device lifecycle, shared
tenant membership, revocation/rotation, recovery, client trust, and gateway
availability. PAKE alone does not remove those costs.

## Implementation order and acceptance criteria

1. Build tenants, many-to-many memberships, the tenant switcher, tenant-bound
   credentials, and a separate platform administration surface. Preserve the
   existing workspace and its invited members as one initial tenant.
2. Test two tenants with the same space/connection names and overlapping human
   memberships. Verify all read/write, file, invitation, search, OAuth, and event
   paths reject cross-tenant access; verify tenant switching never broadens an
   existing app credential. Platform-admin status alone must fail content access.
3. Add deliberate sharing with independent source/destination authorization and
   retry behavior. Include tests for removed membership and partial file uploads.
4. Implement the chosen server-held envelope encryption with key rotation,
   recovery, and coverage of content derivatives. Existing plaintext data/backups
   need an explicit migration/retention plan; encryption cannot undo earlier
   access. Preserve normal hosted connector behavior and state the operator
   trust boundary accurately.
5. Apply the same tenant and key boundaries to presence, delivery relays, and the
   progress-note/KB features as they are implemented.

Tenant-held keys and PAKE are future exploration. They do not block the initial
tenant-isolation and server-held-key implementation.
