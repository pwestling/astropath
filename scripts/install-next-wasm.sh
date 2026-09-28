#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

next_version="$(node -p 'require("./node_modules/next/package.json").version')"
package_dir="$repo_dir/node_modules/next/wasm/@next/swc-wasm-nodejs"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

archive="$(npm pack --silent --pack-destination "$scratch" "@next/swc-wasm-nodejs@$next_version")"
mkdir -p "$package_dir"
tar -xzf "$scratch/$archive" -C "$package_dir" --strip-components=1
chmod a+rx "$repo_dir/node_modules/next/wasm" "$repo_dir/node_modules/next/wasm/@next" "$package_dir"
chmod -R a+rX "$package_dir"

echo "Installed Next.js $next_version WebAssembly compiler for the RackNerd development server."
