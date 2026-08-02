#!/usr/bin/env bash
set -euo pipefail

: "${SITUATION_STUDIO_DEPLOY_HOST:?missing approved deployment host}"
: "${SITUATION_STUDIO_APPROVED_COMMIT:?missing approved commit}"
: "${SITUATION_STUDIO_PUBLIC_ORIGIN:?missing approved HTTPS origin}"
: "${SITUATION_STUDIO_PUBLIC_HOST:?missing approved host header}"
: "${LEADERSHIP_RUNTIME_CAPABILITIES_URL:?missing Leadership capabilities URL}"

studio_host="${SITUATION_STUDIO_DEPLOY_HOST}"
studio_ssh_user="${SITUATION_STUDIO_DEPLOY_USER:-}"
studio_ssh_target="${studio_host}"
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
backup_user="${SITUATION_STUDIO_BACKUP_USER:-situation-studio-backup}"
web_environment="${studio_root}/shared/web.env"
review_environment="${studio_root}/shared/review.env"
publisher_environment="${studio_root}/shared/publisher.env"
backup_environment="${studio_root}/shared/backup.env"
provision_environment="${studio_root}/shared/provision.env"
backup_policy_sql_path="ops/publication-backup-state.sql"
backup_mode_verifier_path="ops/verify-backup-readiness-mode.sh"
backup_database_identity_verifier_path="ops/verify-studio-backup-database-identity.sh"
backup_environment_reader_path="ops/read-studio-backup-environment.sh"
deployment_lease_helper_path="ops/manage-studio-deployment-lease.sh"
buffered_remote_runner_path="ops/run-buffered-remote-script.sh"

if [[ -n "${studio_ssh_user}" ]]; then
  studio_ssh_target="${studio_ssh_user}@${studio_host}"
fi

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
if [[
  "${LEADERSHIP_RUNTIME_CAPABILITIES_URL}" != http://* &&
  "${LEADERSHIP_RUNTIME_CAPABILITIES_URL}" != https://*
 ]]; then
  echo "Leadership capabilities must use an HTTP(S) URL." >&2
  exit 1
fi
if [[ "${public_gate_mode}" != "required" && "${public_gate_mode}" != "first-deploy-deferred" ]]; then
  echo "SITUATION_STUDIO_PUBLIC_GATE_MODE must be required or first-deploy-deferred." >&2
  exit 1
fi
if [[
  ! "${studio_host}" =~ ^[A-Za-z0-9._-]+$ ||
  "${studio_host}" == -* ||
  ( -n "${studio_ssh_user}" && ! "${studio_ssh_user}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ) ||
  ! "${web_user}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ||
  ! "${review_user}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ||
  ! "${publisher_user}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ||
  ! "${backup_user}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ||
  ! "${studio_root}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${studio_root}" == "/" ||
  "${studio_root}" == */ ||
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
if [[ ! -f "${backup_policy_sql_path}" ]]; then
  echo "The committed publication backup policy query is missing." >&2
  exit 1
fi
if [[ ! -f "${backup_mode_verifier_path}" ]]; then
  echo "The committed backup readiness mode verifier is missing." >&2
  exit 1
fi
if [[ ! -f "${backup_database_identity_verifier_path}" ]]; then
  echo "The committed Studio backup database identity verifier is missing." >&2
  exit 1
fi
if [[ ! -f "${backup_environment_reader_path}" ]]; then
  echo "The committed protected backup environment reader is missing." >&2
  exit 1
fi
if [[
  ! -f "${deployment_lease_helper_path}" ||
  -L "${deployment_lease_helper_path}"
]]; then
  echo "The committed Studio deployment lease helper is missing or unsafe." >&2
  exit 1
fi
if [[
  ! -f "${buffered_remote_runner_path}" ||
  -L "${buffered_remote_runner_path}"
]]; then
  echo "The committed buffered remote runner is missing or unsafe." >&2
  exit 1
fi
backup_policy_sql_base64="$(base64 <"${backup_policy_sql_path}" | tr -d '\n')"
backup_mode_verifier_base64="$(
  base64 <"${backup_mode_verifier_path}" | tr -d '\n'
)"
backup_database_identity_verifier_base64="$(
  base64 <"${backup_database_identity_verifier_path}" | tr -d '\n'
)"
backup_environment_reader_base64="$(
  base64 <"${backup_environment_reader_path}" | tr -d '\n'
)"
deployment_lease_helper_base64="$(
  base64 <"${deployment_lease_helper_path}" | tr -d '\n'
)"

echo "[1/8] Acquiring the deployment lease and preflighting the approved production host"
node ops/verify-leadership-runtime-capabilities.mjs
deployment_lease_token="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
if [[ ! "${deployment_lease_token}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Could not generate a valid Studio deployment lease token." >&2
  exit 1
fi
deployment_lease_active=false
deployment_lease_release_safe=true
studio_preflight_output_file=""
release_deployment_lease() {
  local exit_status="${1}"
  trap - EXIT HUP INT TERM
  if [[ -n "${studio_preflight_output_file}" ]]; then
    rm -f -- "${studio_preflight_output_file}"
    studio_preflight_output_file=""
  fi
  if [[
    "${deployment_lease_active}" == "true" &&
    "${deployment_lease_release_safe}" != "true"
  ]]; then
    echo "CRITICAL: Studio deployment state is not authoritatively resolved; the token-fenced deployment lease was deliberately retained. Follow the production recovery runbook before another deployment." >&2
    if ((exit_status == 0)); then
      exit_status=73
    fi
  elif [[ "${deployment_lease_active}" == "true" ]]; then
    if ! ssh "${studio_ssh_target}" bash -s -- \
      release "${studio_root}" "${deployment_lease_token}" \
      <"${deployment_lease_helper_path}"; then
      echo "CRITICAL: the token-fenced Studio deployment lease could not be released; follow the production recovery runbook." >&2
      if ((exit_status == 0)); then
        exit_status=72
      fi
    fi
  fi
  exit "${exit_status}"
}
trap 'release_deployment_lease "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if ! ssh "${studio_ssh_target}" bash -s -- \
  acquire \
  "${studio_root}" \
  "${deployment_lease_token}" \
  "${studio_commit}" \
  "${studio_release_id}" \
  <"${deployment_lease_helper_path}"; then
  echo "Studio deployment lease acquisition failed; no production preflight or release mutation was started." >&2
  exit 1
fi
deployment_lease_active=true
studio_preflight_output_file="$(mktemp)"
ssh "${studio_ssh_target}" bash -s -- \
  "${studio_root}" \
  "${web_environment}" \
  "${review_environment}" \
  "${publisher_environment}" \
  "${backup_environment}" \
  "${provision_environment}" \
  "${web_user}" \
  "${review_user}" \
  "${publisher_user}" \
  "${backup_user}" \
  "${required_codex_cli_version}" \
  "${required_claude_cli_version}" \
  "${public_gate_mode}" \
  "${backup_policy_sql_base64}" \
  "${backup_mode_verifier_base64}" \
  "${backup_database_identity_verifier_base64}" \
  "${backup_environment_reader_base64}" \
  "${deployment_lease_helper_base64}" \
  "${deployment_lease_token}" <<'REMOTE' >"${studio_preflight_output_file}"
set -euo pipefail
studio_root="${1}"
web_environment="${2}"
review_environment="${3}"
publisher_environment="${4}"
backup_environment="${5}"
provision_environment="${6}"
web_user="${7}"
review_user="${8}"
publisher_user="${9}"
backup_user="${10}"
required_codex_cli_version="${11}"
required_claude_cli_version="${12}"
public_gate_mode="${13}"
backup_policy_sql_base64="${14}"
backup_mode_verifier_base64="${15}"
backup_database_identity_verifier_base64="${16}"
backup_environment_reader_base64="${17}"
deployment_lease_helper_base64="${18}"
deployment_lease_token="${19}"
printf '%s' "${deployment_lease_helper_base64}" |
  base64 --decode |
  /bin/bash -s -- assert "${studio_root}" "${deployment_lease_token}"
for service_user in \
  "${web_user}" \
  "${review_user}" \
  "${publisher_user}"; do
  id "${service_user}" >/dev/null
done
for environment_file in \
  "${web_environment}" \
  "${review_environment}" \
  "${publisher_environment}" \
  "${provision_environment}"; do
  test -f "${environment_file}"
  mode="$(stat -c '%a' "${environment_file}")"
  [[ "${mode}" == "400" || "${mode}" == "600" ]]
done
test "$(stat -c '%U' "${web_environment}")" = "${web_user}"
test "$(stat -c '%U' "${review_environment}")" = "${review_user}"
test "$(stat -c '%U' "${publisher_environment}")" = "${publisher_user}"
test "$(stat -c '%U' "${provision_environment}")" = "$(id -un)"
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
    "${codex_bin}" --version </dev/null
)" = "codex-cli ${required_codex_cli_version}"
test "$(
  sudo -n -u "${review_user}" env -i \
    "HOME=${review_home}" \
    "USER=${review_user}" \
    "LOGNAME=${review_user}" \
    "PATH=${review_path}" \
    "${claude_bin}" --version </dev/null
)" = "${required_claude_cli_version} (Claude Code)"
sudo -n -u "${review_user}" env -i \
  "HOME=${review_home}" \
  "USER=${review_user}" \
  "LOGNAME=${review_user}" \
  "PATH=${review_path}" \
  "${codex_bin}" login status </dev/null >/dev/null
