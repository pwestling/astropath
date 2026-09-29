# Deploy your own Astropath

This guide covers **Vercel hosting with Vercel Blob**. For Node/systemd/nginx hosting with Cloudflare R2, see [the VPS deployment guide](vps-deployment.md).

This guide installs Astropath with an initial tenant and platform administrator. Human accounts can belong to multiple tenants; each tenant has its own encryption key and space permissions. Use a separate Vercel project, Postgres database, private Blob store, secrets, and domain for each independent installation. Existing Deaddrop installations must follow the [upgrade guide](astropath-upgrade.md), including both database and file encryption migrations, before deploying this version.

You need Node.js 24, npm, Git, a Vercel account, a Neon account (or another reachable Postgres server), and access to the DNS for your domain. Astropath supplies its own email/password authentication: no email service, external login provider, or AI API key is required.

## 1. Get the code and create your Vercel project

Fork or copy the repository into a GitHub account you control, then clone your copy:

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPOSITORY.git astropath
cd astropath
npm ci
npx vercel@latest login
npx vercel@latest link
```

In `link`, select your Vercel account/team and create a new project. Keep the project root at the repository root and use the Next.js framework. The checked-in build command is `npm run build`; Node 24 is declared in `package.json`. This app requires server functions and cannot use static export.

GitHub access is required if the source repository is private. A fresh Git clone does not include `.vercel/`, environment files, or deployment credentials. If someone gave you a directory copy instead, start from a clean clone so you do not reuse their project link or secrets.

The default function region is `sfo1` in `vercel.json`. You can change it to a supported region closer to your database. Cloudflare is optional and is used only for DNS in the example below; no Worker or Cloudflare account is required by the application.

## 2. Create a database and private file store

Create a new Neon project/database in your own account. Record both connection strings for the same branch, database, and role:

- **Direct URL:** use for migrations and owner initialization. The Neon hostname does not contain `-pooler`.
- **Pooled URL:** use as the deployed app's `DATABASE_URL`. The Neon hostname contains `-pooler`.

Keep the provider's SSL parameters. Do not point a new installation at another owner's database or clone their production data. No Neon Auth setup is needed; Better Auth stores this app's authentication tables in Postgres. See [Neon's connection pooling documentation](https://neon.com/docs/connect/connection-pooling).

In your Vercel project's **Storage** area, create a **Blob** store with **Private** access. Connect it to this project's **Production** environment and obtain its `BLOB_READ_WRITE_TOKEN`. Keep the variable name exactly as shown. Private access is required by the file code. Use a separate store for development/preview instead of automatically sharing the production store with every environment. See [Vercel's Blob setup instructions](https://vercel.com/docs/vercel-blob/using-blob-sdk#getting-started).

## 3. Choose the public origin and configure DNS

Choose a stable origin, such as `https://astropath.example.com`. It serves the admin UI, HTTP API, MCP endpoint, and OAuth provider. Use the domain itself for `APP_URL`, without `/mcp`, another path, or query parameters.

