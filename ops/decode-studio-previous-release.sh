#!/usr/bin/env bash
set -euo pipefail

if [[ "${#}" -ne 2 ]]; then
  echo "Previous-release decoding requires the Studio root and one encoded value." >&2
  exit 64
fi

studio_root="${1}"
encoded_previous="${2}"
if [[
  ! "${studio_root}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${studio_root}" == "/" ||
  "${studio_root}" == */ ||
  "${studio_root}" == *"/../"* ||
  "${studio_root}" == *"/.." ||
  "${studio_root}" == *"//"*
]]; then
  echo "The Studio root is unsafe." >&2
  exit 1
fi

if [[ "${encoded_previous}" == "NO_PREVIOUS_STUDIO_RELEASE" ]]; then
  exit 0
fi

previous_release_prefix="${studio_root}/releases/"
previous_release_id="${encoded_previous#"${previous_release_prefix}"}"
if [[
  "${encoded_previous}" != "${previous_release_prefix}${previous_release_id}" ||
  ! "${previous_release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$
]]; then
  echo "The previous Studio release is not a direct immutable timestamp release." >&2
  exit 1
fi

printf '%s\n' "${encoded_previous}"