sudo -n -u "${review_user}" env -i \
  "HOME=${review_home}" \
  "USER=${review_user}" \
  "LOGNAME=${review_user}" \
  "PATH=${review_path}" \
  "${claude_bin}" auth status --json </dev/null |
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk });
    process.stdin.on("end", () => {
      if (JSON.parse(input).loggedIn !== true) process.exit(1);
    });
  '
sudo -n env "PATH=${PATH}" "${pm2_bin}" --version </dev/null >/dev/null

has_current_release=false
if [[ -L "${studio_root}/current" ]]; then
  if [[ ! -e "${studio_root}/current" ]]; then
    echo "The current Studio release pointer is dangling." >&2
    exit 1
  fi
  current_release="$(readlink -f "${studio_root}/current")"
  if [[
    "${current_release}" != "${studio_root}/releases/"* ||
    ! -f "${current_release}/.release-commit"
  ]]; then
    echo "The current Studio pointer does not identify an immutable recorded release." >&2
    exit 1
  fi
  has_current_release=true
elif [[ -e "${studio_root}/current" ]]; then
  echo "The current Studio release path exists but is not a symlink." >&2
  exit 1
fi
if [[ "${has_current_release}" == "false" ]]; then
  release_history_entry="$(
    find "${studio_root}/releases" -mindepth 1 -maxdepth 1 -print -quit
  )"
  if [[ -n "${release_history_entry}" ]]; then
    echo "Studio release history exists without a current pointer; recovery is required." >&2
    exit 1
  fi
fi
if [[ "${has_current_release}" == "true" && "${public_gate_mode}" == "first-deploy-deferred" ]]; then
  echo "First-deploy deferral is forbidden when a current Studio release exists." >&2
  exit 1
fi
if [[ "${has_current_release}" == "false" && "${public_gate_mode}" != "first-deploy-deferred" ]]; then
  echo "A first Studio release must use the publication-locked first-deploy-deferred mode." >&2
  exit 1
fi

web_home="$(getent passwd "${web_user}" | cut -d: -f6)"
test -d "${web_home}"
if [[ "${has_current_release}" == "true" ]]; then
  expected_backup_readiness_mode="required"
else
  expected_backup_readiness_mode="deferred"
fi
printf '%s' "${backup_mode_verifier_base64}" |
  base64 --decode |
  sudo -n -u "${web_user}" env -i \
  "HOME=${web_home}" \
  "USER=${web_user}" \
  "LOGNAME=${web_user}" \
  "PATH=${PATH}" \
  "WEB_ENVIRONMENT=${web_environment}" \
  "EXPECTED_BACKUP_READINESS_MODE=${expected_backup_readiness_mode}" \
  /bin/bash -s --

if [[ "${has_current_release}" == "true" ]]; then
id "${backup_user}" >/dev/null
test -f "${backup_environment}"
backup_environment_mode="$(stat -c '%a' "${backup_environment}")"
[[ "${backup_environment_mode}" == "400" || "${backup_environment_mode}" == "600" ]]
test "$(stat -c '%U' "${backup_environment}")" = "${backup_user}"
backup_home="$(getent passwd "${backup_user}" | cut -d: -f6)"
test -d "${backup_home}"
backup_path="${backup_home}/.local/bin:${PATH}"
sudo -n -u "${backup_user}" env -i \
  "HOME=${backup_home}" \
  "USER=${backup_user}" \
  "LOGNAME=${backup_user}" \
  "PATH=${backup_path}" \
  "BACKUP_ENVIRONMENT=${backup_environment}" \
  "BACKUP_POLICY_SQL_BASE64=${backup_policy_sql_base64}" \
  "BACKUP_DATABASE_IDENTITY_VERIFIER_BASE64=${backup_database_identity_verifier_base64}" \
  "BACKUP_ENVIRONMENT_READER_BASE64=${backup_environment_reader_base64}" \
  /bin/bash -s -- <<'BACKUP_PREFLIGHT'
