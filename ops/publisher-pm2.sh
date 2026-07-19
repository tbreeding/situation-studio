#!/usr/bin/env bash
set -eo pipefail

set +u
source /home/admin/.nvm/nvm.sh
nvm use default >/dev/null
set -u

exec pm2 "$@"
