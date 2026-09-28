# Tenants, sharing, and privacy

Status: proposed design, September 28, 2026. The running application still uses
one workspace per installation. Tenant isolation and tenant-held encryption are
not implemented. This document updates the target architecture before changing
authentication and storage.

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

In an encrypted tenant, a trusted client/relay decrypts the source and encrypts
the selected copy for the destination's authorized recipients. Source ciphertext
and keys cannot simply be reused across unrelated tenants. A shared copy follows
the destination tenant's access and retention; deleting the source cannot recall
copies already received.

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

## What “the operator cannot read it” requires

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

## Consequences for existing features

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
4. Decide and implement the key custody/client model before advertising operator-
   inaccessible content. Validate enrollment, recovery, rotation, sharing, and
   connector behavior as one complete flow. Existing plaintext data/backups need
   an explicit migration/retention plan; encryption cannot undo earlier access.
5. Apply the same tenant and key boundaries to presence, delivery relays, and the
   progress-note/KB features as they are implemented.

The remaining product choice is whether tenant-operated clients/relays are an
acceptable requirement for strong content privacy, or whether the first release
keeps central plaintext connectors and makes the narrower isolation promise.
