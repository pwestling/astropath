# Tenant and encryption migration

Run this upgrade during a maintenance window. Stop application writers first.
Before applying it, take a PostgreSQL backup and retain a private copy of the
object store. Keep the master encryption key outside both backups. Do not deploy
the new application until migration and verification complete.

Set a stable `ASTROPATH_MASTER_KEY` (`openssl rand -base64 32`) in the server's
protected environment, then run `npm run db:migrate` and `npm run files:encrypt`.
Complete both steps before running a Blob-to-R2 storage migration; that migration
copies the encrypted objects without changing their original-file metadata.
The migration database role needs permission to create/grant the non-login
`astropath_tenant` role. If the runtime database login differs from the migration
login, a database administrator must grant it that role plus the authentication
and directory table permissions before starting the app. The supplied defaults
use the same login for migration/auth and explicitly switch roles for content.

The migration creates an initial tenant for the existing workspace and explicitly
enrolls its owner. Existing members retain their space grants. Connections without
an accountable human creator are revoked; they must reconnect.

Database content migration runs in one transaction. It writes authenticated
ciphertext before clearing the corresponding plaintext fields. Message titles,
bodies, tags, file names/types, event payloads and activity details are retained in
ciphertext. No messages, files, or activity history are deleted. Failure rolls back
the transaction. Keep the master key stable: it wraps the tenant keys needed to
decrypt migrated content.

File migration writes encrypted copies at new opaque object paths. Keep source
objects until the encrypted copies have been verified and the database transaction
commits. Source-object cleanup is a separate explicit maintenance action. Until
cleanup completes, the old objects still contain plaintext. Older database backups
also retain plaintext and need the same protection as before this upgrade.
The old object paths are retained encrypted in `ap_legacy_file_objects`; ordinary
application APIs never expose them. Wait for old upload URLs to expire before
performing object-store cleanup. File transfers now go through the application;
set reverse-proxy request limits to accommodate the configured 100 MiB maximum.
Configure access logs to omit query strings and authorization headers (for nginx,
log `$uri` rather than `$request`/`$request_uri`), or disable access logs for transfer
routes. Query strings can contain search text and short-lived transfer credentials.
Next's development request logging is disabled for this reason.

Rollback: stop writers, restore the pre-upgrade database backup and application
version, and keep the original object paths. Do not remove those originals until
the rollback window has closed. A rollback after accepting new writes requires
exporting those writes first; restoring the backup alone would lose them.

Validation before cutover: verify two tenants with identical space slugs, denied
cross-tenant object IDs and credentials, account membership in both tenants,
encrypted message/file round trips, ciphertext tamper rejection, and immutable
skill revisions. Compare migrated row counts and decrypted samples against the
backup before resuming traffic.