set -euo pipefail
readonly candidate_database_identity_verifier_base64="${BACKUP_DATABASE_IDENTITY_VERIFIER_BASE64}"
readonly candidate_backup_environment_reader_base64="${BACKUP_ENVIRONMENT_READER_BASE64}"
backup_environment_reader_source="$(
  printf '%s' "${candidate_backup_environment_reader_base64}" | base64 --decode
)"
backup_environment_values="$(
  BACKUP_ENVIRONMENT="${BACKUP_ENVIRONMENT}" \
    /bin/bash -c "${backup_environment_reader_source}" </dev/null
)"
unset backup_environment_reader_source
imported_backup_environment_names=""
imported_backup_environment_count=0
while IFS=$'\t' read -r setting_name encoded_value extra_value; do
  case "${setting_name}" in
    STUDIO_BACKUP_DATABASE_URL | \
      STUDIO_BACKUP_QUEUE_DATABASE_URL | \
      STUDIO_BACKUP_DESTINATION | \
      STUDIO_BACKUP_GPG_RECIPIENT | \
      STUDIO_BACKUP_REQUIRE_OFFSITE | \
      STUDIO_BACKUP_OFFSITE_SSH_TARGET | \
      STUDIO_BACKUP_OFFSITE_DIRECTORY) ;;
    *)
      echo "The protected backup environment returned an unexpected setting." >&2
      exit 1
      ;;
  esac
  if [[
    -n "${extra_value:-}" ||
    -z "${encoded_value:-}" ||
    "|${imported_backup_environment_names}|" == *"|${setting_name}|"*
  ]]; then
    echo "The protected backup environment returned ambiguous settings." >&2
    exit 1
  fi
  if ! decoded_value="$(printf '%s' "${encoded_value}" | base64 --decode)"; then
    echo "The protected backup environment returned an invalid setting." >&2
    exit 1
  fi
  printf -v "${setting_name}" '%s' "${decoded_value}"
  export "${setting_name}"
  imported_backup_environment_names="${imported_backup_environment_names}|${setting_name}"
  imported_backup_environment_count=$((imported_backup_environment_count + 1))
done <<<"${backup_environment_values}"
unset backup_environment_values decoded_value encoded_value extra_value setting_name
if [[ "${imported_backup_environment_count}" != "7" ]]; then
  echo "The protected backup environment did not provide every required setting." >&2
  exit 1
fi
: "${STUDIO_BACKUP_DATABASE_URL:?missing Studio backup database URL}"
: "${STUDIO_BACKUP_QUEUE_DATABASE_URL:?missing backup queue database URL}"
: "${STUDIO_BACKUP_DESTINATION:?missing Studio backup destination}"
: "${STUDIO_BACKUP_GPG_RECIPIENT:?missing Studio backup GPG recipient}"
: "${STUDIO_BACKUP_OFFSITE_SSH_TARGET:?missing off-site SSH target}"
: "${STUDIO_BACKUP_OFFSITE_DIRECTORY:?missing off-site backup directory}"
for required_backup_command in \
  node psql pg_dump pg_restore gpg ssh scp flock timeout shasum; do
  if ! command -v "${required_backup_command}" >/dev/null 2>&1; then
    echo "Production backup tooling is missing ${required_backup_command}." >&2
    exit 1
  fi
done
printf '%s' "${candidate_database_identity_verifier_base64}" |
  base64 --decode |
  /bin/bash -s --
if [[ "${STUDIO_BACKUP_REQUIRE_OFFSITE:-}" != "true" ]]; then
  echo "Production backup replication must require the approved off-site destination." >&2
  exit 1
fi
if [[
  ! "${STUDIO_BACKUP_DESTINATION}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${STUDIO_BACKUP_DESTINATION}" == "/" ||
  "${STUDIO_BACKUP_DESTINATION}" == */ ||
  "${STUDIO_BACKUP_DESTINATION}" == *"/../"* ||
  "${STUDIO_BACKUP_DESTINATION}" == *"/.." ||
  "${STUDIO_BACKUP_DESTINATION}" == *"//"* ||
  ! "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == "/" ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == */ ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == *"/../"* ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == *"/.." ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == *"//"*
]]; then
  echo "Production backup destinations must be explicit safe absolute directories." >&2
  exit 1
fi
if [[
  ! -d "${STUDIO_BACKUP_DESTINATION}" ||
  -L "${STUDIO_BACKUP_DESTINATION}" ||
  "$(stat -c '%U' "${STUDIO_BACKUP_DESTINATION}")" != "$(id -un)" ||
  "$(stat -c '%a' "${STUDIO_BACKUP_DESTINATION}")" != "700"
]]; then
  echo "The local backup destination must be a mode-0700 directory owned by the backup operator." >&2
  exit 1
fi
if [[
  ! "${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" =~ ^[A-Za-z0-9._@-]+$ ||
  "${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" == -*
]]; then
  echo "The approved off-site backup SSH target contains unsupported characters." >&2
  exit 1
fi
primary_gpg_fingerprint() {
  local key_kind="${1}"
  local list_option
  local record_type
  case "${key_kind}" in
    public)
      list_option="--list-keys"
      record_type="pub"
      ;;
    secret)
      list_option="--list-secret-keys"
      record_type="sec"
      ;;
    *) return 2 ;;
  esac
  gpg --batch --with-colons --fingerprint \
    "${list_option}" -- "${STUDIO_BACKUP_GPG_RECIPIENT}" 2>/dev/null |
    awk -F: -v record_type="${record_type}" '
      $1 == record_type { primary_count += 1; awaiting_fingerprint = 1; next }
      awaiting_fingerprint && $1 == "fpr" {
        fingerprint_count += 1
        print tolower($10)
        awaiting_fingerprint = 0
      }
      END {
        if (primary_count != 1 || fingerprint_count != 1) exit 2
      }
    '
}
if ! backup_encryption_fingerprint="$(primary_gpg_fingerprint public)"; then
  echo "The configured backup encryption recipient is unavailable to the backup operator." >&2
  exit 1
fi
if ! backup_decryption_fingerprint="$(primary_gpg_fingerprint secret)"; then
  echo "The backup operator cannot decrypt the configured recipient for restore drills." >&2
  exit 1
fi
if [[
  ! "${backup_encryption_fingerprint}" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ||
  "${backup_decryption_fingerprint}" != "${backup_encryption_fingerprint}"
]]; then
  echo "The configured backup recipient does not resolve to one matching public and secret key fingerprint." >&2
  exit 1
fi

database_url_field() {
  DATABASE_URL_TO_PARSE="${STUDIO_BACKUP_QUEUE_DATABASE_URL}" node -e '
    const value = new URL(process.env.DATABASE_URL_TO_PARSE);
    if (!["postgres:", "postgresql:"].includes(value.protocol))
      process.exit(2);
    const field = process.argv[1];
    const selected =
      field === "database"
        ? decodeURIComponent(value.pathname.replace(/^\//u, ""))
        : field === "port"
          ? value.port || "5432"
          : decodeURIComponent(value[field]);
    if (!selected || /[\r\n\0]/u.test(selected)) process.exit(2);
    process.stdout.write(selected);
  ' "${1}"
}
export PGHOST="$(database_url_field hostname)"
export PGPORT="$(database_url_field port)"
export PGDATABASE="$(database_url_field database)"
export PGUSER="$(database_url_field username)"
export PGPASSWORD="$(database_url_field password)"
export PGCONNECT_TIMEOUT=10
backup_policy_evidence="$(
  printf '%s' "${BACKUP_POLICY_SQL_BASE64}" |
    base64 --decode |
    timeout --signal=TERM --kill-after=10s 30s psql \
      --set=ON_ERROR_STOP=1 \
      --quiet \
      --tuples-only \
      --no-align \
      --field-separator=$'\t'
)"
IFS=$'\t' read -r \
  backup_policy_state \
  backup_receipt_id \
  receipt_destination_id \
  object_key \
  checksum \
  byte_length \
  restore_drill_receipt_id \
  <<<"${backup_policy_evidence}"
if [[ "${backup_policy_state}" != "READY" ]]; then
  echo "Production backup evidence is not publication-ready (${backup_policy_state})." >&2
  exit 1
fi
if [[
  ! "${backup_receipt_id}" =~ ^[a-f0-9-]{36}$ ||
  ! "${restore_drill_receipt_id}" =~ ^[a-f0-9-]{36}$
]]; then
  echo "Production backup policy did not identify complete typed evidence." >&2
  exit 1
fi
offsite_final="${STUDIO_BACKUP_OFFSITE_DIRECTORY}/${object_key}"
offsite_location="${STUDIO_BACKUP_OFFSITE_SSH_TARGET}:${offsite_final}"
expected_destination_id="$(
  OFFSITE_LOCATION="${offsite_location}" node -e '
    const { createHash } = require("node:crypto");
    process.stdout.write(
      `offsite-verified:${createHash("sha256")
        .update(process.env.OFFSITE_LOCATION)
        .digest("hex")}`,
    );
  '
)"
if [[ "${receipt_destination_id}" != "${expected_destination_id}" ]]; then
  echo "The latest backup receipt is not bound to the configured off-site destination." >&2
  exit 1
