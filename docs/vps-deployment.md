# Deploy Astropath on a VPS

The live `astropath.porterwestling.com` instance runs on Porter's NixOS `vps-01`.
The previous `deaddrop.thehivemind5.com` address redirects to it.
See [its deployment record](vps-01-migration.md) and use
`scripts/deploy-vps-01.sh` for that instance. The guide below remains the
general-purpose deployment path, including the older RackNerd script.

Astropath supports multiple tenants with separate encryption keys and space-restricted members. It can run on a Linux VPS with Node.js 24, nginx, systemd, Postgres and a private Cloudflare R2 bucket. Vercel hosting is not required; Vercel Blob remains an optional storage backend.

## Prerequisites

- An SSH-accessible Linux server with systemd and nginx. The supplied script uses `root@racknerd`; override `REMOTE_HOST` for your own machine.
- Node.js 24 installed on the server. `REMOTE_NODE` defaults to `/opt/deaddrop-node/bin/node`. Download official binaries from nodejs.org, verify their SHA-256 checksum against the release's `SHASUMS256.txt`, and ensure the OS meets Node's requirements. Install into a versioned directory and point `/opt/deaddrop-node` at it. Do not replace another app's runtime.
- A stable HTTPS domain. Set `DEPLOY_DOMAIN` for your own domain; the nginx template is rendered automatically. The Node process listens on loopback at `DEPLOY_PORT` (default 4310); the next port is reserved for deployment preflight.
- A reachable Postgres database. Neon works without any Vercel integration. Use a pooled URL for the app and a direct URL for schema migration.
- A private R2 bucket and an **Object Read & Write** API token scoped only to that bucket. Leave the public `r2.dev` URL disabled and do not add a public custom domain to the bucket.

Create the R2 bucket in your own Cloudflare account. File transfers go through the app, so normal browser uploads and downloads do not require bucket CORS. If you use the direct-storage diagnostic script, configure CORS for your app's exact origin:

```json
[
  {
    "AllowedOrigins": ["https://astropath.example.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length", "if-none-match"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

The server issues application transfer URLs and encrypts file bytes before storing them in R2. Clients must send the returned headers and original file bytes. The app checks the reserved size, MIME type, tenant, space, and current permissions on each transfer. Upload links last 15 minutes and download links five minutes. The proxy must accept request bodies up to the app's 100 MiB file limit.

## Configure and initialize

Install dependencies locally with Node 24 and `npm ci`. Prepare a minimal environment file with these values:

```dotenv
APP_URL=https://astropath.example.com
BETTER_AUTH_SECRET=YOUR_STABLE_AUTH_SECRET
ASTROPATH_MASTER_KEY=YOUR_SEPARATELY_GENERATED_BASE64_32_BYTE_KEY
OWNER_EMAIL=you@example.com
DATABASE_URL=YOUR_POSTGRES_URL
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=YOUR_CLOUDFLARE_ACCOUNT_ID
R2_BUCKET=YOUR_PRIVATE_BUCKET
R2_ACCESS_KEY_ID=YOUR_BUCKET_SCOPED_ACCESS_KEY
R2_SECRET_ACCESS_KEY=YOUR_BUCKET_SCOPED_SECRET
```

Generate `ASTROPATH_MASTER_KEY` once with `openssl rand -base64 32`, separately from the auth secret. Use the same stable key for migrations and the app, and back it up separately from Postgres and object storage. The migration database role must be able to create/grant `astropath_tenant`; see [tenant migration permissions](tenant-migration.md).

Use `chmod 600` on local secret files; `.env*` files are ignored by Git. Install the runtime environment at `/app/deaddrop/shared/app.env`, owned by root with mode 600, inside a directory with mode 700. systemd reads it and supplies the environment to the unprivileged app process. Do not put an owner password, provider-wide credentials, or build/deployment tokens into this file.

For a **new** installation, follow the database migration and owner initialization instructions in [the Vercel deployment guide](deployment.md#4-configure-secrets-and-create-the-owner), supplying your own Postgres URL and storage variables. Run these commands explicitly before serving requests. No Vercel account is needed when using R2. Remove the bootstrap owner password afterward.

For an **existing Astropath** installation, retain `APP_URL`, `BETTER_AUTH_SECRET`, `ASTROPATH_MASTER_KEY`, `OWNER_EMAIL` and the same database. Do not run owner initialization again. For a **Deaddrop upgrade**, follow the [upgrade guide](astropath-upgrade.md) and complete both `db:migrate` and `files:encrypt` before serving traffic. Human accounts remain usable, but the rename revokes old app connections and requires reconnecting them.

## Deploy and configure HTTPS

Commit your changes, then run:

```sh
REMOTE_HOST=root@YOUR_SERVER \
DEPLOY_DOMAIN=astropath.example.com \
REMOTE_NODE=/opt/deaddrop-node/bin/node \
bash deploy.sh
```

The script runs type checks, tests and a local production build, then copies the compiled standalone server and static assets. It installs production dependencies on Linux, avoiding macOS native binaries. Local environment files and development tooling are excluded. A temporary loopback service is checked before activation. The final service runs as `deaddrop` under systemd with a memory limit and filesystem restrictions.

Releases live in `/app/deaddrop/releases/`. `current` points to the active release and `previous` to the last release. A failed service health check restores the previous release when available. Secrets remain in `shared/` and never enter a release or Git.

Obtain a trusted certificate for your hostname. For a fresh domain, point DNS to the VPS, configure an HTTP ACME webroot at `/app/deaddrop/acme`, then use Certbot. For an existing live site, **obtain the certificate with DNS validation before switching traffic**. A manual DNS certificate must be changed to an automatic renewal method after cutover; manual issuance alone does not auto-renew.

On RackNerd, Certbot runs from `/app/certbot` using `/root/.local/bin/uv run certbot`. For a pre-issued certificate, install the rendered nginx config from the current release, validate with `nginx -t`, and reload nginx. Later deploys install the nginx config automatically when the certificate exists. nginx keeps SSE unbuffered, forwards the original HTTPS origin, accepts request bodies up to 100 MiB with [`client_max_body_size 100m`](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size), and avoids logging transfer credentials and OAuth query strings. Separately managed proxies, including the NixOS VPS configuration, need the same upload limit. Astropath is hidden from the RackNerd public site directory.

Verify HTTPS against the VPS before changing DNS:

```sh
curl --resolve astropath.example.com:443:YOUR_VPS_IP \
  https://astropath.example.com/api/health
