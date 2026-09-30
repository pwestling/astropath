# Deaddrop production on vps-01

## Astropath hostname, 2026-09-29 UTC

The canonical origin is now `https://astropath.porterwestling.com`. The previous
`deaddrop.thehivemind5.com` address redirects to it with paths and query strings
preserved. Both hostnames have automatically renewed HTTPS certificates.
The application, database, accounts and encryption keys are unchanged.

Connect agents directly to `https://astropath.porterwestling.com/mcp` and
reconnect OAuth clients. HTTP clients and hooks should update their base URL;
existing named API tokens remain usable. Browser users must sign in again on
the new domain. Setup instructions are at
`https://astropath.porterwestling.com/llms.txt`.

Public files continue to use `https://files.porterwestling.com`. The public
bucket's upload CORS policy includes the new application origin. Previously
shared public download URLs are unchanged.

## Astropath upgrade, 2026-09-29 UTC

The application now includes tenants, encrypted content and file transfers,
hierarchical knowledge topics, session-authored notes, and regular agent capture
templates. The implementation is in commit `b2c493f`. The canonical hostname is
unchanged. Public setup instructions are at `/llms.txt`; downloadable client
instructions are at `/integrations/README.txt`. Templates require installation
and authorization in each client. ChatGPT writes retain their normal approvals.

An operator error during the intended rehearsal let systemd's production
`EnvironmentFile` override a `--setenv DATABASE_URL` value, so the migration
reached production. The old app was stopped when this was discovered, another
protected database backup was taken, and file locations were corrected and
verified before activation. Original objects were preserved. The actual clone
was subsequently migrated with an in-process database override and an explicit
`current_database()` assertion. Future rehearsals must assert the actual database
identity before any write.

Verification before activation confirmed all migrated message contents, file
metadata and bytes, receipts, events, and activity. The public smoke test passed
authentication, scopes, retries, SSE, MCP/chat compatibility, encrypted file round
trips, and token revocation. All 85 automated tests, TypeScript, the skill validator,
and production builds passed. A deployment milestone was saved with session
attribution and verified through MCP creation, HTTP exact retry, and readback.

Legacy connections were deliberately revoked by the upgrade; reconnect agents.
Database permissions retain a restricted runtime login and non-login tenant role.
The backup job was updated for forced row security: it checks complete read
policies and rejects restrictive SELECT policies before dumping. An encrypted
backup was downloaded, decrypted, and restored in isolation; all 30 table counts
and content fingerprints matched production. Recovery materials and original
objects remain protected. No legacy service or source storage was retired.
Rollback after new writes requires preserving them before restoring an old backup.

The record below describes the earlier hosting migration and is historical.

Recorded 2026-09-28 UTC. The working Deaddrop app, production DNS, and database
moved from RackNerd/Neon to the DigitalOcean NixOS host `vps-01`. The existing
private Cloudflare R2 bucket remains the file store. The canonical `APP_URL`,
Better Auth secret, and owner identity were preserved.

| Component | Production state |
| --- | --- |
| Runtime | `deaddrop.service` on `vps-01`, Node 24 on `127.0.0.1:4310` |
| Public URL | `https://deaddrop.thehivemind5.com` through NixOS nginx |
| Database | PostgreSQL 18.6 on `vps-01`, database and role `deaddrop`, local peer-authenticated Unix socket; Neon `neondb` retains the cutover state with known app writers stopped |
| Files | Existing private R2 bucket `deaddrop`; signed direct uploads and downloads |
| Jobs | Daily encrypted PostgreSQL backup timer; no app worker or other cron |
| Legacy paths | RackNerd nginx temporarily proxies cached-DNS clients to the VPS; its app service is stopped and disabled. The Vercel deployment aliases were already paused before this move. |

## Release and configuration

- App commit: `bbe97c8` (runtime code matches the prior RackNerd release
  `2ca801e`; this commit adds the VPS deployment script).
