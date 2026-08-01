#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
studio_root="${2:-}"
lease_token="${3:-}"
studio_commit="${4:-}"
studio_release_id="${5:-}"

fail() {
  echo "${1}" >&2
  exit "${2:-1}"
}

path_owner() {
  stat -c '%u' "${1}" 2>/dev/null || stat -f '%u' "${1}"
}

path_mode() {
  stat -c '%a' "${1}" 2>/dev/null || stat -f '%Lp' "${1}"
}

if [[
  ! "${studio_root}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${studio_root}" == "/" ||
  "${studio_root}" == */ ||
  "${studio_root}" == *"/../"* ||
  "${studio_root}" == *"/.." ||
  "${studio_root}" == *"//"*
]]; then
  fail "The Studio deployment lease root is not a safe absolute path."
fi
if [[ ! "${lease_token}" =~ ^[a-f0-9]{64}$ ]]; then
  fail "The Studio deployment lease token is invalid."
fi
case "${action}" in
  acquire | assert | release) ;;
  *) fail "The Studio deployment lease action must be acquire, assert, or release." ;;
esac

shared_root="${studio_root}/shared"
lease_root="${shared_root}/.deployment-lease"
lease_token_path="${lease_root}/token"
lease_metadata_path="${lease_root}/metadata"

require_protected_parent() {
  local directory_path="${1}"
  local directory_mode
  local permission_bits
  if [[
    ! -d "${directory_path}" ||
    -L "${directory_path}" ||
    "$(path_owner "${directory_path}")" != "$(id -u)"
  ]]; then
    fail "The Studio deployment lease requires deployment-owned real parent directories."
  fi
  directory_mode="$(path_mode "${directory_path}")"
  if [[ ! "${directory_mode}" =~ ^[0-7]{3,4}$ ]]; then
    fail "The Studio deployment lease parent directory mode is invalid."
  fi
  permission_bits="${directory_mode: -3}"
  if (((8#${permission_bits} & 8#022) != 0)); then
    fail "The Studio deployment lease parent directories must not be group- or world-writable."
  fi
}

require_protected_parent "${studio_root}"
require_protected_parent "${shared_root}"

assert_lease() {
  if [[
    ! -d "${lease_root}" ||
    -L "${lease_root}" ||
    "$(path_owner "${lease_root}")" != "$(id -u)" ||
    "$(path_mode "${lease_root}")" != "700" ||
    ! -f "${lease_token_path}" ||
    -L "${lease_token_path}" ||
    "$(path_owner "${lease_token_path}")" != "$(id -u)" ||
    "$(path_mode "${lease_token_path}")" != "600" ||
    "$(wc -c <"${lease_token_path}" | tr -d '[:space:]')" != "65" ||
    "$(cat "${lease_token_path}")" != "${lease_token}" ||
    ! -f "${lease_metadata_path}" ||
    -L "${lease_metadata_path}" ||
    "$(path_owner "${lease_metadata_path}")" != "$(id -u)" ||
    "$(path_mode "${lease_metadata_path}")" != "600"
  ]]; then
    fail "The Studio deployment lease is absent, unsafe, or owned by another deployment."
  fi

  shopt -s dotglob nullglob
  lease_entries=("${lease_root}"/*)
  shopt -u dotglob nullglob
  if [[
    "${#lease_entries[@]}" != "2" ||
    ! -e "${lease_token_path}" ||
    ! -e "${lease_metadata_path}"
  ]]; then
    fail "The Studio deployment lease contains unexpected state."
  fi
}

case "${action}" in
  acquire)
    if [[
      ! "${studio_commit}" =~ ^[a-f0-9]{40}$ ||
      ! "${studio_release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$
    ]]; then
      fail "The Studio deployment lease metadata is invalid."
    fi
    if ! mkdir -m 0700 -- "${lease_root}" 2>/dev/null; then
      if [[
        -d "${lease_root}" &&
        ! -L "${lease_root}" &&
        -f "${lease_token_path}" &&
        ! -L "${lease_token_path}" &&
        -f "${lease_metadata_path}" &&
        ! -L "${lease_metadata_path}"
      ]]; then
        fail \
          "A Studio deployment lease already exists. Do not remove it automatically; follow the production recovery runbook." \
          75
      fi
      fail \
        "An incomplete or unsafe Studio deployment lease exists. Do not repair or remove it automatically; follow the production recovery runbook." \
        75
    fi
    umask 077
    printf '%s\n' "${lease_token}" >"${lease_token_path}"
    printf \
      'schema=studio-deployment-lease-v1\nstarted_at=%s\ncommit=%s\nrelease_id=%s\noperator=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "${studio_commit}" \
      "${studio_release_id}" \
      "$(id -un)" \
      >"${lease_metadata_path}"
    chmod 0600 "${lease_token_path}" "${lease_metadata_path}"
    assert_lease
    ;;
  assert)
    assert_lease
    ;;
  release)
    assert_lease
    rm -- "${lease_token_path}" "${lease_metadata_path}"
    rmdir -- "${lease_root}"
    ;;
esac
