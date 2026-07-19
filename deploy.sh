#!/usr/bin/env bash
set -euo pipefail

studio_host="${SITUATION_STUDIO_DEPLOY_HOST:-rpi1-ts}"
studio_root="/home/admin/projects/situation-studio"
studio_release_id="${SITUATION_STUDIO_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
studio_release="${studio_root}/releases/${studio_release_id}"
studio_commit="$(git rev-parse HEAD)"
studio_archive_limit_bytes=$((50 * 1024 * 1024))

if [[ "${SITUATION_STUDIO_APPROVED_COMMIT:-}" != "${studio_commit}" ]]; then
  echo "Production deployment requires explicit approval for exact commit ${studio_commit}." >&2
  echo "Set SITUATION_STUDIO_APPROVED_COMMIT=${studio_commit} only after that approval is recorded." >&2
  exit 1
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Production deployment is allowed only from main." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Production deployment requires a clean worktree." >&2
  exit 1
fi

studio_remote_main="$(git ls-remote origin refs/heads/main | cut -f1)"
if [[ "${studio_remote_main}" != "${studio_commit}" ]]; then
  echo "Exact commit ${studio_commit} is not the pushed origin/main (${studio_remote_main:-missing})." >&2
  exit 1
fi

studio_archive_bytes="$(git archive --format=tar "${studio_commit}" | wc -c | tr -d ' ')"
if (( studio_archive_bytes > studio_archive_limit_bytes )); then
  echo "Committed source archive is ${studio_archive_bytes} bytes; refusing the ${studio_archive_limit_bytes}-byte production limit." >&2
  exit 1
fi

