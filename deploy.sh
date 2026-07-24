#!/usr/bin/env bash
set -euo pipefail

: "${SITUATION_STUDIO_DEPLOY_HOST:?missing approved deployment host}"
: "${SITUATION_STUDIO_APPROVED_COMMIT:?missing approved commit}"
: "${SITUATION_STUDIO_PUBLIC_ORIGIN:?missing approved HTTPS origin}"
: "${SITUATION_STUDIO_PUBLIC_HOST:?missing approved host header}"

studio_host="${SITUATION_STUDIO_DEPLOY_HOST}"
studio_root="${SITUATION_STUDIO_DEPLOY_ROOT:-/home/admin/projects/situation-studio}"
studio_release_id="${SITUATION_STUDIO_RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
studio_release="${studio_root}/releases/${studio_release_id}"
studio_commit="$(git rev-parse HEAD)"
studio_archive_limit_bytes=$((50 * 1024 * 1024))
public_gate_mode="${SITUATION_STUDIO_PUBLIC_GATE_MODE:-required}"
required_codex_cli_version="0.145.0"
required_claude_cli_version="2.1.218"
web_user="${SITUATION_STUDIO_WEB_USER:-situation-studio-web}"
review_user="${SITUATION_STUDIO_REVIEW_USER:-situation-studio-review}"
publisher_user="${SITUATION_STUDIO_PUBLISHER_USER:-situation-studio-publisher}"
web_environment="${studio_root}/shared/web.env"
review_environment="${studio_root}/shared/review.env"
publisher_environment="${studio_root}/shared/publisher.env"

if [[ "${SITUATION_STUDIO_APPROVED_COMMIT}" != "${studio_commit}" ]]; then
  echo "Production deployment is approved only for ${SITUATION_STUDIO_APPROVED_COMMIT}." >&2
  exit 1
fi
if [[ "${SITUATION_STUDIO_PUBLIC_ORIGIN}" != https://* ]]; then
  echo "Production requires an approved HTTPS origin." >&2
  exit 1
fi
if [[ "${SITUATION_STUDIO_PUBLIC_ORIGIN}" != "https://${SITUATION_STUDIO_PUBLIC_HOST}" ]]; then
  echo "Approved origin and public host must match exactly." >&2
  exit 1
fi
if [[ "${public_gate_mode}" != "required" && "${public_gate_mode}" != "first-deploy-deferred" ]]; then
  echo "SITUATION_STUDIO_PUBLIC_GATE_MODE must be required or first-deploy-deferred." >&2
  exit 1
fi
if [[
  ! "${studio_host}" =~ ^[A-Za-z0-9._-]+$ ||
  ! "${studio_root}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${studio_root}" == "/" ||
  "${studio_root}" == *"/../"* ||
  "${studio_root}" == *"/.." ||
  "${studio_root}" == *"//"* ||
  ! "${SITUATION_STUDIO_PUBLIC_HOST}" =~ ^[A-Za-z0-9.-]+$
 ]]; then
  echo "Deployment host, root, or public host contains unsupported characters." >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Production deployment is allowed only from main." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet ||
  [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Production deployment requires a clean worktree." >&2
  exit 1
fi
studio_remote_main="$(git ls-remote origin refs/heads/main | cut -f1)"
if [[ "${studio_remote_main}" != "${studio_commit}" ]]; then
  echo "Exact commit ${studio_commit} is not the pushed origin/main." >&2
  exit 1
fi
studio_archive_bytes="$(
  git archive --format=tar "${studio_commit}" | wc -c | tr -d ' '
)"
if ((studio_archive_bytes > studio_archive_limit_bytes)); then
  echo "Committed source exceeds the 50 MiB production archive limit." >&2
  exit 1
fi
if [[ ! "${studio_release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "SITUATION_STUDIO_RELEASE_ID must use UTC YYYYMMDDTHHMMSSZ." >&2
  exit 1
fi

echo "[1/7] Preflighting the approved production host"
ssh "${studio_host}" bash -s -- \
  "${studio_root}" \
  "${web_environment}" \
  "${review_environment}" \
  "${publisher_environment}" \
  "${web_user}" \
  "${review_user}" \
  "${publisher_user}" \
  "${required_codex_cli_version}" \
  "${required_claude_cli_version}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
web_environment="${2}"
review_environment="${3}"
publisher_environment="${4}"
web_user="${5}"
review_user="${6}"
publisher_user="${7}"
required_codex_cli_version="${8}"
required_claude_cli_version="${9}"
for service_user in "${web_user}" "${review_user}" "${publisher_user}"; do
  id "${service_user}" >/dev/null
done
for environment_file in \
  "${web_environment}" \
  "${review_environment}" \
  "${publisher_environment}"; do
  test -f "${environment_file}"
  mode="$(stat -c '%a' "${environment_file}")"
  [[ "${mode}" == "400" || "${mode}" == "600" ]]
done
test "$(stat -c '%U' "${web_environment}")" = "${web_user}"
test "$(stat -c '%U' "${review_environment}")" = "${review_user}"
test "$(stat -c '%U' "${publisher_environment}")" = "${publisher_user}"
test "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)" -ge 1048576
install -d -m 0755 "${studio_root}/releases"
test "$(df --output=avail -B1 "${studio_root}" | tail -1)" -ge 5368709120
source ~/.nvm/nvm.sh
pm2_bin="$(command -v pm2)"
review_home="$(getent passwd "${review_user}" | cut -d: -f6)"
test -d "${review_home}"
codex_bin="${review_home}/.local/bin/codex"
claude_bin="${review_home}/.local/bin/claude"
test -x "${codex_bin}"
test -x "${claude_bin}"
command -v script >/dev/null
review_path="${review_home}/.local/bin:${PATH}"
test "$(
  sudo -n -u "${review_user}" env -i \
    "HOME=${review_home}" \
    "USER=${review_user}" \
    "LOGNAME=${review_user}" \
    "PATH=${review_path}" \
    "${codex_bin}" --version
)" = "codex-cli ${required_codex_cli_version}"
test "$(
  sudo -n -u "${review_user}" env -i \
    "HOME=${review_home}" \
    "USER=${review_user}" \
    "LOGNAME=${review_user}" \
    "PATH=${review_path}" \
    "${claude_bin}" --version
)" = "${required_claude_cli_version} (Claude Code)"
sudo -n -u "${review_user}" env -i \
  "HOME=${review_home}" \
  "USER=${review_user}" \
  "LOGNAME=${review_user}" \
  "PATH=${review_path}" \
  "${codex_bin}" login status >/dev/null
sudo -n -u "${review_user}" env -i \
  "HOME=${review_home}" \
  "USER=${review_user}" \
  "LOGNAME=${review_user}" \
  "PATH=${review_path}" \
  "${claude_bin}" auth status --json |
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk });
    process.stdin.on("end", () => {
      if (JSON.parse(input).loggedIn !== true) process.exit(1);
    });
  '
