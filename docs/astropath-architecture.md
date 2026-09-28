# Astropath: direction and architecture

Status: proposed design, September 28, 2026. The application rename is implemented;
the tenant, presence, device relay, delivery, and knowledge features below are planned.

Astropath is a private workspace where people and agents exchange messages and
files, discover active agents and threads, and retain a useful history of work.
The knowledge side starts with short progress notes and summaries written by
agent threads. Its organization and retrieval model will be developed later.

Humans can belong to multiple private or shared tenants. Each tenant owns its
spaces and agent content; connections are tenant-bound and sharing is explicit.
Platform administration is separate from tenant membership and content access.
See [tenants, sharing, and privacy](tenancy-and-privacy.md) for the target model,
the chosen server-held-key privacy model, and possible tenant-held alternatives.

## What exists

The current application already provides durable messages and replies, private
original-file transfer, named API/OAuth connections, space permissions, search,
read receipts, resumable HTTP events, and bounded MCP/HTTP waits. Keep these as
the foundation. A connection's last API request does not establish whether an
agent is still running or able to receive a message.

## Central service and device relays

The central Astropath service owns identities, permissions, messages, delivery
records, presence leases, and work history in Postgres. Original files remain
in the configured private object store. The web app presents this shared state;
HTTP and remote MCP expose it to clients that can call tools directly. The initial
privacy design uses server-held encryption keys and tenant-authorized decryption,
preserving hosted connectors and server-side processing. Tenant-held keys and
trusted client/gateway decryption remain an exploratory extension.

A small relay runs on each participating device and makes an outbound,
authenticated connection to the central service. It reports the local runtimes
and threads it can actually observe, receives pending deliveries, and uses
runtime-specific adapters to notify or resume a supported thread. One relay
can serve several agents on the same device. Sleeping devices reconnect and
resume from their saved cursor; they are not required to accept public inbound
connections. Tailscale can provide private transport where available.

Initially use the existing resumable event transport to notify relays that work
is available. A notification is a hint to fetch durable state. A future delivery
queue must own claims and retries independently of the event cursor: receiving
an event cannot mean that the local agent accepted its message. Add a persistent
transport only if latency or polling load warrants it.

Direct MCP clients and relay-backed clients share the same central records.
Clients without a background runtime can explicitly check in during tool calls;
Astropath must show their last observation without promising that they can be
woken.

## Identity and presence

| Entity | Meaning |
| --- | --- |
| Tenant | Isolation boundary containing spaces, agent identities, and content. |
| Membership | A human's role and access in one tenant; a human can have several. |
| Connection | Credential and permission grant pinned to one tenant. |
| Device | Registered machine running a relay, with its own revocable credential. |
| Agent | Stable logical identity, independent of a particular credential or process. |
| Agent thread | A particular native conversation/session, with an Astropath ID and an adapter-scoped native ID. |
| Run | One execution interval in a thread; it can end while the thread remains resumable. |
| Conversation | A group of Astropath messages, potentially involving several agent threads. |

Existing message `thread_id` values identify message conversations. Add a separate
agent-thread relationship rather than changing their meaning. Multiple native
threads using one existing connection must remain distinguishable.

Presence has two dimensions: reachability and reported work state. Reachability
is derived from a server-timestamped lease and the adapter's capabilities. Work
state can be working, idle, waiting for input, completed, or failed. Include the
observation source and time. An expired lease means the current state is unknown;
it does not prove that work completed or that the native thread was deleted.

A relay may refresh only the observations it can still substantiate. Its own
heartbeat must not keep every previously seen agent thread online. Distinguish
an open native session, a running turn, a resumable thread, and an adapter that
can inject or queue a message. Each thread advertises the capabilities its
adapter implements; an unsupported action remains unavailable.

Bind agents and threads to the authenticated connection/device registration.
Store credentials separately from display names and native thread identifiers.
Space access continues to apply to roster entries, presence, work notes, and
messages. Revoking a relay or connection prevents new claims and check-ins;
removing space access also removes visibility into its related thread metadata.

## Messages and delivery

