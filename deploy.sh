#!/usr/bin/env bash
set -euo pipefail

# Build on the developer machine; install production dependencies on Linux.
# Native macOS packages and local .env files must never enter the release.
cd "$(dirname "$0")"
# Name the server and public hostname explicitly; there is no default target.
REMOTE_HOST="${REMOTE_HOST:?Set REMOTE_HOST, for example root@your-server}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:?Set DEPLOY_DOMAIN to the public hostname}"
DEPLOY_PORT="${DEPLOY_PORT:-4310}"
REMOTE_NODE="${REMOTE_NODE:-/opt/astropath-node/bin/node}"
[[ "$DEPLOY_DOMAIN" =~ ^[a-z0-9.-]+$ ]] || exit 1
[[ "$DEPLOY_PORT" =~ ^[0-9]+$ ]] || exit 1
(( DEPLOY_PORT >= 1 && DEPLOY_PORT <= 65534 )) || exit 1
[[ "$REMOTE_NODE" =~ ^/[a-zA-Z0-9/._-]+$ ]] || exit 1

if [[ "${ALLOW_DIRTY:-0}" != 1 ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit changes before deploying (or explicitly set ALLOW_DIRTY=1)." >&2
  exit 1
fi

npm run typecheck
npm test
npm run build

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
mkdir -p "$STAGE/app"
# Copy only the standalone server and compiled application, not its env files.
cp .next/standalone/server.js package.json package-lock.json "$STAGE/app/"
cp -R .next/standalone/.next "$STAGE/app/.next"
cp -R .next/static "$STAGE/app/.next/static"
if [[ -d public ]]; then cp -R public "$STAGE/app/public"; fi
rm -rf "$STAGE/app/.next/cache"
mkdir -p "$STAGE/app/.next/cache"
printf '%s\n' "$RELEASE" > "$STAGE/app/RELEASE"
sed -e "s/__DOMAIN__/$DEPLOY_DOMAIN/g" -e "s/__PORT__/$DEPLOY_PORT/g" \
  deploy/nginx.conf.template > "$STAGE/nginx.conf"
sed -e "s/__PORT__/$DEPLOY_PORT/g" -e "s|__NODE__|$REMOTE_NODE|g" \
  deploy/astropath.service.template > "$STAGE/astropath.service"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$STAGE/release.tar.gz" -C "$STAGE/app" .

ssh "$REMOTE_HOST" "mkdir -p /app/astropath/releases/$RELEASE /app/astropath/shared /app/astropath/acme"
scp "$STAGE/release.tar.gz" "$STAGE/nginx.conf" "$STAGE/astropath.service" \
  "$REMOTE_HOST:/app/astropath/releases/$RELEASE/"
ssh "$REMOTE_HOST" bash -s -- "$RELEASE" "$DEPLOY_PORT" "$REMOTE_NODE" "$DEPLOY_DOMAIN" <<'REMOTE'
set -euo pipefail
release="$1"; port="$2"; node="$3"; domain="$4"
root=/app/astropath
target="$root/releases/$release"
test -s "$root/shared/app.env"
id astropath >/dev/null 2>&1 || useradd --system --home-dir "$root" --shell /sbin/nologin astropath
chmod 700 "$root/shared"
chmod 600 "$root/shared/app.env"
cd "$target"
tar -xzf release.tar.gz
rm release.tar.gz
export PATH="$(dirname "$node"):$PATH"
npm ci --omit=dev --no-audit --no-fund
chown -R root:astropath "$target"
chmod -R g+rX,o-rwx "$target"
chown astropath:astropath "$target/.next/cache"

# Preflight on a separate loopback port before changing the live symlink.
stage_port=$((port + 1))
systemd-run --unit=astropath-preflight --collect \
  --property=User=astropath --property=Group=astropath \
  --property="WorkingDirectory=$target" \
  --property="EnvironmentFile=$root/shared/app.env" \
  --setenv=NODE_ENV=production --setenv=HOSTNAME=127.0.0.1 \
  --setenv="PORT=$stage_port" --setenv=NEXT_TELEMETRY_DISABLED=1 \
  "$node" "$target/server.js"
trap 'systemctl stop astropath-preflight 2>/dev/null || true' EXIT
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:$stage_port/api/health" >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [[ "$healthy" != 1 ]]; then
  journalctl -u astropath-preflight -n 30 --no-pager
  exit 1
fi
curl --fail --silent "http://127.0.0.1:$stage_port/login" >/dev/null
curl --fail --silent "http://127.0.0.1:$stage_port/openapi.json" >/dev/null
systemctl stop astropath-preflight
trap - EXIT

previous="$(readlink -f "$root/current" || true)"
if [[ -n "$previous" && -d "$previous" ]]; then ln -sfn "$previous" "$root/previous"; fi
ln -sfn "$target" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
install -m 644 "$target/astropath.service" /etc/systemd/system/astropath.service
systemctl daemon-reload
systemctl enable astropath
systemctl restart astropath
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:$port/api/health" >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [[ "$healthy" != 1 ]]; then
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -sfn "$previous" "$root/current"
    install -m 644 "$previous/astropath.service" /etc/systemd/system/astropath.service
    systemctl daemon-reload
    systemctl restart astropath
  fi
  echo "Deployment health check failed; restored previous release when available." >&2
  exit 1
fi

if [[ -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]]; then
  existing=/etc/nginx/conf.d/astropath.conf
  if [[ -f "$existing" ]]; then cp "$existing" "$target/nginx.previous"; fi
  install -m 644 "$target/nginx.conf" "$existing"
  if nginx -t; then
    systemctl reload nginx
  else
    if [[ -f "$target/nginx.previous" ]]; then cp "$target/nginx.previous" "$existing"; else rm "$existing"; fi
    exit 1
  fi
else
  echo "App is running privately. Provision HTTPS, then install $target/nginx.conf."
fi
echo "Deployed $release"
REMOTE
