#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-deploy}"
case "$mode" in
  deploy|--prepare) ;;
  --activate|--activate-migrated)
    [[ "${2:-}" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7}$ ]] || { echo 'Supply the prepared release ID.' >&2; exit 1; } ;;
  *) echo 'Usage: deploy-vps-01.sh [--prepare | --activate RELEASE | --activate-migrated RELEASE]' >&2; exit 1 ;;
esac
target=root@100.107.251.43
known_hosts="$repo_dir/deploy/vps-01-known_hosts"
ssh_options=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$known_hosts"
  -o ConnectTimeout=15
)

status="$(git -C "$repo_dir" status --porcelain --untracked-files=all)"
if [[ -n "$status" ]]; then
  # Next dev rewrites this tracked file to reference .next/dev/types. The
  # release archive still contains the committed production version.
  if [[ "$status" != ' M next-env.d.ts' ]] ||
    ! cmp -s "$repo_dir/next-env.d.ts" \
      <(git -C "$repo_dir" show HEAD:next-env.d.ts | sed 's#\.next/types/#.next/dev/types/#g'); then
    echo "Commit the app source before deploying it (only generated next-env.d.ts changes are allowed)." >&2
    git -C "$repo_dir" status --short >&2
    exit 1
  fi
fi
test -s "$known_hosts"
revision="$(git -C "$repo_dir" rev-parse HEAD)"
release="${2:-$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:7}}"
stage="/var/tmp/astropath-build-$release"

# The archive contains committed source only. No local .env file, .git directory,
# dependency tree, or build cache crosses to the server.
if [[ "$mode" != --activate* ]]; then
git -C "$repo_dir" archive HEAD |
  ssh "${ssh_options[@]}" "$target" \
    "mkdir -m 0700 '$stage' && tar --no-same-owner -xf - -C '$stage'"
fi

ssh "${ssh_options[@]}" "$target" bash -s -- "$release" "$revision" "$mode" <<'REMOTE'
set -euo pipefail
release="$1"
revision="$2"
mode="$3"
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7}$ ]]
[[ "$revision" =~ ^[a-f0-9]{40}$ ]]
stage="/var/tmp/astropath-build-$release"
target="/srv/astropath/releases/$release"
exec 9>/run/lock/astropath-release.lock
flock -n 9 || { echo "Another Astropath deployment is running." >&2; exit 1; }
# Keep prepared migration tools available if activation fails.
cleanup_stage() { if [[ "$mode" != --activate* ]]; then rm -rf -- "$stage"; fi; }
trap cleanup_stage EXIT

test -s /var/lib/app-secrets/astropath.env
test -f "$stage/package-lock.json"
if [[ "$mode" == --activate* ]]; then
  test "$(cat "$target/REVISION")" = "$revision"
else
  test ! -e "$target"
fi
id astropath >/dev/null
node_store="$(nix eval --raw --impure --expr '(builtins.getFlake "/etc/nixos").inputs.nixpkgs.legacyPackages.x86_64-linux.nodejs_24.outPath')"
test -x "$node_store/bin/node"

if [[ "$mode" != --activate* ]]; then
# Build from locked inputs on Linux, with no production credentials in the build
# environment. The host's build slice leaves headroom for PostgreSQL and SSH.
# Two test workers at a time: four in-memory databases at once push the scope past
# MemoryHigh, and the reclaim stall makes their setup hooks time out.
systemd-run --scope --collect --quiet --slice=builds.slice \
  --property=MemoryHigh=3G --property=MemoryMax=4G \
  --property=MemorySwapMax=512M --property=TasksMax=4096 \
  --working-directory="$stage" \
  --setenv="PATH=$node_store/bin:/run/current-system/sw/bin:/usr/bin:/bin" \
  --setenv="npm_config_cache=$stage/.npm-cache" \
  --setenv=NEXT_TELEMETRY_DISABLED=1 \
  /run/current-system/sw/bin/bash -c 'npm ci --no-audit --no-fund && npm run typecheck && npm test -- --maxWorkers=2 && npm run build'

