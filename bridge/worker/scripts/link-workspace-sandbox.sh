#!/usr/bin/env bash
# Monorepo only: use packages/sandbox instead of the registry package from
# package.json ("next"). No-op outside this repository.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source_pkg="$root/packages/sandbox"
target="$root/bridge/worker/node_modules/@cloudflare/sandbox"

[[ -d "$source_pkg" ]] || exit 0

mkdir -p "$(dirname "$target")"
rm -rf "$target"
ln -s ../../../packages/sandbox "$target"
