#!/usr/bin/env bash
set -euo pipefail

leadership_link="${LEADERSHIP_RELEASE_LINK:?missing Leadership release link}"
leadership_release="$(readlink -f "${leadership_link}")"
studio_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
leadership_shared_dir="${LEADERSHIP_SHARED_DIR:-/home/admin/projects/leadership/shared}"
leadership_content_env="${leadership_shared_dir}/content.env"

if [[ -e "${leadership_content_env}" ]]; then
  if [[ ! -r "${leadership_content_env}" ]]; then
    echo "Leadership content environment exists but is unreadable." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${leadership_content_env}"
  set +a
fi

case "${LEADERSHIP_CONTENT_MODE:-filesystem}" in
  filesystem) ;;
  shadow|database)
    : "${LEADERSHIP_DATABASE_URL:?missing Leadership database URL}"
    : "${LEADERSHIP_CONTENT_CACHE_ROOT:?missing Leadership content cache root}"
    : "${STUDIO_CANDIDATE_EXCHANGE_URL:?missing Studio candidate exchange URL}"
    : "${LEADERSHIP_CANDIDATE_EXCHANGE_SECRET:?missing Leadership candidate exchange secret}"
    : "${STUDIO_OBSERVATION_ORIGIN:?missing Studio observation origin}"
    : "${LEADERSHIP_ATTESTATION_SECRET:?missing Leadership attestation secret}"
    : "${LEADERSHIP_ATTESTATION_KEY_ID:?missing Leadership attestation key ID}"
    : "${LEADERSHIP_OBSERVATION_TRIGGER_SECRET:?missing Leadership observation trigger secret}"
    if [[ ${#LEADERSHIP_CANDIDATE_EXCHANGE_SECRET} -lt 32 \
      || ${#LEADERSHIP_ATTESTATION_SECRET} -lt 32 \
      || ${#LEADERSHIP_OBSERVATION_TRIGGER_SECRET} -lt 32 ]]; then
      echo "Leadership database-mode secrets must each contain at least 32 characters." >&2
      exit 1
    fi
    ;;
  *)
    echo "LEADERSHIP_CONTENT_MODE must be filesystem, shadow, or database." >&2
    exit 1
    ;;
esac

leadership_node_version="$(tr -d '[:space:]' < "${studio_root}/.nvmrc")"
leadership_node="/home/admin/.nvm/versions/node/v${leadership_node_version}/bin/node"
leadership_next="${leadership_release}/node_modules/next/dist/bin/next"

if [[ ! -d "${leadership_release}" || ! -x "${leadership_node}" || ! -f "${leadership_next}" || ! -d "${leadership_release}/.next" ]]; then
  echo "Leadership release runtime is incomplete." >&2
  exit 1
fi

export LEADERSHIP_RELEASE_ID="$(basename "${leadership_release}")"
cd "${leadership_release}"
exec "${leadership_node}" "${leadership_next}" start \
  --hostname "${LEADERSHIP_BIND_ADDRESS:-192.168.1.120}" \
  --port "${LEADERSHIP_PORT:?missing Leadership port}"