- VPS infrastructure commits: `44476e9` for the app service and HTTPS,
  `8f2ba4f` for the dedicated database role and encrypted R2 backup, and
  `218e894` for the local database URL. The SOPS adoption is `6bd747d`.
- Initial release: `/srv/deaddrop/releases/20260928T042436Z-bbe97c8`;
  normalized artifact SHA-256
  `bf5db9c206942f3c2406fbb7dfd9d878f617bf2367d746fcdd7eb6b319d8b39c`.
- `/srv/deaddrop/current` selects the active root-owned release. The app can
  write its per-release cache under `/var/cache/deaddrop/` and state under
  `/var/lib/deaddrop/`. It runs as the locked `deaddrop` user in `apps.slice`,
  with a 768 MiB hard memory limit and 256-task limit.
- The production environment was copied directly from RackNerd with the user's
  explicit authorization and matching checksums. Its source of truth is now
  SOPS ciphertext at `hosts/vps-01/secrets/deaddrop.yaml` in the VPS repo.
  The compatibility path `/var/lib/app-secrets/deaddrop.env` links to a
  root-owned mode-400 file in `/run/secrets`. The sole database URL change was
  to `postgresql:///deaddrop?host=/run/postgresql`; other credentials were
  preserved. Never commit or print decrypted values.
- The ignored `.env.local` in this checkout also pointed at production Neon.
  Its database URL now uses the VPS socket so local commands cannot silently
  write to stale Neon data. That socket is only available on the VPS; Mac
  development needs a separate development database connection.

The Cloudflare `thehivemind5.com` zone A record
`5892f030f766cf428f5e856271a0dc81` changed from `107.174.170.185` to
`164.90.155.4`. It remains DNS-only with TTL 60 seconds. There is no Deaddrop
AAAA record. The DigitalOcean firewall has an additive public TCP 443 rule;
backend port 4310 and PostgreSQL remain closed publicly. NixOS ACME issued the
production certificate via HTTP-01 before DNS changed and has a renewal timer.
The target certificate expires 2026-12-27. RackNerd's retained certificate
expires 2026-12-15.

## Cutover checks

- A secret-free committed-source build passed TypeScript, all 55 tests, and
  `next build` on NixOS Node 24. A separate runtime rehearsal passed under the
  `deaddrop` Unix user with disposable settings. The NixOS configuration built
  without activation before it was deployed.
- The final Neon source was PostgreSQL 18.6, 10,715,136 database bytes, 22
  tables, 63 indexes, 172 constraints, and 2 sequences. It needed no extension
  beyond `plpgsql` and had no user triggers, row-level policies, large objects,
  publications, subscriptions, or foreign servers. The final state included 1
  space, 0 members, 44 drops, 10 ready files totaling 15,140,574 bytes, 3 old
  pending files with no current 15-minute upload URL, 5 connections, and 7
  sessions. All 10 ready-file records matched private R2 object sizes.
- A direct-endpoint custom-format Neon dump was restored in one transaction
  without source owners or ACLs, first into an isolated rehearsal database and
  then into the dedicated production database after stopping the VPS app writer.
  The old RackNerd service and Vercel aliases were already inactive. The final
  dump is root-only at `/var/lib/deaddrop-migration/neon-final-20260928.dump`
  (301,963 bytes; SHA-256
  `627ce2e22b59b73b138c72c8ac9a1fe40f5db1e72332369f2db7e8ded4d7866d`).
  Exact row counts and content hashes matched across all 22 tables; indexes,
  constraints, and both sequence values matched. The target reports `C.utf8`
  where Neon reported `C.UTF-8`. A rolled-back sequence-backed insert under
  the actual `deaddrop` role passed in rehearsal.
- The self-cleaning production smoke test passed first on VPS loopback, then
  through the public HTTPS hostname at runtime cutover, and again through
  public HTTPS after the database move. It covered API auth and permissions,
  retries, SSE, R2 upload/download, MCP tools and chat, legacy MCP protocols,
  and active token revocation. After cleanup the local database still had 1
  space, 0 members, 44 drops, 10 ready files totaling 15,140,574 bytes, 5
  connections, and 7 sessions.
