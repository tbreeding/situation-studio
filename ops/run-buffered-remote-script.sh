#!/usr/bin/env bash
set -euo pipefail

remote_script="$(cat)"
if [[ ! "${remote_script}" =~ [^[:space:]] ]]; then
  echo "The buffered remote script is empty." >&2
  exit 64
fi

# Read the complete SSH payload before executing it. Commands inside the
# payload therefore inherit an exhausted stdin and cannot consume unparsed
# shell source from a `bash -s` stream.
exec /bin/bash -c "${remote_script}" -- "$@" </dev/null