```

After cutover, configure automatic webroot renewal and test it. For example, with Certbot 3:

```sh
certbot reconfigure --cert-name astropath.example.com \
  --authenticator webroot --webroot-path /app/deaddrop/acme
certbot renew --cert-name astropath.example.com --dry-run
```

Ensure your renewal job reloads nginx after successful renewal. Test this hostname's renewal; do not change unrelated certificates on a shared VPS.

## Migrate existing Vercel Blob attachments

Keep the old Blob token while migrating. New uploads use the selected `STORAGE_PROVIDER`; when set to `r2`, reads temporarily fall back to Blob **only when the R2 object does not exist and `BLOB_READ_WRITE_TOKEN` is configured**. Other R2 failures do not silently fall back.

With the source Blob token, destination R2 credentials and existing database URL in an ignored environment file:

```sh
node --env-file=.env.migration --import tsx scripts/migrate-storage.ts
node --env-file=.env.migration --import tsx scripts/test-storage.ts
```

The copy script preserves paths and database IDs, verifies file sizes/MIME types and compares SHA-256 hashes of the copied bytes. It never deletes source files or changes database metadata. Unfinished reservations without a stored object are preserved. Rerun after DNS propagation and the 15-minute upload-link window to catch uploads finishing on the old host. Remove the legacy Blob token from the VPS only after every ready file is verified in R2. Retain source objects separately for a rollback window.

During cutover, clients may still reach the old host through cached DNS. Keep both hosts on `STORAGE_PROVIDER=vercel` while switching DNS. After the previous DNS TTL has elapsed and public checks reach the VPS, rerun the copy script, switch the VPS to `STORAGE_PROVIDER=r2`, restart the service, and verify it before pausing the old Vercel project. Keep the Blob read fallback through the final 15-minute upload-link window, then rerun the copy script. This sequence does not require giving R2 credentials to Vercel. The script also recognizes new files that exist only in R2. Retain the old deployment and source objects for rollback; remove the legacy Blob token from the active VPS once the final verification succeeds.

## Verify and operate

Run `scripts/test-storage.ts` to check real private R2 access, upload restrictions, overwrite protection, exact downloads and browser CORS. It creates and deletes a uniquely named test object. Run `scripts/smoke.ts` with `SMOKE_URL` pointing to the deployment and matching database/storage credentials to verify HTTP, MCP, SSE replay and files. It creates an isolated test space and temporary connections, then removes its own data.

Also verify the existing browser session, OAuth discovery URLs, and existing attachments. `/api/health` alone does not test dependencies.

```sh
systemctl status deaddrop
journalctl -u deaddrop --since '10 minutes ago'
systemctl show deaddrop -p MemoryCurrent
```

The VPS move removes Vercel Function duration billing. The current SSE protocol still rotates after 50 seconds and polls Postgres every two seconds while connected; clients reconnect with their saved cursor. **Moving the app does not eliminate Neon compute usage from active listeners.** There is no polling when no SSE clients are connected.

Keep database recovery/backups enabled and back up the stable auth secret, master encryption key, and storage credentials securely. Keep the master key backup separate from database and object backups. Monitor disk, memory, storage usage and certificate renewal. OS/runtime patching and nginx/systemd operations are now the VPS owner's responsibility.

To roll back an app release on the VPS:

```sh
ln -sfn "$(readlink -f /app/deaddrop/previous)" /app/deaddrop/current
systemctl restart deaddrop
curl --fail http://127.0.0.1:4310/api/health
```

Check schema and storage compatibility before rolling back code. Never roll back the database just to switch hosting. A DNS rollback to an old host also requires that host to understand the current storage backend, including newly uploaded files.