fi
observed_offsite_evidence="$(
  timeout --signal=TERM --kill-after=10s 120s \
    ssh -o BatchMode=yes -o ConnectTimeout=15 -- \
    "${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" bash -s -- \
    "${offsite_final}" <<'OFFSITE_VERIFY'
set -euo pipefail
offsite_final="${1}"
test -f "${offsite_final}"
observed_checksum="$(sha256sum "${offsite_final}" | awk '{print $1}')"
observed_byte_length="$(wc -c <"${offsite_final}" | tr -d '[:space:]')"
printf '%s\t%s\n' "${observed_checksum}" "${observed_byte_length}"
OFFSITE_VERIFY
)"
IFS=$'\t' read -r observed_checksum observed_byte_length \
  <<<"${observed_offsite_evidence}"
if [[
  "${observed_checksum}" != "${checksum}" ||
  "${observed_byte_length}" != "${byte_length}"
]]; then
  echo "The configured off-site backup no longer matches its verified receipt." >&2
  exit 1
fi
OFFSITE_TARGET="${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" \
OFFSITE_DIRECTORY="${STUDIO_BACKUP_OFFSITE_DIRECTORY}" \
LOCAL_DESTINATION="${STUDIO_BACKUP_DESTINATION}" \
ENCRYPTION_FINGERPRINT="${backup_encryption_fingerprint}" \
  node -e '
    const { createHash } = require("node:crypto");
    const configured = JSON.stringify([
      process.env.OFFSITE_TARGET,
      process.env.OFFSITE_DIRECTORY,
      process.env.LOCAL_DESTINATION,
      process.env.ENCRYPTION_FINGERPRINT,
    ]);
    process.stdout.write(
      `STUDIO_DEPLOY_BACKUP_CONFIG\tconfigured-offsite:${createHash("sha256")
        .update(configured)
        .digest("hex")}\n`,
    );
  '
BACKUP_PREFLIGHT

command -v crontab >/dev/null
for backup_command in \
  start-isolated-process.sh \
  process-backup-queue.sh \
  enqueue-nightly-backup.sh; do
  test -x "${studio_root}/current/ops/${backup_command}"
done
if ! systemctl is-active --quiet cron &&
  ! systemctl is-active --quiet crond; then
  echo "The backup scheduler is not active." >&2
  exit 1
fi
backup_crontab="$(sudo -n crontab -u "${backup_user}" -l)"
backup_queue_schedule="* * * * * SITUATION_STUDIO_RELEASE=${studio_root}/current SITUATION_STUDIO_PROCESS_ENV_FILE=${backup_environment} ${studio_root}/current/ops/start-isolated-process.sh backup-queue"
backup_nightly_schedule="17 2 * * * SITUATION_STUDIO_RELEASE=${studio_root}/current SITUATION_STUDIO_PROCESS_ENV_FILE=${backup_environment} ${studio_root}/current/ops/start-isolated-process.sh backup-nightly"
if ! grep -Fqx -- "${backup_queue_schedule}" <<<"${backup_crontab}"; then
  echo "The per-minute backup queue schedule is missing or does not match the runbook." >&2
  exit 1
fi
if ! grep -Fqx -- "${backup_nightly_schedule}" <<<"${backup_crontab}"; then
  echo "The nightly backup schedule is missing or does not match the runbook." >&2
  exit 1
fi

readiness_response="$(
  curl --silent --show-error --max-time 10 --write-out $'\n%{http_code}' \
    http://127.0.0.1:3015/health/ready
)"
readiness_http_status="${readiness_response##*$'\n'}"
readiness_json="${readiness_response%$'\n'*}"
READINESS_HTTP_STATUS="${readiness_http_status}" \
READINESS_JSON="${readiness_json}" node -e '
  let readiness;
  try {
    readiness = JSON.parse(process.env.READINESS_JSON ?? "");
  } catch {
    console.error("Studio readiness did not return valid JSON.");
    process.exit(1);
  }
  const currentServiceReady =
    process.env.READINESS_HTTP_STATUS === "200" &&
    readiness?.status === "ready";
  if (!currentServiceReady) {
    console.error("The current Studio service is not ready for deployment.");
    process.exit(1);
  }
'
fi
REMOTE
studio_preflight_output="$(<"${studio_preflight_output_file}")"
rm -f -- "${studio_preflight_output_file}"
studio_preflight_output_file=""

backup_offsite_configuration_id=""
if [[ -n "${studio_preflight_output}" ]]; then
  if [[ "${studio_preflight_output}" == *$'\n'* ]]; then
    echo "Production preflight returned ambiguous deployment backup configuration evidence." >&2
    exit 1
  fi
  IFS=$'\t' read -r \
    studio_preflight_marker \
    backup_offsite_configuration_id \
    studio_preflight_extra \
    <<<"${studio_preflight_output}"
  if [[
    "${studio_preflight_marker}" != "STUDIO_DEPLOY_BACKUP_CONFIG" ||
    ! "${backup_offsite_configuration_id}" =~ ^configured-offsite:[a-f0-9]{64}$ ||
    -n "${studio_preflight_extra:-}"
  ]]; then
    echo "Production preflight did not return one valid deployment backup configuration fence." >&2
    exit 1
  fi
fi
if [[
  ( "${public_gate_mode}" == "required" && -z "${backup_offsite_configuration_id}" ) ||
  ( "${public_gate_mode}" == "first-deploy-deferred" && -n "${backup_offsite_configuration_id}" )
]]; then
  echo "Production preflight returned deployment backup configuration evidence for the wrong release mode." >&2
  exit 1
fi

if [[ "${SITUATION_STUDIO_PREFLIGHT_ONLY:-}" == "1" ]]; then
  echo "Studio production preflight passed; no release was created."
  exit 0
fi

echo "[2/8] Verifying the complete local workspace"
pnpm verify

echo "[3/8] Creating immutable committed-source release (${studio_archive_bytes} bytes)"
ssh "${studio_ssh_target}" bash -s -- \
  "${studio_root}" \
  "${studio_release}" \
  "${deployment_lease_token}" \
  "${deployment_lease_helper_base64}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