sudo -n env "PATH=${PATH}" "${pm2_bin}" --version >/dev/null
REMOTE

if [[ "${SITUATION_STUDIO_PREFLIGHT_ONLY:-}" == "1" ]]; then
  echo "Studio production preflight passed; no release was created."
  exit 0
fi

echo "[2/7] Verifying the complete local workspace"
pnpm verify

echo "[3/7] Creating immutable committed-source release (${studio_archive_bytes} bytes)"
ssh "${studio_host}" test ! -e "${studio_release}"
ssh "${studio_host}" mkdir -p "${studio_release}"
git archive --format=tar "${studio_commit}" |
  ssh "${studio_host}" tar -xf - -C "${studio_release}"

echo "[4/7] Installing and building the pinned release"
ssh "${studio_host}" bash -s -- "${studio_release}" <<'REMOTE'
set -euo pipefail
release="${1}"
cd "${release}"
source ~/.nvm/nvm.sh
nvm install
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter @situation-studio/web build
REMOTE

echo "[5/7] Cutting over the three isolated processes"
studio_previous="$(
  ssh "${studio_host}" \
    "if test -L '${studio_root}/current' && test -e '${studio_root}/current'; then readlink -f '${studio_root}/current'; fi"
)"
ssh "${studio_host}" bash -s -- \
  "${studio_root}" \
  "${studio_release}" \
  "${web_user}" \
  "${review_user}" \
  "${publisher_user}" \
  "${web_environment}" \
  "${review_environment}" \
  "${publisher_environment}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
studio_release="${2}"
web_user="${3}"
review_user="${4}"
publisher_user="${5}"
web_environment="${6}"
review_environment="${7}"
publisher_environment="${8}"
ln -sfn "${studio_release}" "${studio_root}/current.next"
mv -Tf "${studio_root}/current.next" "${studio_root}/current"
source ~/.nvm/nvm.sh
pm2_bin="$(command -v pm2)"
sudo -n env "PATH=${PATH}" "${pm2_bin}" startup systemd -u root --hp /root \
  >/dev/null
