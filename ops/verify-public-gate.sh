#!/usr/bin/env bash
set -euo pipefail

: "${SITUATION_STUDIO_PUBLIC_ORIGIN:?missing approved HTTPS origin}"

if [[ "${SITUATION_STUDIO_PUBLIC_ORIGIN}" != https://* ]]; then
  echo "Public-gate verification requires an HTTPS origin." >&2
  exit 1
fi

response_headers="$(mktemp)"
trap 'rm -f -- "${response_headers}"' EXIT
status="$(
  curl \
    --silent \
    --show-error \
    --output /dev/null \
    --dump-header "${response_headers}" \
    --write-out '%{http_code}' \
    "${SITUATION_STUDIO_PUBLIC_ORIGIN}/health/live"
)"

if [[ "${status}" != "403" ]]; then
  echo "Expected the TimsPrototypes access gate to deny an unauthenticated health probe with 403; observed ${status}." >&2
  exit 1
fi
if ! grep -Eiq '^cache-control:.*private.*no-store' "${response_headers}"; then
  echo "Protected origin omitted the required private, no-store cache boundary." >&2
  exit 1
fi

echo "Protected public origin denied the unauthenticated probe with 403 and no-store."
