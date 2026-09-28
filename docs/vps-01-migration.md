# Deaddrop production on vps-01

Recorded 2026-09-28 UTC. The working Deaddrop app moved from RackNerd to the
DigitalOcean NixOS host `vps-01`. This was a **runtime and DNS migration**:
the existing Neon database and private Cloudflare R2 bucket remain the durable
stores. No database or object export/import occurred, and the canonical
`APP_URL`, Better Auth secret, and owner identity were preserved.

| Component | Production state |
| --- | --- |
| Runtime | `deaddrop.service` on `vps-01`, Node 24 on `127.0.0.1:4310` |
| Public URL | `https://deaddrop.thehivemind5.com` through NixOS nginx |
| Database | Existing Neon `neondb` via its pooled endpoint; VPS PostgreSQL is unused by Deaddrop |
| Files | Existing private R2 bucket `deaddrop`; signed direct uploads and downloads |
| Jobs | No separate Deaddrop cron or worker service |
| Legacy paths | RackNerd nginx temporarily proxies cached-DNS clients to the VPS; its app service is stopped and disabled. The Vercel deployment aliases were already paused before this move. |

## Release and configuration

- App commit: `bbe97c8` (runtime code matches the prior RackNerd release
  `2ca801e`; this commit adds the VPS deployment script).
- VPS infrastructure commit: `44476e9`; module
  `hosts/vps-01/apps/deaddrop.nix` owns the user, service, nginx route, ACME
  certificate, and host firewall port 443.
- Initial release: `/srv/deaddrop/releases/20260928T042436Z-bbe97c8`;
  normalized artifact SHA-256
  `bf5db9c206942f3c2406fbb7dfd9d878f617bf2367d746fcdd7eb6b319d8b39c`.
- `/srv/deaddrop/current` selects the active root-owned release. The app can
  write its per-release cache under `/var/cache/deaddrop/` and state under
  `/var/lib/deaddrop/`. It runs as the locked `deaddrop` user in `apps.slice`,
  with a 768 MiB hard memory limit and 256-task limit.
- The production environment is a root-owned mode-600 file at
  `/var/lib/app-secrets/deaddrop.env`, under a mode-700 parent directory. It
  was copied directly from RackNerd with the user's explicit authorization;
  source and target file checksums matched. Never commit or print its values.

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
- Before cutover the existing Neon database had 1 space, 0 members, 44 drops,
  10 ready files totaling 15,140,574 bytes, and 5 connections. All 10 ready
  file records matched R2 object sizes. The same aggregate counts remained
  after cutover and smoke-test cleanup.
- The self-cleaning production smoke test passed first on VPS loopback, then
  through the public HTTPS hostname. It covered API auth and permissions,
  retries, SSE, R2 upload/download, MCP tools and chat, legacy MCP protocols,
  and active token revocation.
- Public checks returned 200 for health, login, OpenAPI, and OAuth metadata;
  the unauthenticated drops API returned 401. The login CSS asset returned 200.
  The site certificate validated, and Cloudflare plus independent recursive
  DNS resolvers returned `164.90.155.4`. RackNerd's old IP still returned a
  healthy response through its TLS-verified proxy after its app process stopped.
- The VPS had no failed units or Deaddrop restarts after cutover. Owner browser
  login with a real password was not exercised. This Mac did not have usable
  public IPv6 connectivity, so no IPv6 route was added or claimed as tested.

## Normal deployment

From a clean, committed app checkout on Porter's Mac, run
`./scripts/deploy-vps-01.sh`. It archives the commit, builds from the lockfile
on NixOS inside `builds.slice`, runs the checks, stages a root-owned release,
tests it on loopback port 4311, atomically promotes `current`, restarts the
declarative service, and checks port 4310. A failed health check restores the
previous release when one exists. It does not modify DNS, nginx, systemd unit
files, or secrets. For changes to the NixOS module, deploy the separate VPS
repository with its `./scripts/deploy.sh` after reviewing that diff.

## Recovery boundary and retained dependencies

The old RackNerd release and root-only environment file remain in place, but
its service is disabled. A root-only copy of its pre-cutover nginx config is at
`/app/deaddrop/shared/nginx-before-vps-proxy.conf.bak`. Both runtimes use the
same Neon database, R2 bucket, and auth secret, and this migration made no
schema change. To restore RackNerd as the writer, first stop and drain the VPS
service, restore the saved RackNerd nginx config, enable and start the old
service, then restore the saved Cloudflare A-record values. Keep only one app
writer active; verify DNS and both direct-origin routes during propagation.
NixOS rollback alone does not change the app release symlink, DNS, or firewall.

The VPS backup policy is enabled, but `doctl` listed no completed Droplet
backup during this migration; its first window was still ahead. Neon and R2
remained external, and their restore procedures were not retested here. Keep
the old RackNerd release and credential copy through the rollback window.
The pre-existing Vercel aliases remain paused and were not repointed. Retiring
RackNerd resources, those aliases, or Neon is a separate cleanup decision.
