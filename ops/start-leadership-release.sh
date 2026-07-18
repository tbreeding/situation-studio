#!/usr/bin/env bash
set -euo pipefail

leadership_link="${LEADERSHIP_RELEASE_LINK:?missing Leadership release link}"
leadership_release="$(readlink -f "${leadership_link}")"
studio_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
leadership_node_version="$(tr -d '[:space:]' < "${studio_root}/.nvmrc")"
leadership_node="/home/admin/.nvm/versions/node/v${leadership_node_version}/bin/node"
leadership_next="${leadership_release}/node_modules/next/dist/bin/next"

if [[ ! -d "${leadership_release}" || ! -x "${leadership_node}" || ! -f "${leadership_next}" || ! -d "${leadership_release}/.next" ]]; then
  echo "Leadership release runtime is incomplete." >&2
  exit 1
fi

cd "${leadership_release}"
exec "${leadership_node}" "${leadership_next}" start \
  --hostname "${LEADERSHIP_BIND_ADDRESS:-192.168.1.120}" \
  --port "${LEADERSHIP_PORT:?missing Leadership port}"