if [[ ! "${studio_release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "SITUATION_STUDIO_RELEASE_ID must use the UTC YYYYMMDDTHHMMSSZ form." >&2
  exit 1
fi

echo "[1/11] Preflighting the healthy shared production host"
ssh "${studio_host}" "set -e; test -r '${studio_root}/shared/publisher.env'; test -L '${studio_root}/current'; curl -fsS -H 'Host: situation-studio.timsprototypes.com' http://192.168.1.120:3015/health/live >/dev/null; curl -fsS -H 'Host: situation-studio.timsprototypes.com' http://192.168.1.120:3015/health/ready >/dev/null; test \"\$(awk '/MemAvailable:/ {print \$2}' /proc/meminfo)\" -ge 1048576; test \"\$(df --output=avail -B1 '${studio_root}' | tail -1)\" -ge 5368709120"

if [[ "${SITUATION_STUDIO_PREFLIGHT_ONLY:-}" == "1" ]]; then
  echo "Production preflight passed for exact commit ${studio_commit}; no release was created."
  exit 0
fi

echo "[2/11] Verifying the complete local workspace"
pnpm verify

echo "[3/11] Creating an immutable RP1 release from committed source only (${studio_archive_bytes} bytes)"
ssh "${studio_host}" "test ! -e '${studio_release}' && mkdir -p '${studio_release}' '${studio_root}/shared'"
git archive --format=tar "${studio_commit}" | ssh "${studio_host}" "tar -xf - -C '${studio_release}'"

echo "[4/11] Installing the pinned Node and pnpm toolchain"
ssh "${studio_host}" "cd '${studio_release}' && source ~/.nvm/nvm.sh && nvm install && corepack enable && corepack prepare pnpm@11.9.0 --activate && pnpm install --frozen-lockfile"

echo "[5/11] Generating the ARM64 database client"
ssh "${studio_host}" "cd '${studio_release}' && source ~/.nvm/nvm.sh && nvm use && corepack pnpm db:generate"

echo "[6/11] Applying committed migrations with the migrator identity"
ssh "${studio_host}" "set -a; source '${studio_root}/shared/migrator.env'; set +a; cd '${studio_release}'; source ~/.nvm/nvm.sh; nvm use; corepack pnpm db:migrate:deploy"

echo "[7/11] Granting explicit runtime and service privileges as the table owner"
ssh "${studio_host}" "docker exec -i postgres16 psql -U situation_studio_migrator -d situation_studio -v ON_ERROR_STOP=1 < '${studio_release}/ops/grant-runtime-privileges.sql' && docker exec -i postgres16 psql -U situation_studio_migrator -d situation_studio -v ON_ERROR_STOP=1 < '${studio_release}/ops/grant-service-privileges.sql' && docker exec -i postgres16 psql -U situation_studio_migrator -d situation_studio -v ON_ERROR_STOP=1 < '${studio_release}/ops/grant-database-publication-privileges.sql'"

echo "[8/11] Importing the immutable Leadership baseline idempotently"
ssh "${studio_host}" "set -a; source '${studio_root}/shared/web.env'; set +a; cd '${studio_release}'; source ~/.nvm/nvm.sh; nvm use; corepack pnpm --filter @situation-studio/web import:baseline"

echo "[9/11] Building with production cookie and origin policy"
ssh "${studio_host}" "set -a; source '${studio_root}/shared/web.env'; set +a; cd '${studio_release}'; source ~/.nvm/nvm.sh; nvm use; corepack pnpm build"

echo "[10/11] Cutting over the release and reloading PM2"
studio_previous="$(ssh "${studio_host}" "if [ -L '${studio_root}/current' ] && [ -e '${studio_root}/current' ]; then readlink -f '${studio_root}/current'; fi")"
ssh "${studio_host}" "test -r '${studio_root}/shared/worker.env' && test -r '${studio_root}/shared/publisher.env' && ln -sfn '${studio_release}' '${studio_root}/current.next' && mv -Tf '${studio_root}/current.next' '${studio_root}/current' && cd '${studio_root}/current' && source ~/.nvm/nvm.sh && (pm2 delete situation-studio-web situation-studio-worker situation-studio-publisher >/dev/null 2>&1 || true) && pm2 start ecosystem.config.cjs --update-env && (pm2 delete leadership-field-guide leadership-field-guide-preview >/dev/null 2>&1 || true) && pm2 start ops/leadership-processes.config.cjs --update-env"

echo "[11/11] Verifying liveness and database readiness"
if ! ssh "${studio_host}" "set -a; source '${studio_root}/shared/web.env'; set +a; for attempt in \$(seq 1 30); do if curl -fsS -H \"Host: \${SITUATION_STUDIO_HOST}\" \"http://\${SITUATION_STUDIO_BIND_ADDRESS}:\${SITUATION_STUDIO_PORT:-3015}/health/live\" >/dev/null && curl -fsS -H \"Host: \${SITUATION_STUDIO_HOST}\" \"http://\${SITUATION_STUDIO_BIND_ADDRESS}:\${SITUATION_STUDIO_PORT:-3015}/health/ready\" >/dev/null && curl -fsS http://192.168.1.120:3005/ >/dev/null && test \"\$(source ~/.nvm/nvm.sh && pm2 pid situation-studio-worker)\" -gt 0 && test \"\$(source ~/.nvm/nvm.sh && pm2 pid situation-studio-publisher)\" -gt 0; then exit 0; fi; sleep 2; done; exit 1"; then
  echo "Release health failed; restoring the previous current symlink." >&2
  if [[ -n "${studio_previous}" && "${studio_previous}" != "${studio_root}/current" ]]; then
    ssh "${studio_host}" "ln -sfn '${studio_previous}' '${studio_root}/current.next' && mv -Tf '${studio_root}/current.next' '${studio_root}/current' && cd '${studio_root}/current' && source ~/.nvm/nvm.sh && (pm2 delete situation-studio-web situation-studio-worker situation-studio-publisher >/dev/null 2>&1 || true) && pm2 start ecosystem.config.cjs --update-env && (pm2 delete leadership-field-guide leadership-field-guide-preview >/dev/null 2>&1 || true) && pm2 start ops/leadership-processes.config.cjs --update-env"
  fi
  exit 1
fi

ssh "${studio_host}" "source ~/.nvm/nvm.sh && pm2 save"
echo "Situation Studio release ${studio_release_id} is healthy. Register or re-check the outer-gate route only through the TimsPrototypes owner UI."