- The retained Neon database still had the exact final-source table and
  sequence fingerprints after the new local database passed its public smoke
  test; no other source writer was observed during cutover.
- Public checks returned 200 for health, login, OpenAPI, and OAuth metadata;
  the unauthenticated drops API returned 401. The login CSS asset returned 200.
  The site certificate validated, and Cloudflare plus independent recursive
  DNS resolvers returned `164.90.155.4`. RackNerd's old IP still returned a
  healthy response through its TLS-verified proxy after its app process stopped.
- The VPS had no failed units or Deaddrop restarts after cutover. Owner browser
  login with a real password was not exercised. This Mac did not have usable
  public IPv6 connectivity, so no IPv6 route was added or claimed as tested.

## Database backups

`hosts/vps-01/apps/deaddrop-db-backup.nix` declares a daily timer at 03:15 UTC
with up to 15 minutes of random delay. It runs as `deaddrop`, makes a custom
format logical dump over the local socket, encrypts it for both the VPS and
Porter's independent Mac recovery key, and uploads it to the existing private
R2 bucket under `db-backups/deaddrop/`. The marker
`/var/lib/deaddrop/local-postgres-active` enables the job only after database
cutover. The last successful object key and byte size are recorded in
`/var/lib/deaddrop-db-backup/last-success`.

Before the app resumed, the final database backup uploaded as
`db-backups/deaddrop/20260928T051001Z-3e07f9b3b50a.dump.age` (301,243
encrypted bytes). The same backup path was tested with a rehearsal snapshot:
download from R2, decrypt with the VPS key, restore into a fresh isolated
database, and compare all 22 table fingerprints, 63 indexes, 172 constraints,
and both sequences. The Mac recovery key independently decrypted the R2 object.
This is a logical backup, not point-in-time recovery. The DigitalOcean Droplet
backup listing was still empty before its first scheduled 08:00–12:00 UTC
window. R2 object deletion/overwrite recovery was not tested.

To rehearse recovery, read the exact object key from `last-success`, download
that encrypted object using the existing R2 credentials in the managed
environment, decrypt with the VPS age identity or the independent Mac recovery
key, and restore with `pg_restore --no-owner --no-acl --single-transaction`
into a **new** database owned by `deaddrop`. Create it from `template0` with
UTF-8 and `C.utf8`; compare table counts, hashes, sequences, and app behavior
before considering a production switch. Never restore over the live database.

## Normal deployment

From a committed app checkout on Porter's Mac or `/root/dev/astropath` on
RackNerd, run `./scripts/deploy-vps-01.sh`. It uses the pinned tailnet IP and
host key in `deploy/vps-01-known_hosts` and accepts only Next's generated
`next-env.d.ts` change in an otherwise clean development checkout. It archives
the commit, builds from the lockfile on NixOS inside `builds.slice`, runs the
checks, stages a root-owned release,
tests it on loopback port 4311, atomically promotes `current`, restarts the
declarative service, and checks port 4310. A failed health check restores the
previous release when one exists. It does not modify DNS, nginx, systemd unit
files, or secrets. For changes to the NixOS module, deploy the separate VPS
repository with its `./scripts/deploy.sh` after reviewing that diff.
For a future release that changes schema, plan and rehearse the migration and
data rollback separately; the artifact promotion script does not run schema
migrations automatically.

For a schema upgrade, `./scripts/deploy-vps-01.sh --prepare` builds and validates
a release without changing the running service. It retains source and dependencies
at the printed staging path for an isolated migration rehearsal. After stopping
writers, protecting the final backup, migrating, and verifying the data, run
`./scripts/deploy-vps-01.sh --activate-migrated RELEASE` from the same commit.
This mode never rolls back to an incompatible old binary automatically: a failed
activation leaves the service stopped and retains migration tools for recovery.
`--activate RELEASE` is only for prepared releases without a schema transition.

## Recovery boundary and retained dependencies