for process_name in \
  situation-studio-web \
  situation-studio-review-worker \
  situation-studio-publisher; do
  sudo -n env "PATH=${PATH}" "${pm2_bin}" delete "${process_name}" \
    >/dev/null 2>&1 || true
done
sudo -n env \
  "PATH=${PATH}" \
  "SITUATION_STUDIO_RELEASE=${studio_release}" \
  "SITUATION_STUDIO_WEB_USER=${web_user}" \
  "SITUATION_STUDIO_REVIEW_USER=${review_user}" \
  "SITUATION_STUDIO_PUBLISHER_USER=${publisher_user}" \
  "SITUATION_STUDIO_WEB_ENV_FILE=${web_environment}" \
  "SITUATION_STUDIO_REVIEW_ENV_FILE=${review_environment}" \
  "SITUATION_STUDIO_PUBLISHER_ENV_FILE=${publisher_environment}" \
  "${pm2_bin}" start \
  "${studio_release}/ops/situation-studio-processes.config.cjs" \
  --update-env
sudo -n env "PATH=${PATH}" "${pm2_bin}" save
REMOTE

echo "[6/7] Verifying local application health"
if ! ssh "${studio_host}" \
  "for attempt in \$(seq 1 45); do if curl -fsS http://127.0.0.1:3015/health/live >/dev/null && curl -fsS http://127.0.0.1:3015/health/ready >/dev/null; then exit 0; fi; sleep 2; done; exit 1"; then
  echo "Studio health failed; restoring the prior release." >&2
  if [[ -n "${studio_previous}" && "${studio_previous}" != "${studio_root}/current" ]]; then
    ssh "${studio_host}" bash -s -- \
      "${studio_root}" \
      "${studio_previous}" \
      "${web_user}" \
      "${review_user}" \
      "${publisher_user}" \
      "${web_environment}" \
      "${review_environment}" \
      "${publisher_environment}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
studio_previous="${2}"
web_user="${3}"
review_user="${4}"
publisher_user="${5}"
web_environment="${6}"
review_environment="${7}"
publisher_environment="${8}"
ln -sfn "${studio_previous}" "${studio_root}/current.next"
mv -Tf "${studio_root}/current.next" "${studio_root}/current"
source ~/.nvm/nvm.sh
pm2_bin="$(command -v pm2)"
for process_name in \
  situation-studio-web \
  situation-studio-review-worker \
  situation-studio-publisher; do
  sudo -n env "PATH=${PATH}" "${pm2_bin}" delete "${process_name}" \
    >/dev/null 2>&1 || true
done
sudo -n env \
  "PATH=${PATH}" \
  "SITUATION_STUDIO_RELEASE=${studio_previous}" \
  "SITUATION_STUDIO_WEB_USER=${web_user}" \
  "SITUATION_STUDIO_REVIEW_USER=${review_user}" \
  "SITUATION_STUDIO_PUBLISHER_USER=${publisher_user}" \
  "SITUATION_STUDIO_WEB_ENV_FILE=${web_environment}" \
  "SITUATION_STUDIO_REVIEW_ENV_FILE=${review_environment}" \
  "SITUATION_STUDIO_PUBLISHER_ENV_FILE=${publisher_environment}" \
  "${pm2_bin}" start \
  "${studio_previous}/ops/situation-studio-processes.config.cjs" \
  --update-env
sudo -n env "PATH=${PATH}" "${pm2_bin}" save
REMOTE
  fi
  exit 1
fi

echo "[7/7] Verifying the approved protected public origin"
if [[ "${public_gate_mode}" == "first-deploy-deferred" ]]; then
  if [[ -n "${studio_previous}" ]]; then
    echo "Public-gate verification may be deferred only for the first Studio release." >&2
    exit 1
  fi
  echo "Situation Studio ${studio_release_id} is locally healthy."
  echo "Register the approved TimsPrototypes route, then run ops/verify-public-gate.sh."
else
  SITUATION_STUDIO_PUBLIC_ORIGIN="${SITUATION_STUDIO_PUBLIC_ORIGIN}" \
    ops/verify-public-gate.sh
  echo "Situation Studio ${studio_release_id} is healthy behind the approved public access gate."
fi
