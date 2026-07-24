#!/usr/bin/env bash
set -euo pipefail

: "${SITUATION_STUDIO_RELEASE:?missing release directory}"
: "${SITUATION_STUDIO_PROCESS_ENV_FILE:?missing process environment file}"

process_name="${1:-}"
case "${process_name}" in
  web)
    command_kind="pnpm"
    command_name="start"
    ;;
  review-worker)
    command_kind="pnpm"
    command_name="start:review-worker"
    ;;
  publisher)
    command_kind="pnpm"
    command_name="start:publisher"
    ;;
  backup-queue)
    command_kind="script"
    command_name="ops/process-backup-queue.sh"
    ;;
  backup-nightly)
    command_kind="script"
    command_name="ops/enqueue-nightly-backup.sh"
    ;;
  *)
    echo "Expected web, review-worker, publisher, backup-queue, or backup-nightly." >&2
    exit 64
    ;;
esac

environment_file="${SITUATION_STUDIO_PROCESS_ENV_FILE}"
if [[ ! -f "${environment_file}" ]]; then
  echo "Missing process environment file: ${environment_file}" >&2
  exit 1
fi

environment_mode="$(stat -f '%Lp' "${environment_file}" 2>/dev/null || stat -c '%a' "${environment_file}")"
if [[ "${environment_mode}" != "600" && "${environment_mode}" != "400" ]]; then
  echo "Process environment file must have mode 0600 or 0400." >&2
  exit 1
fi
environment_owner="$(stat -f '%u' "${environment_file}" 2>/dev/null || stat -c '%u' "${environment_file}")"
if [[ "${environment_owner}" != "$(id -u)" ]]; then
  echo "Process environment file must be owned by the service user." >&2
  exit 1
fi

service_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
service_user="$(id -un)"
if [[ -z "${service_home}" || ! -d "${service_home}" ]]; then
  echo "Service user has no usable home directory." >&2
  exit 1
fi
runtime_path="${service_home}/.local/bin:${PATH}"
exec env -i \
  HOME="${service_home}" \
  PATH="${runtime_path}" \
  USER="${service_user}" \
  LOGNAME="${service_user}" \
  NODE_ENV=production \
  SITUATION_STUDIO_RELEASE="${SITUATION_STUDIO_RELEASE}" \
  SITUATION_STUDIO_PROCESS_ENV_FILE="${environment_file}" \
  SITUATION_STUDIO_COMMAND_KIND="${command_kind}" \
  SITUATION_STUDIO_COMMAND="${command_name}" \
  /bin/bash -c '
    set -euo pipefail
    cd "${SITUATION_STUDIO_RELEASE}"
    set -a
    source "${SITUATION_STUDIO_PROCESS_ENV_FILE}"
    set +a
    if [[ "${SITUATION_STUDIO_COMMAND_KIND}" == "pnpm" ]]; then
      exec pnpm "${SITUATION_STUDIO_COMMAND}"
    fi
    exec "${SITUATION_STUDIO_RELEASE}/${SITUATION_STUDIO_COMMAND}"
  '
