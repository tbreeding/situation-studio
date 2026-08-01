#!/usr/bin/env bash
set -euo pipefail

: "${WEB_ENVIRONMENT:?missing web environment path}"
: "${EXPECTED_BACKUP_READINESS_MODE:?missing expected backup readiness mode}"

expected_mode="${EXPECTED_BACKUP_READINESS_MODE}"
case "${expected_mode}" in
  required | deferred) ;;
  *)
    echo "Expected backup readiness mode must be required or deferred." >&2
    exit 1
    ;;
esac

if [[ ! -f "${WEB_ENVIRONMENT}" ]]; then
  echo "The Studio web environment is missing." >&2
  exit 1
fi

actual_mode="$(
  set -a
  unset SITUATION_STUDIO_BACKUP_READINESS_MODE
  source "${WEB_ENVIRONMENT}" >&2
  set +a
  printf '%s' "${SITUATION_STUDIO_BACKUP_READINESS_MODE:-}"
)"
if [[ "${actual_mode}" == "${expected_mode}" ]]; then
  exit 0
fi

if [[ "${expected_mode}" == "required" ]]; then
  echo "Follow-up deployment requires backup readiness mode required in web.env." >&2
else
  echo "First deployment requires backup readiness mode deferred in web.env." >&2
fi
exit 1