In Vercel, open **Project Settings → Domains**, add your hostname, and follow the DNS records Vercel shows for **your project**. For a subdomain, this is typically a CNAME. Copy the displayed target exactly; do not copy another installation's Vercel DNS target. Add any ownership-verification TXT record requested by Vercel. Wait until the domain and HTTPS certificate are valid. See [Vercel's custom-domain guide](https://vercel.com/docs/domains/working-with-domains/add-a-domain).

If Cloudflare hosts your DNS, set the record to **DNS only** (gray cloud) for this setup. Vercel handles HTTPS. You can keep your existing registrar and nameservers. A stable `your-project.vercel.app` address also works if you do not want a custom domain yet, but changing origins later requires reconnecting OAuth clients.

## 4. Configure secrets and create the owner

Generate an auth secret and a separate master encryption key once. Run
`openssl rand -base64 32` twice and save the outputs in `BETTER_AUTH_SECRET` and
`ASTROPATH_MASTER_KEY`, respectively:

```sh
openssl rand -base64 32
openssl rand -base64 32
cp .env.example .env.bootstrap
chmod 600 .env.bootstrap
```

Edit `.env.bootstrap` locally. Use your **production** origin and **direct** database URL for this one-time setup:

```dotenv
APP_URL=https://astropath.example.com
BETTER_AUTH_SECRET="YOUR_GENERATED_SECRET"
ASTROPATH_MASTER_KEY="YOUR_SEPARATELY_GENERATED_BASE64_32_BYTE_KEY"
DATABASE_URL="YOUR_DIRECT_POSTGRES_URL"
BLOB_READ_WRITE_TOKEN="YOUR_PRIVATE_STORE_TOKEN"
OWNER_EMAIL=you@example.com
OWNER_NAME="Your Name"
OWNER_PASSWORD="YOUR_UNIQUE_PASSWORD_AT_LEAST_12_CHARACTERS"
```

Keep the master key stable and back it up separately from database and object
backups. The migration database role must be able to create/grant the
`astropath_tenant` role; see [tenant migration permissions](tenant-migration.md).
Use the same master key in the deployed app's environment.

Run the following from the repository root. These commands explicitly load `.env.bootstrap`, not `.env.local`:

```sh
node --env-file=.env.bootstrap --import tsx scripts/migrate.ts
node --env-file=.env.bootstrap --import tsx scripts/create-owner.ts
```

The migration creates Better Auth tables and the Astropath schema, including the default `general` space. It is safe to rerun. Owner creation only works on a database without users and refuses to overwrite an existing account. `OWNER_NAME` is optional and defaults to `Owner`. There is no public signup route enabled and no owner creation during web requests.

On an empty database, Better Auth may initially log missing tables before the migration creates them. Confirm the command exits successfully with `Authentication and Astropath database schemas are ready.` before creating the owner.

Store your password in a password manager and remove `OWNER_PASSWORD` from `.env.bootstrap` after success. Keep the remaining file private for future migrations, or retrieve the settings from your secret manager when needed. `.env*` files are ignored by Git and excluded from CLI uploads; `.env.example` contains placeholders only. Avoid exporting conflicting environment variables in your shell: already-exported values take precedence over Node's `--env-file`.

## 5. Set Vercel environment variables and deploy

In **Project Settings → Environment Variables**, set these for **Production**:

| Variable                | Value                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `APP_URL`               | Your exact stable HTTPS origin from step 3.                                              |
| `BETTER_AUTH_SECRET`    | The same generated secret used for bootstrap. Keep it stable.                            |
| `ASTROPATH_MASTER_KEY`  | The same separate master encryption key used for bootstrap. Keep it stable.              |
| `DATABASE_URL`          | Your pooled Neon URL, or the appropriate URL for your Postgres provider.                 |
| `BLOB_READ_WRITE_TOKEN` | The token for your private production Blob store. It may already be present from step 2. |
| `OWNER_EMAIL`           | The exact owner email used at bootstrap. Comparisons ignore case.                        |

`OWNER_PASSWORD` and `OWNER_NAME` are initialization settings and are not needed in Vercel. These are server variables: do not prefix secrets with `NEXT_PUBLIC_`. The app reads `DATABASE_URL` specifically; provider variables named `POSTGRES_URL` or similar must be mapped to it. [Environment changes apply to subsequent deployments](https://vercel.com/docs/environment-variables), so redeploy after changing them.

Deploy from the linked repository:

```sh
npx vercel@latest --prod
```

Migrations are deliberately separate from builds. Run them before deploying code that needs new tables or columns. `.vercelignore` excludes local admin scripts from CLI uploads; you run bootstrap and migrations locally, not inside a production function.

In **Deployment Protection**, ensure the canonical production hostname is reachable by external clients without a Vercel login, password challenge, or bypass header. Keep preview deployments protected. Where supported, protect deployment URLs while leaving your custom production domain accessible. Astropath still requires its own owner login or connection credentials. OAuth discovery, the login/consent pages, and dynamic client registration must be reachable so clients can initiate authorization. See [Vercel deployment protection](https://vercel.com/docs/deployment-protection).

You may connect your GitHub copy under **Project Settings → Git** for automatic deployments. Remember that a push-triggered build does not run migrations; apply any required schema update before pushing the corresponding production release.

## Verify your instance

Set your origin and check the public surfaces:

```sh
export ASTROPATH_URL=https://astropath.example.com
curl --fail-with-body "$ASTROPATH_URL/api/health"
curl --fail-with-body "$ASTROPATH_URL/.well-known/oauth-protected-resource/mcp"
curl --fail-with-body "$ASTROPATH_URL/.well-known/oauth-authorization-server/api/auth"
curl --fail-with-body "$ASTROPATH_URL/openapi.json"
curl -i "$ASTROPATH_URL/mcp"
```

Health should return `status: ok`; the discovery documents and OpenAPI servers should point to **your** origin. Unauthenticated `/mcp` should return **401**, not a Vercel login page. Health is a server-liveness check and does not test the database or Blob store.

Open `/login` and sign in as your owner. Create a named token in **Connections** with read/write access to `general`. Copy it when shown and use it in the [HTTP examples](../README.md#muse-and-http-clients). Create and read a test note, then upload and download a small file in the admin UI to verify the database and private store together. Revoke the test token when done.

For an automated HTTP/MCP/file check, keep your production database URL and Blob token in `.env.bootstrap`, then invoke the smoke script with the target URL explicitly:

```sh
SMOKE_URL="$ASTROPATH_URL" node --env-file=.env.bootstrap --import tsx scripts/smoke.ts
```

It creates test credentials, notes, a space, and real Blob objects, then removes its test data in cleanup. The database and Blob token must belong to the target URL. Run it only against an instance you administer; provider requests/storage may incur usage.

To connect an OAuth-capable MCP client, use `https://astropath.example.com/mcp`, choose **OAuth**, sign in with your account, and assign a unique identity name on approval. Clients register themselves; you do not need to pre-create a client ID or secret. Multiple accounts of the same app can have different names. Invited members' connections inherit their allowed spaces. Muse and other HTTP-only clients use named bearer tokens from **Connections**. See the [connection guide](../README.md#connections).

## Invite someone to a space

After the owner signs in, create a space in **Settings → Spaces**. Under **Members**, enter the person's name and email, select the space, and create an invitation. Copy the link and share it privately. The recipient chooses a password; the link is single-use and expires after seven days. There is no automatic email delivery or public registration.

The invited member can manage their own connections, but only within the space access you assign. You retain administrator access to all spaces. See [member permissions and revocation](../README.md#invited-members) for how existing connections behave when membership changes. `OWNER_EMAIL` remains the administrator allowlist; keep it set to the original owner's email, not the invited member's.

## Development, upgrades, and backups

The [HTTP event stream](events.md) uses the same Postgres database and requires no additional service or environment variables. Run the schema migration before deploying an upgrade that adds event support. The SSE route has a 60-second function budget and rotates streams after 50 seconds; consumers must reconnect using their saved event cursor. Include `ap_events` in database backups. Active subscribers poll the database and keep it active, so account for that usage when running persistent listeners.

For local development, use `.env.local` with `APP_URL=http://localhost:3000`, a separate database, a separate private Blob store, a development auth secret, and a separate `ASTROPATH_MASTER_KEY`. Run `npm run db:migrate`, `npm run owner:create` once, then `npm run dev`. The npm scripts for database setup load `.env.local`; the explicit Node commands above load `.env.bootstrap`. Neither is interchangeable by filename alone.

A preview that needs working OAuth must have a stable preview origin, matching `APP_URL`, and isolated data/storage. A protected preview cannot be used by external clients unless those clients can pass its deployment protection. Use a fresh test database where possible. If you clone production, it contains owner accounts, credentials, and encrypted OAuth signing keys; it is not an empty install. A different `BETTER_AUTH_SECRET` cannot decrypt copied keys. Keep such clones private, and reset test-only auth data deliberately or create a fresh database instead.

For updates:

1. Back up the database and keep a recoverable copy of private files and the stable auth secret. Back up `ASTROPATH_MASTER_KEY` separately from database and object backups. GitHub stores the code, not your notes, files, settings, or credentials.
2. Review and test the update in an isolated environment. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`.
3. Test schema changes on a disposable database branch first. Apply the migration to production with its direct URL using the explicit command in step 4. For a Deaddrop upgrade, complete the [tenant and encryption migration](tenant-migration.md), including `files:encrypt`, before deploying. Do not rerun `create-owner` for an upgrade.
4. Deploy with `npx vercel@latest --prod`, or push to your configured production branch after migrations are ready. Repeat the verification checks. Rolling back code does not undo a database migration.

Keep `APP_URL` and `BETTER_AUTH_SECRET` stable. To change domains, add and verify the new domain, update `APP_URL`, redeploy, and reconnect OAuth clients to the new `/mcp` URL. Tokens issued for the old origin have a different issuer/resource. Update HTTP clients' base URLs as well. Change the owner's password in authenticated **Settings**; changing an environment variable does not change the password or rename the database account.

Use one canonical origin and redirect alternate hostnames to it, preserving paths and query strings. Verify the new hostname's HTTPS certificate before switching `APP_URL`. If public uploads are enabled, allow the new origin in the public R2 bucket's PUT CORS rule. Update agent hooks and HTTP clients to the new origin directly: cross-origin redirects may drop Authorization headers. Existing named API tokens remain usable if still valid; OAuth clients must reconnect and browser users must sign in at the new domain. Preserve the database and encryption/authentication secrets during a hostname change.

Monitor database and Blob usage and retain backups of both. Abandoned uploads are retained; automatic retention/garbage collection is not implemented.

## Troubleshooting

| Symptom                                                     | Check                                                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel HTML, a challenge, or a redirect instead of API JSON | Production deployment protection, DNS proxy rules, and the exact hostname used by the client.                                                   |
| Login/approval reports an origin error                      | `APP_URL` must exactly match the browser's origin. Redeploy after changing it; avoid switching between custom and generated URLs during a flow. |
| Database connection or missing-table error                  | `DATABASE_URL`, SSL options, correct branch/database, and a successful migration. Health alone cannot detect this.                              |
| Owner creation says an owner exists                         | You are upgrading or using a copied database. Use the existing owner's login or start a separate instance with a fresh database.                |
| Login works but owner actions fail                          | `OWNER_EMAIL` must match the existing user's email. Editing it does not transfer ownership.                                                     |
| OAuth signing-key decryption fails after a secret change    | Restore the original secret for that database. Do not delete production signing keys as a setup shortcut.                                       |
| Uploads fail                                                | Check that the store is private, its token belongs to this project/environment, and the redeployed app has the token.                           |
| Identity name is already in use                             | Choose a distinct name, or revoke the old connection before reauthorizing with that name. Names are unique ignoring case.                       |

Tenant owners invite additional people through **Settings → Members** and assign space permissions. A person can belong to multiple tenants and create a tenant of their own. Platform administration does not grant content access without tenant membership.
