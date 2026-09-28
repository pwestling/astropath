#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
infra_repo="${VPS_INFRA_REPO:-/Users/pwestling/dev/personal/vps}"
target=root@vps-01.tailf51383.ts.net
ssh_options=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$infra_repo/hosts/vps-01/ssh_known_hosts"
  -o ConnectTimeout=15
)

if [[ -n "$(git -C "$repo_dir" status --porcelain)" ]]; then
  echo "Commit the app source before deploying it." >&2
  exit 1
fi
test -s "$infra_repo/hosts/vps-01/ssh_known_hosts"
revision="$(git -C "$repo_dir" rev-parse HEAD)"
release="$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:7}"
stage="/var/tmp/deaddrop-build-$release"

# The archive contains committed source only. No local .env file, .git directory,
# macOS dependency tree, or build cache crosses to the server.
git -C "$repo_dir" archive HEAD |
  ssh "${ssh_options[@]}" "$target" \
    "mkdir -m 0700 '$stage' && tar --no-same-owner -xf - -C '$stage'"

ssh "${ssh_options[@]}" "$target" bash -s -- "$release" "$revision" <<'REMOTE'
set -euo pipefail
release="$1"
revision="$2"
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7}$ ]]
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
stage="/var/tmp/deaddrop-build-$release"
target="/srv/deaddrop/releases/$release"
exec 9>/run/lock/deaddrop-release.lock
flock -n 9 || { echo "Another Deaddrop deployment is running." >&2; exit 1; }
trap 'rm -rf -- "$stage"' EXIT

test -s /var/lib/app-secrets/deaddrop.env
test -f "$stage/package-lock.json"
test ! -e "$target"
id deaddrop >/dev/null
node_store="$(nix eval --raw --impure --expr '(builtins.getFlake "/etc/nixos").inputs.nixpkgs.legacyPackages.x86_64-linux.nodejs_24.outPath')"
test -x "$node_store/bin/node"

# Build from locked inputs on Linux, with no production credentials in the build
# environment. The host's build slice leaves headroom for PostgreSQL and SSH.
systemd-run --scope --collect --quiet --slice=builds.slice \
  --property=MemoryHigh=3G --property=MemoryMax=4G \
  --property=MemorySwapMax=512M --property=TasksMax=4096 \
  --working-directory="$stage" \
  --setenv="PATH=$node_store/bin:/run/current-system/sw/bin:/usr/bin:/bin" \
  --setenv="npm_config_cache=$stage/.npm-cache" \
  --setenv=NEXT_TELEMETRY_DISABLED=1 \
  /run/current-system/sw/bin/bash -c 'npm ci --no-audit --no-fund && npm run typecheck && npm test && npm run build'

install -d -m 0755 /srv/deaddrop /srv/deaddrop/releases
mkdir -m 0750 "$target"
cp -a "$stage/.next/standalone/." "$target/"
install -d -m 0750 "$target/.next"
cp -a "$stage/.next/static" "$target/.next/static"
if [[ -d "$stage/public" ]]; then cp -a "$stage/public" "$target/public"; fi
rm -rf -- "$target/.next/cache"
install -d -m 0750 -o deaddrop -g deaddrop "/var/cache/deaddrop/$release"
ln -s "/var/cache/deaddrop/$release" "$target/.next/cache"
printf '%s\n' "$revision" > "$target/REVISION"
chown -R root:deaddrop "$target"
chmod -R u=rwX,g=rX,o= "$target"
artifact_sha256="$(tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$target" -cf - . | sha256sum | cut -d' ' -f1)"
printf '%s\n' "$artifact_sha256" > "$target.sha256"

# The preflight serves only loopback and does not change the active release.
preflight_unit="deaddrop-preflight-$release.service"
systemd-run --unit="${preflight_unit%.service}" --collect --quiet \
  --slice=apps.slice --working-directory="$target" \
  --property=User=deaddrop --property=Group=deaddrop \
  --property=EnvironmentFile=/var/lib/app-secrets/deaddrop.env \
  --property=MemoryMax=768M --property=TasksMax=256 \
  --setenv=NODE_ENV=production --setenv=HOSTNAME=127.0.0.1 \
  --setenv=PORT=4311 --setenv=NEXT_TELEMETRY_DISABLED=1 \
  "$node_store/bin/node" "$target/server.js"
trap 'systemctl stop "$preflight_unit" >/dev/null 2>&1 || true; rm -rf -- "$stage"' EXIT
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:4311/api/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" != 1 ]]; then
  echo "Deaddrop preflight did not become healthy." >&2
  exit 1
fi
curl --fail --silent http://127.0.0.1:4311/login >/dev/null
curl --fail --silent http://127.0.0.1:4311/openapi.json >/dev/null
systemctl stop "$preflight_unit"
trap 'rm -rf -- "$stage"' EXIT

previous="$(readlink -f /srv/deaddrop/current 2>/dev/null || true)"
if [[ -n "$previous" && -d "$previous" ]]; then
  ln -sfn "$previous" /srv/deaddrop/previous
fi
ln -s "$target" /srv/deaddrop/current.next
mv -Tf /srv/deaddrop/current.next /srv/deaddrop/current
systemctl restart deaddrop.service
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:4310/api/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" != 1 ]]; then
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -s "$previous" /srv/deaddrop/current.next
    mv -Tf /srv/deaddrop/current.next /srv/deaddrop/current
    systemctl restart deaddrop.service
  else
    systemctl stop deaddrop.service
  fi
  echo "Deaddrop did not become healthy; the previous release was restored when available." >&2
  exit 1
fi

echo "Deaddrop release $release is healthy on loopback; artifact SHA-256 $artifact_sha256"
REMOTE
