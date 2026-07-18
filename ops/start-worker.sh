#!/usr/bin/env bash
set -euo pipefail

studio_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
studio_shared_dir="${SITUATION_STUDIO_SHARED_DIR:-/home/admin/projects/situation-studio/shared}"
studio_env_file="${studio_shared_dir}/worker.env"

if [[ ! -r "${studio_env_file}" ]]; then
  echo "Situation Studio worker environment is unavailable." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${studio_env_file}"
set +a

studio_node_version="$(tr -d '[:space:]' < "${studio_root}/.nvmrc")"
studio_node="/home/admin/.nvm/versions/node/v${studio_node_version}/bin/node"
studio_tsx="${studio_root}/apps/worker/node_modules/tsx/dist/cli.mjs"

if [[ ! -x "${studio_node}" || ! -f "${studio_tsx}" ]]; then
  echo "Pinned Situation Studio worker runtime is incomplete." >&2
  exit 1
fi

cd "${studio_root}"
exec "${studio_node}" "${studio_tsx}" apps/worker/src/main.ts
