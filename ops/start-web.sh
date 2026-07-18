#!/usr/bin/env bash
set -euo pipefail

studio_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
studio_shared_dir="${SITUATION_STUDIO_SHARED_DIR:-/home/admin/projects/situation-studio/shared}"
studio_env_file="${studio_shared_dir}/web.env"

if [[ ! -r "${studio_env_file}" ]]; then
  echo "Situation Studio web environment is unavailable." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${studio_env_file}"
set +a

studio_node_version="$(tr -d '[:space:]' < "${studio_root}/.nvmrc")"
studio_node="/home/admin/.nvm/versions/node/v${studio_node_version}/bin/node"
studio_next="${studio_root}/apps/web/node_modules/next/dist/bin/next"

if [[ ! -x "${studio_node}" || ! -f "${studio_next}" ]]; then
  echo "Pinned Situation Studio runtime is incomplete." >&2
  exit 1
fi

exec "${studio_node}" "${studio_next}" start \
  --hostname "${SITUATION_STUDIO_BIND_ADDRESS:?missing bind address}" \
  --port "${SITUATION_STUDIO_PORT:-3015}"
