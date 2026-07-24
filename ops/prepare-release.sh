#!/usr/bin/env bash
set -euo pipefail

release_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${release_root}"

pnpm install --frozen-lockfile
pnpm db:generate
pnpm verify

git_status="$(git status --short)"
if [[ -n "${git_status}" ]]; then
  echo "Release preparation completed, but the source tree is not clean." >&2
  exit 1
fi

printf '{"commit":"%s","prepared":true,"deployed":false}\n' \
  "$(git rev-parse HEAD)"