The old RackNerd release and root-only environment file remain in place, but
its service is disabled. A root-only copy of its pre-cutover nginx config is at
`/app/deaddrop/shared/nginx-before-vps-proxy.conf.bak`. Neon retains the
pre-cutover state with known app writers stopped; it does **not** receive
writes made to local PostgreSQL.
The app made no schema change during this migration. After any new local write,
do not point the app back at Neon or RackNerd without first stopping the VPS
writer, protecting a fresh local dump, and reconciling or reverse-transferring
database and R2 changes. Restore the saved RackNerd nginx config and Cloudflare
A-record values only when that data boundary is handled. NixOS rollback alone
does not change the app release, database contents, DNS, or firewall.

Keep Neon, the old RackNerd release, and its credential copy through the
rollback window. The pre-existing Vercel aliases remain paused and were not
repointed. Retiring RackNerd resources, those aliases, or Neon is a separate
cleanup decision.

## Memory log migration, 2026-09-30 UTC

Release `20260930T145603Z-21f01c6` replaced the topic tree with the memory log
and added server-held agent guidance. The app was down from 14:57:23 to about
14:58:33 UTC. A backup was taken first:
`db-backups/astropath/20260930T145720Z-a0a42f751b47.dump.age`. The migration
copied all 18 topic notes into `ap_memories`.

The schema step ran from the `--prepare` staging tree as the app user, with
the production environment, and was verified before `--activate-migrated`:

```sh
stage=/var/tmp/astropath-build-RELEASE
node_store="$(nix eval --raw --impure --expr '(builtins.getFlake "/etc/nixos").inputs.nixpkgs.legacyPackages.x86_64-linux.nodejs_24.outPath')"
systemd-run --unit=astropath-migrate --collect --wait --pipe --quiet \
  --slice=apps.slice --working-directory="$stage" \
  --property=User=astropath --property=Group=astropath \
  --property=EnvironmentFile=/var/lib/app-secrets/astropath.env \
  --setenv="PATH=$node_store/bin:/run/current-system/sw/bin" \
  "$node_store/bin/node" "$stage/node_modules/tsx/dist/cli.mjs" scripts/migrate.ts
```

Two attempts failed before running any SQL, extending the downtime by about
30 seconds:
- `node_modules/.bin/tsx` cannot execute on NixOS, because its
  `#!/usr/bin/env node` shebang has no `/usr/bin/env`. Run tsx's CLI with Node
  directly.
- `PrivateTmp=yes` also hides `/var/tmp`, where the staging tree lives.

`astropath.service` also exceeded its 30-second stop timeout and was killed. It
reports `failed (Result: timeout)` until the next start.

## Rename to Astropath

Status: **completed 2026-09-30, 06:05:46–06:06:29 UTC (43 seconds of downtime).**
Infrastructure commits `6c52308` and `6f31401` in the VPS repo. A fresh backup,
`db-backups/deaddrop/20260930T055716Z-c1fc68588a34.dump.age`, was taken
immediately before. The first post-rename backup,
`db-backups/astropath/20260930T060630Z-89905a77ab07.dump.age`, succeeded. As
expected, `astropath.service` failed its first start with `200/CHDIR` until the
releases were re-grouped. The switch therefore exited with status 4, but the
new generation was active and set as the boot default. The new user and group
are UID 989 and GID 988. The rename keeps every piece of data in place:

| Before | After |
|---|---|
| `deaddrop.service`, user and group `deaddrop` | `astropath.service`, user and group `astropath` (new UID/GID) |
| `/srv/deaddrop`, `/var/lib/deaddrop`, `/var/cache/deaddrop` | `/srv/astropath`, `/var/lib/astropath`, `/var/cache/astropath` |
| PostgreSQL database and role `deaddrop` | `astropath` (renamed in place; OIDs, ownership, grants and RLS policies carry over) |
| `secrets/deaddrop.yaml`, `/var/lib/app-secrets/deaddrop.env` | `secrets/astropath.yaml`, `/var/lib/app-secrets/astropath.env` |
| `deaddrop-db-backup` timer, `db-backups/deaddrop/` | `astropath-db-backup`, new dumps under `db-backups/astropath/` |