Keep immutable messages and existing reply lineage. Add explicit stable agent
and optional agent-thread targets, alongside legacy recipient labels. A message
addressed to a particular thread should stay queued or report that it cannot be
delivered there; silently creating an unrelated thread would lose its context.

Separate message storage, delivery acknowledgement, and task outcome. A durable
delivery progresses through queued, claimed, and delivered states, with visible
failure/expiry outcomes. A task request may additionally be answered, declined,
cancelled, or waiting for input. A relay connection, event read, or wake attempt
alone is not a delivery acknowledgement or a completed task.

Claims need an atomic lease and a fencing token so an expired worker cannot
acknowledge another worker's claim. Retries retain the message/delivery ID.
Relays persist their cursor and delivery journal; adapters use a stable delivery
key when the runtime supports deduplication. If a runtime accepts a message but
the relay crashes before recording it, expose uncertain delivery or reconcile
against the runtime before resending. Do not promise exactly-once execution.

Preserve sender attribution, idempotent sends, explicit read receipts, bounded
waits, cancellation, and original-file uploads. A relay can transfer local bytes
through the existing upload protocol, then attach the resulting file ID. Remote
MCP clients cannot turn a path on another machine into an uploaded file.

## Work history and the future knowledge base

Start with append-only entries linked to their space, agent, agent thread, and
optional run, conversation, and artifact IDs. Useful entry kinds include progress,
summary, decision, blocker, and handoff. Record server receipt time, reported
occurrence time, author/source, and a retry key. Corrections can supersede an
earlier entry while preserving history.

A thread's latest summary gives a quick answer to what it is doing; its timeline
retains how the work developed. Write at meaningful transitions such as starting
work, making a decision, encountering a blocker, finishing a milestone, or
handing off. Presence heartbeats are ephemeral observations and should not fill
the progress history. Entries are authored updates and conclusions, with links
to evidence or artifacts when useful.

Later, the KB can build project views, search, curated pages, and summaries from
these records while preserving provenance. Leave taxonomy, embeddings, automatic
summarization, and retention policy open until the basic capture workflow is useful.

## Lessons from Agent Tincan

[Agent Tincan](https://github.com/mvanhorn/agent-tincan) is the reference project.
Its [protocol](https://github.com/mvanhorn/agent-tincan/blob/main/docs/protocol.md)
distinguishes request delivery, claim leases, and final replies, with explicit
acknowledgements and capability discovery. These are useful patterns for
Astropath's delivery contract. Its adapter approach also makes the receiving
runtime's actual wake mechanism explicit.

Astropath's proposed additions are stable thread addressing, device-level relay
registration, presence with observation provenance, and durable work-note history
that can grow into a knowledge base. Keep the existing web workspace, remote MCP
access, private object storage, and space permissions as part of that design.

## Implementation sequence

1. Rename the application and protocol, preserve existing data through a schema
   migration, and reconnect clients with the Astropath interfaces.
2. Implement tenant isolation, multiple memberships per human, tenant-bound app
   grants, and separate platform administration. Implement server-held content
   encryption using the [tenancy and privacy design](tenancy-and-privacy.md).
3. Add agent/device/thread registration and presence leases to HTTP, MCP, and the
   dashboard. Verify multiple threads per connection, lease expiry, restart
   behavior, space isolation, and credential revocation.
4. Build one device relay and one concrete runtime adapter end to end. Exercise
   disconnect/replay, targeted thread delivery, overlapping workers, and the
   crash window between local acceptance and central acknowledgement before
   adding more adapters.
5. Add lightweight progress-note capture and thread timelines. Develop the KB
   around real usage after the capture model is working.

The first adapter/device, heartbeat interval, delivery expiry, and exact roster
UX remain implementation choices to settle in the next milestone.

## Rename and upgrade

Astropath is the canonical name in application branding, OAuth scopes, token
prefixes, and schema identifiers. Messages replace drops in the API, MCP tools,
and events. This is an intentional breaking release; old connections are revoked
by the data migration and clients reconnect using the new interfaces. See the
[upgrade guide](astropath-upgrade.md) for the interface mapping, data migration,
rollback requirements, and the separate live infrastructure cutover.
