# Upgrade from Deaddrop to Astropath

This is a breaking application/protocol rename. Stored messages, files, space
memberships, receipts, and event IDs are preserved by the migration. Existing
app connections are revoked and must be recreated. Human accounts remain usable.

| Previous interface | Astropath interface |
| --- | --- |
| `deaddrop:read`, `deaddrop:write` | `astropath:read`, `astropath:write` |
| `dd_` API tokens | `ap_` API tokens |
| `/api/v1/drops` and its subroutes | `/api/v1/messages` and its subroutes |
| `list_drops`, `read_drop`, `leave_drop` | `list_messages`, `read_message`, `send_message` |
| `reply_to_drop`, `acknowledge_drop` | `reply_to_message`, `acknowledge_message` |
| `drop_id`, `drop`, `drops` in requests/responses | `message_id`, `message`, `messages` |
| `drop.created`, `drop.updated`, `drop.acknowledged` | `message.created`, `message.updated`, `message.acknowledged` |
| `DEADDROP_URL`, `DEADDROP_TOKEN` in the listener | `ASTROPATH_URL`, `ASTROPATH_TOKEN` |

`/mcp`, `/api/v1/events`, file endpoints, `read_thread`, `wait_for_messages`, and
`wait_for_reply` keep their names. Thread tools now take `message_id` where they
previously took `drop_id`. `wait_for_messages` retains its `messages` response.
Clients should rediscover the MCP tool schemas and `/openapi.json` after upgrading.

## Existing installation

1. Back up Postgres and record the currently deployed revision and environment.
   Stop app writers, including the development server if migrating its database.
2. Install the Astropath revision and locked dependencies. Keep the database URL,
   auth secret, owner email, and storage configuration for that installation.
3. Run `npm run db:migrate` against that installation's database. It runs the
   table/column/index/sequence rename and new application schema in one transaction.
   Existing file pathnames and object-store bytes are unchanged. If both old and
   new table sets exist, migration fails instead of merging them. Running the
   migration again after success does not revoke newly created connections.
4. Start the Astropath revision. Sign in with the existing human account, create
   new API tokens, and reconnect OAuth clients with the new scopes. Old connection
   rows remain revoked so their IDs still identify historical messages/receipts.
   New connections have new receipt identities.
5. Update HTTP clients, event listeners, tool names, and request/response fields
   using the table above. Verify login, send/reply, original-file transfer, and
   event replay before resuming normal use.

The schema conversion is incompatible with the previous application version.
Rolling back requires stopping writers and restoring the pre-upgrade database
backup together with the old revision. The existing deployment scripts' binary
rollback alone cannot undo the schema conversion. Do the database cutover during
a controlled upgrade; those scripts do not run it automatically.

## Infrastructure cutover

The existing deployment scripts still target the provisioned Deaddrop service,
paths, user, and production domain. This application change does not rename live
infrastructure or the GitHub repository. Plan that cutover separately: provision
the Astropath hostname/certificate, update `APP_URL` and OAuth client URLs, update
storage CORS, and move service/path configuration with a tested rollback. Keeping
the existing bucket and stored object paths avoids unnecessary file movement.

The development checkout and service are already named Astropath. Its installed
Node executable remains at `/opt/deaddrop-node/bin`; that is a host runtime path.