Unchanged: the R2 bucket `deaddrop` (buckets cannot be renamed; Roundtable's
backups also live there), older dumps under `db-backups/deaddrop/`, the
`deaddrop.thehivemind5.com` redirect, and the retired RackNerd install.

NixOS `ensureDatabases` would create an empty `astropath` database on
activation, so the database and role must be renamed **before** the switch.

### Before downtime

1. In the encrypted environment, change `DATABASE_URL` from
   `postgresql:///deaddrop?host=/run/postgresql` to
   `postgresql:///astropath?host=/run/postgresql`
   (`./scripts/sops.sh edit hosts/vps-01/secrets/astropath.yaml` in the VPS
   repo), then commit it on `astropath-rename`. Leave `R2_BUCKET` unchanged.
2. Pre-build the branch's configuration on the host from a staged copy, so the
   switch step's build is already in the Nix store:
   `git archive astropath-rename flake.nix flake.lock hosts | ssh … 'mkdir -p /root/stage-astropath && tar -xf - -C /root/stage-astropath && systemd-run --scope --slice=builds.slice nixos-rebuild build --flake path:/root/stage-astropath#vps-01'`.
3. Take a fresh backup: `systemctl start deaddrop-db-backup.service`, then
   confirm `/var/lib/deaddrop-db-backup/last-success` names a new object.

### Cutover (the app is down from step 4 until step 7)

4. `systemctl stop deaddrop.service deaddrop-db-backup.timer`
5. As `postgres`: `ALTER DATABASE deaddrop RENAME TO astropath;` then
   `ALTER ROLE deaddrop RENAME TO astropath;` (peer authentication maps the new
   Unix user to the new role; the role has no password to invalidate).
6. Move state and repoint absolute symlinks:
   ```sh
   mv /srv/deaddrop /srv/astropath
   mv /var/lib/deaddrop /var/lib/astropath
   mv /var/cache/deaddrop /var/cache/astropath
   mv /var/lib/deaddrop-db-backup /var/lib/astropath-db-backup
   for link in current previous; do
     ln -sfn "$(readlink /srv/astropath/$link | sed 's#^/srv/deaddrop/#/srv/astropath/#')" /srv/astropath/$link
   done
   for release in /srv/astropath/releases/*/; do
     ln -sfn "/var/cache/astropath/$(basename "$release")" "$release/.next/cache"
   done
   rm -f /var/lib/app-secrets/deaddrop.env
   ```
7. From the VPS repo on `astropath-rename`, run `./scripts/deploy.sh`. The new
   service may fail its first start because releases are still group-owned by
   the old GID. Then:
   ```sh
   chgrp -R astropath /srv/astropath/releases
   chown -R astropath:astropath /var/cache/astropath /var/lib/astropath/.npm /var/lib/astropath/upgrade-audit
   chown astropath:astropath /var/lib/astropath /var/lib/astropath-db-backup
   systemctl restart astropath.service
   curl --fail http://127.0.0.1:4310/api/health
   ```

### Verify

8. Check `https://astropath.porterwestling.com/login`, a signed-in page, MCP
   OAuth discovery, and an existing attachment download. Run
   `systemctl start astropath-db-backup.service` and confirm a new
   `db-backups/astropath/` object. `systemctl --failed` must be empty.
9. Merge both branches, then release current `main` with
   `./scripts/deploy-vps-01.sh`, which now uses the Astropath paths.

### Rollback

Before step 7 activates: reverse step 6's moves and symlinks, run
`ALTER DATABASE astropath RENAME TO deaddrop; ALTER ROLE astropath RENAME TO deaddrop;`,
and `systemctl start deaddrop.service deaddrop-db-backup.timer`. After step 7:
first `nixos-rebuild switch --rollback`, then reverse the same data renames and
restore `root:deaddrop` group ownership on the releases. Rolling back
configuration does not rename the database; both halves are required.
