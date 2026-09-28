# RackNerd development checkout

The working development checkout is `/root/dev/astropath` on RackNerd. It is
currently a clone of this Deaddrop repository; only the directory and service
names anticipate the upcoming app rename. `astropath-dev.service` runs `next
dev` under the unprivileged `astropath-dev` account and listens only on
`127.0.0.1:4312`. It is enabled at boot. The unit file is tracked at
[`deploy/astropath-dev.service`](../deploy/astropath-dev.service).

RackNerd's AlmaLinux 8.9 glibc cannot load Next 16.3.5's native SWC binary.
The service therefore uses Next's WebAssembly compiler with Webpack. Run
[`scripts/install-next-wasm.sh`](../scripts/install-next-wasm.sh) after each
`npm ci` to install the compiler matching the checked-out Next version. The
service uses the existing Node 24 runtime at `/opt/deaddrop-node/bin`.

## Open the app

From a machine with Tailscale access, forward the dev port over SSH:

```sh
ssh -N -L 4312:127.0.0.1:4312 root@racknerd
```

Then open `http://localhost:4312/login`. If the short hostname does not resolve,
use the Tailscale address. On Porter's Mac, the known host key is recorded
under the public IP:

```sh
ssh -N -L 4312:127.0.0.1:4312 -o HostKeyAlias=107.174.170.185 root@100.113.18.57
```

The initial owner password is in the root-only
`/root/dev/astropath/.env.owner-initial-password` file. Read it over SSH and
change it in Settings after signing in. The owner email is in `.env.local`.

## Isolated development data

- PostgreSQL 18 runs in the `astropath-dev-postgres` Podman container, with the
  `astropath-dev-postgres` volume and port `127.0.0.1:5433`. Its container
  settings are stored in the ignored, root-only `.env.postgres` file.
- `.env.local` has a separate database URL and Better Auth secret, with
  `APP_URL=http://localhost:4312`. It is readable by the service account
  through a file ACL. The initial owner password is not in that file.
- The development app shares the existing private R2 bucket but uses
  `R2_KEY_PREFIX=astropath-dev`. The bucket's CORS policy includes both the
  production origin and `http://localhost:4312` for browser file transfers.
- This setup does not use the old RackNerd release or the production database
  on `vps-01`.

## Work in the checkout

```sh
ssh root@racknerd
cd /root/dev/astropath
export PATH=/opt/deaddrop-node/bin:$PATH
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
systemctl status astropath-dev.service
journalctl -u astropath-dev.service -f
```

Use one Vitest worker here: parallel workers exhausted the host's memory.
Next regenerates the tracked `next-env.d.ts` with development type paths, so
that file normally appears modified while the service runs. Before pulling a
new commit, stop the service and restore **only** that generated file after
reviewing any other changes:

```sh
systemctl stop astropath-dev.service
git status --short
git restore -- next-env.d.ts
git pull --ff-only
export PATH=/opt/deaddrop-node/bin:$PATH
npm ci --no-audit --no-fund
bash scripts/install-next-wasm.sh
npm run db:migrate
systemctl start astropath-dev.service
curl --fail http://127.0.0.1:4312/api/health
```

The service account can write `.next`, `next-env.d.ts`, and `tsconfig.json`;
the rest of the source remains root-owned. The systemd bind mount gives it
access to the checkout without opening `/root` to that account. If the unit
changes, copy the tracked unit to `/etc/systemd/system/astropath-dev.service`,
then run `systemctl daemon-reload` and restart it.