install -d -m 0755 /srv/astropath /srv/astropath/releases
mkdir -m 0750 "$target"
cp -a "$stage/.next/standalone/." "$target/"
install -d -m 0750 "$target/.next"
cp -a "$stage/.next/static" "$target/.next/static"
if [[ -d "$stage/public" ]]; then cp -a "$stage/public" "$target/public"; fi
rm -rf -- "$target/.next/cache"
install -d -m 0750 -o astropath -g astropath "/var/cache/astropath/$release"
ln -s "/var/cache/astropath/$release" "$target/.next/cache"
printf '%s\n' "$revision" > "$target/REVISION"
chown -R root:astropath "$target"
chmod -R u=rwX,g=rX,o= "$target"
artifact_sha256="$(tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -C "$target" -cf - . | sha256sum | cut -d' ' -f1)"
printf '%s\n' "$artifact_sha256" > "$target.sha256"
fi
if [[ "$mode" == --prepare ]]; then
  # Retain locked source/dependencies for an explicit schema rehearsal/migration.
  # No production environment is written into the build tree.
  chown -R root:astropath "$stage"
  chmod -R g+rX,o= "$stage"
  trap - EXIT
  echo "Prepared release $release; source $stage. No service or schema changed."
  exit 0
fi

# The preflight serves only loopback and does not change the active release.
preflight_unit="astropath-preflight-$release.service"
systemd-run --unit="${preflight_unit%.service}" --collect --quiet \
  --slice=apps.slice --working-directory="$target" \
  --property=User=astropath --property=Group=astropath \
  --property=EnvironmentFile=/var/lib/app-secrets/astropath.env \
  --property=MemoryMax=768M --property=TasksMax=256 \
  --setenv=NODE_ENV=production --setenv=HOSTNAME=127.0.0.1 \
  --setenv=PORT=4311 --setenv=NEXT_TELEMETRY_DISABLED=1 \
  "$node_store/bin/node" "$target/server.js"
trap 'systemctl stop "$preflight_unit" >/dev/null 2>&1 || true; cleanup_stage' EXIT
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:4311/api/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" != 1 ]]; then
  echo "Astropath preflight did not become healthy." >&2
  exit 1
fi
curl --fail --silent http://127.0.0.1:4311/login >/dev/null
curl --fail --silent http://127.0.0.1:4311/openapi.json >/dev/null
curl --fail --silent http://127.0.0.1:4311/llms.txt | cmp - "$target/public/llms.txt"
systemctl stop "$preflight_unit"
trap cleanup_stage EXIT

previous="$(readlink -f /srv/astropath/current 2>/dev/null || true)"
if [[ -n "$previous" && -d "$previous" ]]; then
  ln -sfn "$previous" /srv/astropath/previous
fi
ln -s "$target" /srv/astropath/current.next
mv -Tf /srv/astropath/current.next /srv/astropath/current
healthy=0
# A slow stop (open long-polls hit TimeoutStopSec and are killed) makes the
# restart job report failure even though the new process starts, so judge
# the result by health and by which release the running process serves.
systemctl restart astropath.service || true
for attempt in $(seq 1 30); do
  pid="$(systemctl show astropath.service -p ExecMainPID --value)"
  if [[ "$pid" != 0 && "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" == "$target" ]] &&
    curl --fail --silent http://127.0.0.1:4310/api/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" != 1 ]]; then
  if [[ "$mode" != --activate-migrated && -n "$previous" && -d "$previous" ]]; then
    ln -s "$previous" /srv/astropath/current.next
    mv -Tf /srv/astropath/current.next /srv/astropath/current
    systemctl restart astropath.service
  else
    systemctl stop astropath.service
  fi
  echo "Astropath did not become healthy. A migrated deployment remains stopped; restore its database before any old-binary rollback." >&2
  exit 1
fi

echo "Astropath release $release is healthy on loopback; artifact SHA-256 $(cat "$target.sha256")"
rm -rf -- "$stage"
REMOTE
