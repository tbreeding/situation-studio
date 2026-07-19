#!/usr/bin/env bash
set -euo pipefail

studio_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
studio_shared_dir="${SITUATION_STUDIO_SHARED_DIR:-/home/admin/projects/situation-studio/shared}"
studio_env_file="${studio_shared_dir}/publisher.env"

if [[ ! -r "${studio_env_file}" ]]; then
  echo "Situation Studio publisher environment is unavailable." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${studio_env_file}"
set +a

studio_node_version="$(tr -d '[:space:]' < "${studio_root}/.nvmrc")"
studio_node_bin="/home/admin/.nvm/versions/node/v${studio_node_version}/bin"
studio_node="${studio_node_bin}/node"
studio_tsx="${studio_root}/apps/publisher/node_modules/tsx/dist/cli.mjs"

if [[ ! -x "${studio_node}" || ! -f "${studio_tsx}" ]]; then
  echo "Pinned Situation Studio publisher runtime is incomplete." >&2
  exit 1
fi

export PATH="${studio_node_bin}:${PATH}"
cd "${studio_root}"

case "${PUBLICATION_BACKEND:-git}" in
  git)
    mkdir -p "${PUBLISHER_STATE_ROOT:?missing publisher state root}"
    chmod 0700 "${PUBLISHER_STATE_ROOT}"
    exec "${studio_node}" "${studio_tsx}" apps/publisher/src/main.ts
    ;;
  database)
    exec "${studio_node}" "${studio_tsx}" apps/publisher/src/database-main.ts
    ;;
  *)
    echo "PUBLICATION_BACKEND must be git or database." >&2
    exit 1
    ;;
esac