studio_release="${2}"
deployment_lease_token="${3}"
deployment_lease_helper_base64="${4}"
printf '%s' "${deployment_lease_helper_base64}" |
  base64 --decode |
  /bin/bash -s -- assert "${studio_root}" "${deployment_lease_token}"
test ! -e "${studio_release}"
mkdir -m 0755 -- "${studio_release}"
REMOTE
archive_extract_command="set -euo pipefail
studio_root='${studio_root}'
lease_root='${studio_root}/shared/.deployment-lease'
lease_token_path=\"\${lease_root}/token\"
for protected_parent in \"\${studio_root}\" \"\${studio_root}/shared\"; do
  test -d \"\${protected_parent}\"
  test ! -L \"\${protected_parent}\"
  test \"\$(stat -c '%u' \"\${protected_parent}\")\" = \"\$(id -u)\"
  protected_parent_mode=\"\$(stat -c '%a' \"\${protected_parent}\")\"
  test \"\${protected_parent_mode}\" = \"\${protected_parent_mode//[^0-7]/}\"
  protected_parent_permissions=\"\${protected_parent_mode: -3}\"
  (( (8#\${protected_parent_permissions} & 8#022) == 0 ))
done
test -d \"\${lease_root}\"
test ! -L \"\${lease_root}\"
test -f \"\${lease_token_path}\"
test ! -L \"\${lease_token_path}\"
test \"\$(wc -c <\"\${lease_token_path}\" | tr -d '[:space:]')\" = 65
test \"\$(cat \"\${lease_token_path}\")\" = '${deployment_lease_token}'
exec tar -xf - -C '${studio_release}'"
git archive --format=tar "${studio_commit}" |
  ssh "${studio_ssh_target}" "${archive_extract_command}"
unset archive_extract_command
ssh "${studio_ssh_target}" /bin/bash \
  "${studio_release}/${buffered_remote_runner_path}" \
  "${studio_root}" \
  "${studio_release}" \
  "${studio_commit}" \
  "${deployment_lease_token}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
release="${2}"
commit="${3}"
deployment_lease_token="${4}"
/bin/bash "${release}/ops/manage-studio-deployment-lease.sh" \
  assert "${studio_root}" "${deployment_lease_token}"
printf '%s\n' "${commit}" >"${release}/.release-commit"
REMOTE

echo "[4/8] Installing and building the pinned release"
ssh "${studio_ssh_target}" /bin/bash \
  "${studio_release}/${buffered_remote_runner_path}" \
  "${studio_root}" \
  "${studio_release}" \
  "${deployment_lease_token}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
release="${2}"
deployment_lease_token="${3}"
/bin/bash "${release}/ops/manage-studio-deployment-lease.sh" \
  assert "${studio_root}" "${deployment_lease_token}"
cd "${release}"
source ~/.nvm/nvm.sh
nvm install
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm db:generate
pnpm --filter @situation-studio/web build
REMOTE

studio_previous="$(
  ssh "${studio_ssh_target}" /bin/bash \
    "${studio_release}/${buffered_remote_runner_path}" \
    "${studio_root}" \
    "${studio_release}" \
    "${deployment_lease_token}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
studio_release="${2}"
deployment_lease_token="${3}"
/bin/bash "${studio_release}/ops/manage-studio-deployment-lease.sh" \
  assert "${studio_root}" "${deployment_lease_token}"
if test -L "${studio_root}/current" && test -e "${studio_root}/current"; then
  readlink -f "${studio_root}/current"
fi
REMOTE
)"
if [[ -n "${studio_previous}" ]]; then
  previous_release_prefix="${studio_root}/releases/"
  previous_release_id="${studio_previous#"${previous_release_prefix}"}"
  if [[
    "${studio_previous}" != "${previous_release_prefix}${previous_release_id}" ||
    ! "${previous_release_id}" =~ ^[0-9]{8}T[0-9]{6}Z$
  ]]; then
    echo "The current Studio release changed to an unsafe or unrecorded path after preflight." >&2
    exit 1
  fi
  if ! ssh "${studio_ssh_target}" /bin/bash \
    "${studio_release}/${buffered_remote_runner_path}" \
    "${studio_root}" \
    "${studio_release}" \
    "${studio_previous}" \
    "${deployment_lease_token}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
studio_release="${2}"
studio_previous="${3}"
deployment_lease_token="${4}"
/bin/bash "${studio_release}/ops/manage-studio-deployment-lease.sh" \
  assert "${studio_root}" "${deployment_lease_token}"
test -L "${studio_root}/current"
test -e "${studio_root}/current"
test "$(readlink -f "${studio_root}/current")" = "${studio_previous}"
test -f "${studio_previous}/.release-commit"
REMOTE
  then
    echo "The current Studio release changed after preflight." >&2
    exit 1
  fi
fi
if [[ "${public_gate_mode}" == "first-deploy-deferred" && -n "${studio_previous}" ]]; then
  echo "Public-gate verification may be deferred only for the first Studio release." >&2
  exit 1
fi
if [[ "${public_gate_mode}" == "required" && -z "${studio_previous}" ]]; then
  echo "The current Studio release disappeared after preflight; refusing an unprotected cutover." >&2
  exit 1
fi
studio_previous_argument="${studio_previous:-NO_PREVIOUS_STUDIO_RELEASE}"
echo "[5-6/8] Quiescing Studio, preserving review state, applying additive migrations, and cutting over"
deployment_lease_release_safe=false
set +e
ssh "${studio_ssh_target}" /bin/bash \
  "${studio_release}/${buffered_remote_runner_path}" \
  "${studio_root}" \
  "${studio_release}" \
  "${studio_previous_argument}" \
  "${web_user}" \
  "${review_user}" \
  "${publisher_user}" \
  "${web_environment}" \
  "${review_environment}" \
  "${publisher_environment}" \
  "${provision_environment}" \
  "${deployment_lease_token}" \
  "${backup_user}" \
  "${backup_environment}" \
  "${studio_commit}" \
  "${studio_release_id}" \
  "${backup_offsite_configuration_id:-NO_FOLLOWUP_BACKUP_CONFIG}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
studio_release="${2}"
studio_previous_argument="${3}"
web_user="${4}"
review_user="${5}"
publisher_user="${6}"
web_environment="${7}"
review_environment="${8}"
publisher_environment="${9}"
provision_environment="${10}"
deployment_lease_token="${11}"
backup_user="${12}"
backup_environment="${13}"
studio_commit="${14}"
studio_release_id="${15}"
backup_offsite_configuration_id="${16}"
assert_deployment_lease() {
  /bin/bash "${studio_release}/ops/manage-studio-deployment-lease.sh" \
    assert "${studio_root}" "${deployment_lease_token}"
}
assert_deployment_lease
studio_previous="$(
  "${studio_release}/ops/decode-studio-previous-release.sh" \
    "${studio_root}" "${studio_previous_argument}"
)"
if [[ -n "${studio_previous}" ]]; then
  test -L "${studio_root}/current"
  test -e "${studio_root}/current"
  test "$(readlink -f "${studio_root}/current")" = "${studio_previous}"
  test -f "${studio_previous}/.release-commit"
elif [[ -e "${studio_root}/current" || -L "${studio_root}/current" ]]; then
  echo "A Studio current pointer appeared after first-release preflight." >&2
  exit 1
fi
source ~/.nvm/nvm.sh
pm2_bin="$(command -v pm2)"
assert_deployment_lease
sudo -n env "PATH=${PATH}" "${pm2_bin}" startup systemd -u root --hp /root \
  </dev/null \
  >/dev/null

start_release() {
  local release="${1}"
  assert_deployment_lease
  ln -sfn "${release}" "${studio_root}/current.next"
  mv -Tf "${studio_root}/current.next" "${studio_root}/current"
  for process_name in \
    situation-studio-web \
    situation-studio-review-worker \
    situation-studio-publisher; do
    sudo -n env "PATH=${PATH}" "${pm2_bin}" delete "${process_name}" \
      </dev/null \
      >/dev/null 2>&1 || true
  done
  sudo -n env \
    "PATH=${PATH}" \
    "SITUATION_STUDIO_RELEASE=${release}" \
    "SITUATION_STUDIO_WEB_USER=${web_user}" \
    "SITUATION_STUDIO_REVIEW_USER=${review_user}" \
    "SITUATION_STUDIO_PUBLISHER_USER=${publisher_user}" \
    "SITUATION_STUDIO_WEB_ENV_FILE=${web_environment}" \
    "SITUATION_STUDIO_REVIEW_ENV_FILE=${review_environment}" \
    "SITUATION_STUDIO_PUBLISHER_ENV_FILE=${publisher_environment}" \
    "${pm2_bin}" start \
    "${release}/ops/situation-studio-processes.config.cjs" \
    --update-env </dev/null
  sudo -n env "PATH=${PATH}" "${pm2_bin}" save </dev/null
}

verify_local_health() {
  for attempt in $(seq 1 45); do
    if curl -fsS http://127.0.0.1:3015/health/live >/dev/null &&
      curl -fsS http://127.0.0.1:3015/health/ready >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

deployment_backup_receipt_id=""
deployment_backup_receipt_started_at=""
restore_previous_on_failure() {
  local status="${?}"
  local rollback_status=0
  trap - EXIT
  if ((status != 0)) && [[
    -n "${deployment_backup_receipt_id}" &&
    -n "${deployment_backup_receipt_started_at}"
  ]]; then
    docker exec -i postgres16 psql \
      -v ON_ERROR_STOP=1 \
      -X -q \
      -U postgres \
      -d situation_studio \
      --set=receipt_id="${deployment_backup_receipt_id}" \
      --set=receipt_started_at="${deployment_backup_receipt_started_at}" \
      <<'SQL' >/dev/null 2>&1 || true
        UPDATE backup_receipts
           SET state = 'FAILED',
               failure_code = 'DEPLOYMENT_BACKUP_FAILED'
         WHERE id = :'receipt_id'::uuid
           AND state = 'RUNNING'
           AND destination_id = 'deployment-quiesced'
           AND started_at = :'receipt_started_at'::timestamptz;
SQL
  fi
  if ((status != 0)) && [[ -n "${studio_previous}" ]]; then
    echo "Deployment cutover failed; restarting the previous Studio release." >&2
    if ! start_release "${studio_previous}"; then
      echo "CRITICAL: the previous Studio release could not be restarted." >&2
      rollback_status=70
    elif ! verify_local_health; then
      echo "CRITICAL: the previous Studio release restarted but did not become healthy." >&2
      rollback_status=71
    else
      echo "Previous Studio release restored and locally verified." >&2
    fi
  fi
  if ((rollback_status != 0)); then
    exit "${rollback_status}"
  fi
  exit "${status}"
}
trap restore_previous_on_failure EXIT

assert_deployment_lease
for process_name in situation-studio-web situation-studio-review-worker; do
  if sudo -n env "PATH=${PATH}" "${pm2_bin}" describe "${process_name}" \
    </dev/null \
    >/dev/null 2>&1; then
    sudo -n env "PATH=${PATH}" "${pm2_bin}" stop "${process_name}" \
      </dev/null \
      >/dev/null
  fi
done

publication_drain_state() {
  docker exec -i postgres16 psql \
    -v ON_ERROR_STOP=1 \
    -X -qAt \
    -U postgres \
    -d situation_studio \
    <"${studio_release}/ops/publication-drain-state.sql"
}

for attempt in $(seq 1 96); do
  IFS='|' read -r active_publications recovery_required unfinished_attempts \
    <<<"$(publication_drain_state)"
  if ((unfinished_attempts > 0)); then
    if ((attempt == 96)); then
      echo "Publication attempts did not finish before deployment cutover." >&2
      exit 1
    fi
    sleep 5
    continue
  fi
  if ((recovery_required > 0)); then
    echo "A publication requires recovery; refusing deployment cutover." >&2
    exit 1
  fi
  if ((active_publications == 0)); then
    break
  fi
  if ((attempt == 96)); then
    echo "Publications did not reach a terminal state before cutover." >&2
    exit 1
  fi
  sleep 5
done

if sudo -n env "PATH=${PATH}" "${pm2_bin}" describe \
  situation-studio-publisher </dev/null >/dev/null 2>&1; then
  assert_deployment_lease
  sudo -n env "PATH=${PATH}" "${pm2_bin}" stop \
    situation-studio-publisher </dev/null >/dev/null
fi

deployment_quiesced_at=""
if [[ -n "${studio_previous}" ]]; then
  assert_deployment_lease
  deployment_quiesced_at="$(
    docker exec postgres16 psql \
      -v ON_ERROR_STOP=1 \
      -X -qAt \
      -U postgres \
      -d situation_studio \
      --command 'SELECT clock_timestamp()::text;'
  )"
  if [[
    ! "${deployment_quiesced_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9:.+-]+$ ||
    "${deployment_quiesced_at}" == *$'\n'*
  ]]; then
    echo "Could not capture one database-clock deployment quiescence fence." >&2
    exit 1
  fi
fi

capture_active_review_state() {
  docker exec -i postgres16 psql \
    -v ON_ERROR_STOP=1 \
    -X -qAt \
    -U postgres \
    -d situation_studio \
    <"${studio_release}/ops/active-review-state.sql"
}

capture_expected_review_lane_state() {
  docker exec -i postgres16 psql \
    -v ON_ERROR_STOP=1 \
    -X -qAt \
    -U postgres \
    -d situation_studio \
    <"${studio_release}/ops/expected-review-lane-state.sql"
}

capture_review_lane_state() {
  docker exec -i postgres16 psql \
    -v ON_ERROR_STOP=1 \
    -X -qAt \
    -U postgres \
    -d situation_studio \
    <"${studio_release}/ops/review-lane-state.sql"
}

review_state_before="$(capture_active_review_state)"
review_state_before_hash="$(
  printf '%s' "${review_state_before}" | sha256sum | cut -d' ' -f1
)"
expected_review_lane_state="$(capture_expected_review_lane_state)"
expected_review_lane_state_hash="$(
  printf '%s' "${expected_review_lane_state}" | sha256sum | cut -d' ' -f1
)"

