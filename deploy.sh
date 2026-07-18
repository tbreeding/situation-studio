#!/usr/bin/env bash
set -euo pipefail

studio_host="rpi1-ts"
studio_root="/home/admin/projects/situation-studio"
studio_release_id="${SITUATION_STUDIO_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
studio_release="${studio_root}/releases/${studio_release_id}"

if [[ ! "${studio_release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "SITUATION_STUDIO_RELEASE_ID must use the UTC YYYYMMDDTHHMMSSZ form." >&2
  exit 1
fi

echo "[1/10] Verifying the complete local workspace"
pnpm verify

echo "[2/10] Creating an immutable RP1 release"
ssh "${studio_host}" "mkdir -p '${studio_release}' '${studio_root}/shared'"
rsync -az --delete \
  --exclude='.git' \
  --exclude='.env*' \
  --exclude='.next' \
  --exclude='node_modules' \
  --exclude='test-results' \
  --exclude='playwright-report' \
  ./ "${studio_host}:${studio_release}/"

echo "[3/10] Installing the pinned Node and pnpm toolchain"
ssh "${studio_host}" "cd '${studio_release}' && source ~/.nvm/nvm.sh && nvm install && corepack enable && corepack prepare pnpm@11.9.0 --activate && pnpm install --frozen-lockfile"

echo "[4/10] Generating the ARM64 database client"
ssh "${studio_host}" "cd '${studio_release}' && source ~/.nvm/nvm.sh && nvm use && corepack pnpm db:generate"

echo "[5/10] Applying committed migrations with the migrator identity"
ssh "${studio_host}" "set -a; source '${studio_root}/shared/migrator.env'; set +a; cd '${studio_release}'; source ~/.nvm/nvm.sh; nvm use; corepack pnpm db:migrate:deploy"

echo "[6/10] Granting explicit runtime and service privileges as the table owner"
ssh "${studio_host}" "docker exec -i postgres16 psql -U situation_studio_migrator -d situation_studio -v ON_ERROR_STOP=1 < '${studio_release}/ops/grant-runtime-privileges.sql' && docker exec -i postgres16 psql -U situation_studio_migrator -d situation_studio -v ON_ERROR_STOP=1 < '${studio_release}/ops/grant-service-privileges.sql'"

echo "[7/10] Importing the immutable Leadership baseline idempotently"
ssh "${studio_host}" "set -a; source '${studio_root}/shared/web.env'; set +a; cd '${studio_release}'; source ~/.nvm/nvm.sh; nvm use; corepack pnpm --filter @situation-studio/web import:baseline"

echo "[8/10] Building with production cookie and origin policy"
ssh "${studio_host}" "set -a; source '${studio_root}/shared/web.env'; set +a; cd '${studio_release}'; source ~/.nvm/nvm.sh; nvm use; corepack pnpm build"

echo "[9/10] Cutting over the release and reloading PM2"
studio_previous="$(ssh "${studio_host}" "if [ -L '${studio_root}/current' ] && [ -e '${studio_root}/current' ]; then readlink -f '${studio_root}/current'; fi")"
ssh "${studio_host}" "test -r '${studio_root}/shared/worker.env' && ln -sfn '${studio_release}' '${studio_root}/current.next' && mv -Tf '${studio_root}/current.next' '${studio_root}/current' && cd '${studio_root}/current' && source ~/.nvm/nvm.sh && (pm2 delete situation-studio-web situation-studio-worker >/dev/null 2>&1 || true) && pm2 start ecosystem.config.cjs --update-env"

echo "[10/10] Verifying liveness and database readiness"
if ! ssh "${studio_host}" "set -a; source '${studio_root}/shared/web.env'; set +a; for attempt in \$(seq 1 30); do if curl -fsS -H \"Host: \${SITUATION_STUDIO_HOST}\" \"http://\${SITUATION_STUDIO_BIND_ADDRESS}:\${SITUATION_STUDIO_PORT:-3015}/health/live\" >/dev/null && curl -fsS -H \"Host: \${SITUATION_STUDIO_HOST}\" \"http://\${SITUATION_STUDIO_BIND_ADDRESS}:\${SITUATION_STUDIO_PORT:-3015}/health/ready\" >/dev/null && test \"\$(source ~/.nvm/nvm.sh && pm2 pid situation-studio-worker)\" -gt 0; then exit 0; fi; sleep 2; done; exit 1"; then
  echo "Release health failed; restoring the previous current symlink." >&2
  if [[ -n "${studio_previous}" && "${studio_previous}" != "${studio_root}/current" ]]; then
    ssh "${studio_host}" "ln -sfn '${studio_previous}' '${studio_root}/current.next' && mv -Tf '${studio_root}/current.next' '${studio_root}/current' && cd '${studio_root}/current' && source ~/.nvm/nvm.sh && (pm2 delete situation-studio-web situation-studio-worker >/dev/null 2>&1 || true) && pm2 start ecosystem.config.cjs --update-env"
  fi
  exit 1
fi

ssh "${studio_host}" "source ~/.nvm/nvm.sh && pm2 save"
echo "Situation Studio release ${studio_release_id} is healthy. Register or re-check the protected outer-gate route only through the TimsPrototypes owner UI."
