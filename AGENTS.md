<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Public agent setup guide

`public/llms.txt` is the public, plain-text installation and integration guide
for agents installing Astropath or explaining setup to a user. Next.js serves it
at `/llms.txt` without authentication; it is also available from the public
repository's raw `main` branch.

Keep this file current in the same change whenever installation or integration
behavior changes: runtime requirements, environment variables, bootstrap and
migrations, deployment packaging, public endpoints, authentication and scopes,
client connection steps, MCP tools, HTTP examples, files, skills, or knowledge
capture. Check instructions and examples against the implementation and relevant
docs; distinguish released capabilities from older installations and planned
features. Keep it self-contained enough for an agent without a checkout, with
links to detailed source docs where needed. Do not include credentials, private
infrastructure details, or tenant content.

Preserve unauthenticated plain-text access. When changing hosting or release
scripts, ensure `public/llms.txt` is included in the deployed artifact. Verify
that the published file is reachable and matches the committed source; do not
claim an instance has new capabilities just because its guide is available.