if [[ -n "${studio_previous}" ]]; then
  assert_deployment_lease
  deployment_backup_claim="$(
    docker exec -i postgres16 psql \
      -v ON_ERROR_STOP=1 \
      -X -qAt \
      -F $'\t' \
      -U postgres \
      -d situation_studio \
      --set=quiesced_at="${deployment_quiesced_at}" \
      --set=release_id="${studio_release_id}" \
      --set=commit="${studio_commit}" \
      --set=review_hash="${review_state_before_hash}" \
      --set=lane_hash="${expected_review_lane_state_hash}" \
      <"${studio_release}/ops/create-deployment-backup-anchor.sql"
  )"
  if [[ "${deployment_backup_claim}" == *$'\n'* ]]; then
    echo "The deployment backup anchor returned more than one receipt." >&2
    exit 1
  fi
  IFS=$'\t' read -r \
    deployment_backup_receipt_id \
    deployment_backup_receipt_started_at \
    deployment_backup_receipt_created_at \
    deployment_backup_claim_extra \
    <<<"${deployment_backup_claim}"
  if [[
    ! "${deployment_backup_receipt_id}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ||
    ! "${deployment_backup_receipt_started_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9:.+-]+$ ||
    ! "${deployment_backup_receipt_created_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9:.+-]+$ ||
    -n "${deployment_backup_claim_extra:-}"
  ]]; then
    echo "The deployment backup anchor did not create one valid fenced receipt." >&2
    exit 1
  fi

  backup_home="$(getent passwd "${backup_user}" | cut -d: -f6)"
  test -d "${backup_home}"
  backup_path="${backup_home}/.local/bin:${PATH}"
  if [[
    ! -f "${backup_environment}" ||
    -L "${backup_environment}" ||
    "$(stat -c '%U' "${backup_environment}")" != "${backup_user}"
  ]]; then
    echo "The protected backup environment changed owner or type before the deployment checkpoint." >&2
    exit 1
  fi
  backup_environment_mode="$(stat -c '%a' "${backup_environment}")"
  if [[
    "${backup_environment_mode}" != "400" &&
    "${backup_environment_mode}" != "600"
  ]]; then
    echo "The protected backup environment changed mode before the deployment checkpoint." >&2
    exit 1
  fi
  assert_deployment_lease
  deployment_backup_destination_evidence="$(
    sudo -n -u "${backup_user}" env -i \
      "HOME=${backup_home}" \
      "USER=${backup_user}" \
      "LOGNAME=${backup_user}" \
      "PATH=${backup_path}" \
      "SITUATION_STUDIO_RELEASE=${studio_release}" \
      "BACKUP_ENVIRONMENT=${backup_environment}" \
      /bin/bash "${studio_release}/ops/run-deployment-backup.sh" \
        "${deployment_backup_receipt_id}" \
        "${deployment_backup_receipt_started_at}" \
        "${backup_offsite_configuration_id}"
  )"
  if [[ "${deployment_backup_destination_evidence}" == *$'\n'* ]]; then
    echo "The deployment backup worker returned ambiguous destination evidence." >&2
    exit 1
  fi
  IFS=$'\t' read -r \
    observed_backup_offsite_configuration_id \
    expected_deployment_backup_destination_id \
    deployment_backup_destination_extra \
    <<<"${deployment_backup_destination_evidence}"
  if [[
    "${backup_offsite_configuration_id}" != "${observed_backup_offsite_configuration_id}" ||
    ! "${expected_deployment_backup_destination_id}" =~ ^offsite-verified:[a-f0-9]{64}$ ||
    -n "${deployment_backup_destination_extra:-}"
  ]]; then
    echo "The protected off-site backup destination changed after deployment preflight." >&2
    exit 1
  fi

  assert_deployment_lease
  deployment_backup_evidence="$(
    docker exec -i postgres16 psql \
      -v ON_ERROR_STOP=1 \
      -X -qAt \
      -F $'\t' \
      -U postgres \
      -d situation_studio \
      --set=receipt_id="${deployment_backup_receipt_id}" \
      --set=receipt_started_at="${deployment_backup_receipt_started_at}" \
      --set=receipt_created_at="${deployment_backup_receipt_created_at}" \
      --set=expected_destination_id="${expected_deployment_backup_destination_id}" \
      --set=quiesced_at="${deployment_quiesced_at}" \
      --set=release_id="${studio_release_id}" \
      --set=commit="${studio_commit}" \
      --set=review_hash="${review_state_before_hash}" \
      --set=lane_hash="${expected_review_lane_state_hash}" \
      <"${studio_release}/ops/verify-deployment-backup.sql"
  )"
  if [[ "${deployment_backup_evidence}" == *$'\n'* ]]; then
    echo "The deployment backup gate returned ambiguous evidence." >&2
    exit 1
  fi
  IFS=$'\t' read -r \
    deployment_backup_state \
    verified_deployment_backup_receipt_id \
    deployment_backup_destination_id \
    deployment_backup_object_key \
    deployment_backup_checksum \
    deployment_backup_byte_length \
    verified_deployment_backup_created_at \
    verified_deployment_backup_started_at \
    deployment_backup_verified_at \
    deployment_backup_evidence_extra \
    <<<"${deployment_backup_evidence}"
  if [[
    "${deployment_backup_state}" != "READY" ||
    "${verified_deployment_backup_receipt_id}" != "${deployment_backup_receipt_id}" ||
    "${verified_deployment_backup_created_at}" != "${deployment_backup_receipt_created_at}" ||
    "${verified_deployment_backup_started_at}" != "${deployment_backup_receipt_started_at}" ||
    "${deployment_backup_destination_id}" != "${expected_deployment_backup_destination_id}" ||
    ! "${deployment_backup_object_key}" =~ ^situation-studio-[0-9]{8}T[0-9]{6}Z-${deployment_backup_receipt_id}\.dump\.gpg$ ||
    ! "${deployment_backup_checksum}" =~ ^[a-f0-9]{64}$ ||
    ! "${deployment_backup_byte_length}" =~ ^[1-9][0-9]*$ ||
    ! "${deployment_backup_verified_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9:.+-]+$ ||
    -n "${deployment_backup_evidence_extra:-}"
  ]]; then
    echo "The post-quiescence deployment backup is not exact, complete, encrypted, and off-site verified (${deployment_backup_state:-missing})." >&2
    exit 1
  fi

  review_state_after_backup="$(capture_active_review_state)"
  review_state_after_backup_hash="$(
    printf '%s' "${review_state_after_backup}" | sha256sum | cut -d' ' -f1
  )"
  expected_review_lane_state_after_backup="$(capture_expected_review_lane_state)"
  expected_review_lane_state_after_backup_hash="$(
    printf '%s' "${expected_review_lane_state_after_backup}" |
      sha256sum |
      cut -d' ' -f1
  )"
  if [[
    "${review_state_after_backup_hash}" != "${review_state_before_hash}" ||
    "${expected_review_lane_state_after_backup_hash}" != "${expected_review_lane_state_hash}"
  ]]; then
    echo "Active review state changed while the deployment backup was being captured." >&2
    exit 1
  fi

  deployment_backup_json="$(
    RECEIPT_ID="${deployment_backup_receipt_id}" \
    DESTINATION_ID="${deployment_backup_destination_id}" \
    OBJECT_KEY="${deployment_backup_object_key}" \
    CHECKSUM="${deployment_backup_checksum}" \
    BYTE_LENGTH="${deployment_backup_byte_length}" \
    QUIESCED_AT="${deployment_quiesced_at}" \
    CREATED_AT="${deployment_backup_receipt_created_at}" \
    STARTED_AT="${deployment_backup_receipt_started_at}" \
    VERIFIED_AT="${deployment_backup_verified_at}" \
    REVIEW_HASH="${review_state_before_hash}" \
    LANE_HASH="${expected_review_lane_state_hash}" \
    node -e '
      process.stdout.write(JSON.stringify({
        schemaVersion: "deployment-backup-v1",
        receiptId: process.env.RECEIPT_ID,
        destinationId: process.env.DESTINATION_ID,
        objectKey: process.env.OBJECT_KEY,
        checksum: process.env.CHECKSUM,
        byteLength: Number(process.env.BYTE_LENGTH),
        quiescedAt: process.env.QUIESCED_AT,
        createdAt: process.env.CREATED_AT,
        startedAt: process.env.STARTED_AT,
        verifiedAt: process.env.VERIFIED_AT,
        reviewStateHash: process.env.REVIEW_HASH,
        expectedLaneHash: process.env.LANE_HASH,
      }));
    '
  )"
  assert_deployment_lease
  printf '%s\n' "${deployment_backup_json}" \
    >"${studio_release}/.pre-migration-backup.json"
fi

assert_deployment_lease
STUDIO_RELEASE="${studio_release}" \
STUDIO_PROVISION_ENV_FILE="${provision_environment}" \
  bash "${studio_release}/ops/apply-studio-release-schema.sh"

review_state_after="$(capture_active_review_state)"
review_state_after_hash="$(
  printf '%s' "${review_state_after}" | sha256sum | cut -d' ' -f1
)"
review_lane_state_after="$(capture_review_lane_state)"
review_lane_state_after_hash="$(
  printf '%s' "${review_lane_state_after}" | sha256sum | cut -d' ' -f1
)"
if [[ "${review_state_after_hash}" != "${review_state_before_hash}" ]]; then
  echo "Active checkout or review state changed during the quiesced migration." >&2
  exit 1
fi
if [[ "${review_lane_state_after_hash}" != "${expected_review_lane_state_hash}" ]]; then
  echo "Review queue order or focused lane ownership did not match the migration plan." >&2
  exit 1
fi
assert_deployment_lease
printf \
  '{"schemaVersion":"active-review-state-continuity-v2","before":"%s","after":"%s","expectedLane":"%s","actualLane":"%s","matched":true,"laneMatched":true}\n' \
  "${review_state_before_hash}" \
  "${review_state_after_hash}" \
  "${expected_review_lane_state_hash}" \
  "${review_lane_state_after_hash}" \
  >"${studio_release}/.active-review-state-continuity.json"

start_release "${studio_release}"
trap - EXIT
REMOTE
cutover_status="${?}"
set -e

rollback_to_previous_release() {
  if [[ -z "${studio_previous}" ]]; then
    echo "No previous Studio release exists; automatic rollback is unavailable." >&2
    return 2
  fi
  ssh "${studio_ssh_target}" /bin/bash \
    "${studio_release}/${buffered_remote_runner_path}" \
    "${studio_root}" \
    "${studio_release}" \
    "${studio_previous}" \
    "${web_user}" \
    "${review_user}" \
    "${publisher_user}" \
    "${web_environment}" \
    "${review_environment}" \
    "${publisher_environment}" \
    "${deployment_lease_token}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
studio_release="${2}"
studio_previous="${3}"
web_user="${4}"
review_user="${5}"
publisher_user="${6}"
web_environment="${7}"
review_environment="${8}"
publisher_environment="${9}"
deployment_lease_token="${10}"
/bin/bash "${studio_release}/ops/manage-studio-deployment-lease.sh" \
  assert "${studio_root}" "${deployment_lease_token}"
test -d "${studio_previous}"
test -f "${studio_previous}/.release-commit"
ln -sfn "${studio_previous}" "${studio_root}/current.next"
mv -Tf "${studio_root}/current.next" "${studio_root}/current"
source ~/.nvm/nvm.sh
pm2_bin="$(command -v pm2)"
for process_name in \
  situation-studio-web \
  situation-studio-review-worker \
  situation-studio-publisher; do
  sudo -n env "PATH=${PATH}" "${pm2_bin}" delete "${process_name}" \
    </dev/null \
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
  --update-env </dev/null
sudo -n env "PATH=${PATH}" "${pm2_bin}" save </dev/null
test "$(readlink -f "${studio_root}/current")" = \
  "$(readlink -f "${studio_previous}")"
for attempt in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:3015/health/live >/dev/null &&
    curl -fsS http://127.0.0.1:3015/health/ready >/dev/null; then
    exit 0
  fi
  sleep 2
done
echo "The previous Studio release did not become locally healthy." >&2
exit 1
REMOTE
}

if ((cutover_status != 0)); then
  echo "CRITICAL: the stateful Studio cutover did not return an authoritative success. No competing rollback was started because the remote command may still be running; the deployment lease remains held for the documented recovery procedure." >&2
  exit 70
fi

echo "[7/8] Verifying local application health and release identity"
if ! ssh "${studio_ssh_target}" /bin/bash \
  "${studio_release}/${buffered_remote_runner_path}" \
  "${studio_root}" \
  "${studio_release}" \
  "${studio_commit}" \
  "${deployment_lease_token}" <<'REMOTE'
set -euo pipefail
studio_root="${1}"
studio_release="${2}"
studio_commit="${3}"
deployment_lease_token="${4}"
/bin/bash "${studio_release}/ops/manage-studio-deployment-lease.sh" \
  assert "${studio_root}" "${deployment_lease_token}"
test "$(cat "${studio_root}/current/.release-commit")" = "${studio_commit}"
for attempt in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:3015/health/live >/dev/null &&
    curl -fsS http://127.0.0.1:3015/health/ready >/dev/null; then
    exit 0
  fi
  sleep 2
done
exit 1
REMOTE
then
  echo "Studio health failed; restoring the prior release." >&2
  if rollback_to_previous_release; then
    deployment_lease_release_safe=true
    echo "Previous Studio release restored and locally verified." >&2
  else
    echo "CRITICAL: Studio rollback could not be verified." >&2
    exit 70
  fi
  exit 1
fi

echo "[8/8] Verifying the approved protected public origin"
if [[ "${public_gate_mode}" == "first-deploy-deferred" ]]; then
  echo "Situation Studio ${studio_release_id} is locally healthy."
  echo "Register the approved TimsPrototypes route, then run ops/verify-public-gate.sh."
else
  if ! SITUATION_STUDIO_PUBLIC_ORIGIN="${SITUATION_STUDIO_PUBLIC_ORIGIN}" \
    ops/verify-public-gate.sh; then
    echo "Protected public-gate verification failed." >&2
    if rollback_to_previous_release; then
      deployment_lease_release_safe=true
      echo "Previous Studio release restored and locally verified after public-gate failure." >&2
    else
      echo "CRITICAL: public-gate verification failed and Studio rollback could not be verified." >&2
      exit 70
    fi
    exit 1
  fi
  echo "Situation Studio ${studio_release_id} is healthy behind the approved public access gate."
fi
deployment_lease_release_safe=true
