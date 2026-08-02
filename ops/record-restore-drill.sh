#!/usr/bin/env bash
set -euo pipefail
umask 077

receipt_id="${1:-}"
if [[
  "${#}" -ne 1 ||
  ! "${receipt_id}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$
]]; then
  echo "Provide exactly one canonical backup receipt ID." >&2
  exit 64
fi
readonly receipt_id

: "${SITUATION_STUDIO_RELEASE:?missing current release directory}"
: "${SITUATION_STUDIO_PROCESS_ENV_FILE:?missing backup environment file}"
: "${SITUATION_STUDIO_APPROVED_RESTORE_RECORDER_SHA256:?missing approved restore-recorder digest}"

release_link="${SITUATION_STUDIO_RELEASE%/}"
environment_file="${SITUATION_STUDIO_PROCESS_ENV_FILE}"
approved_recorder_sha256="${SITUATION_STUDIO_APPROVED_RESTORE_RECORDER_SHA256}"
if [[ ! "${approved_recorder_sha256}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "The approved restore-recorder digest is invalid." >&2
  exit 1
fi
readonly release_link environment_file approved_recorder_sha256
if [[
  "${release_link}" != /* ||
  "$(basename -- "${release_link}")" != "current" ||
  ! -L "${release_link}"
]]; then
  echo "Restore-drill recording must run from the current release link." >&2
  exit 1
fi
release_root="$(realpath "${release_link}")"
releases_root="$(realpath "$(dirname -- "${release_link}")/releases")"
if [[ "$(dirname -- "${release_root}")" != "${releases_root}" ]]; then
  echo "The current release does not resolve to the immutable releases directory." >&2
  exit 1
fi
release_commit_file="${release_root}/.release-commit"
current_restore_script="${release_root}/ops/restore-drill.sh"
if [[
  ! -f "${release_commit_file}" ||
  -L "${release_commit_file}" ||
  ! -f "${current_restore_script}" ||
  -L "${current_restore_script}" ||
  ! -x "${current_restore_script}"
]]; then
  echo "The current immutable release lacks restore-drill evidence tooling." >&2
  exit 1
fi
release_commit="$(tr -d '\n' <"${release_commit_file}")"
if [[ ! "${release_commit}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "The current immutable release commit marker is invalid." >&2
  exit 1
fi
readonly release_commit
recorder_source="${BASH_SOURCE[0]}"
if [[ ! -f "${recorder_source}" || -L "${recorder_source}" ]]; then
  echo "The restore-recorder must be an explicit regular candidate file." >&2
  exit 1
fi
recorder_path="$(realpath "${recorder_source}")"
shasum_path="$(type -P shasum || true)"
if [[ "${shasum_path}" != /* || ! -x "${shasum_path}" ]]; then
  echo "Restore-drill recording is missing the system checksum command." >&2
  exit 1
fi
initial_recorder_digest_line="$("${shasum_path}" -a 256 "${recorder_path}")"
initial_recorder_digest="${initial_recorder_digest_line%% *}"
if [[ "${initial_recorder_digest}" != "${approved_recorder_sha256}" ]]; then
  echo "The restore-recorder does not match the explicitly approved candidate digest." >&2
  exit 1
fi
readonly release_root current_restore_script recorder_path shasum_path

if [[
  "${environment_file}" != /* ||
  ! -f "${environment_file}" ||
  -L "${environment_file}"
]]; then
  echo "The backup environment must be an explicit regular file." >&2
  exit 1
fi
environment_mode="$(stat -c '%a' "${environment_file}" 2>/dev/null || stat -f '%Lp' "${environment_file}")"
if [[ "${environment_mode}" != "600" && "${environment_mode}" != "400" ]]; then
  echo "The backup environment must have mode 0600 or 0400." >&2
  exit 1
fi
environment_owner="$(stat -c '%u' "${environment_file}" 2>/dev/null || stat -f '%u' "${environment_file}")"
if [[ "${environment_owner}" != "$(id -u)" ]]; then
  echo "The backup environment must be owned by the current service user." >&2
  exit 1
fi

set -a
# The mode and owner checks above make this the same protected configuration
# boundary used by the isolated process launcher.
source "${environment_file}"
set +a

: "${STUDIO_BACKUP_QUEUE_DATABASE_URL:?missing backup queue database URL}"
: "${STUDIO_BACKUP_DESTINATION:?missing Studio backup destination}"
: "${STUDIO_BACKUP_OFFSITE_SSH_TARGET:?missing off-site SSH target}"
: "${STUDIO_BACKUP_OFFSITE_DIRECTORY:?missing off-site backup directory}"
: "${STUDIO_RESTORE_DRILL_DATABASE_URL:?missing restore-drill database URL}"

if [[ "${STUDIO_BACKUP_REQUIRE_OFFSITE:-}" != "true" ]]; then
  echo "Restore-drill evidence requires the approved off-site destination." >&2
  exit 1
fi
if [[
  ! "${STUDIO_BACKUP_DESTINATION}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${STUDIO_BACKUP_DESTINATION}" == "/" ||
  "${STUDIO_BACKUP_DESTINATION}" == */ ||
  "${STUDIO_BACKUP_DESTINATION}" == *"/../"* ||
  "${STUDIO_BACKUP_DESTINATION}" == *"/.." ||
  "${STUDIO_BACKUP_DESTINATION}" == *"//"* ||
  ! -d "${STUDIO_BACKUP_DESTINATION}" ||
  -L "${STUDIO_BACKUP_DESTINATION}"
]]; then
  echo "The local backup destination is not a safe existing absolute directory." >&2
  exit 1
fi
backup_destination_mode="$(stat -c '%a' "${STUDIO_BACKUP_DESTINATION}" 2>/dev/null || stat -f '%Lp' "${STUDIO_BACKUP_DESTINATION}")"
backup_destination_owner="$(stat -c '%u' "${STUDIO_BACKUP_DESTINATION}" 2>/dev/null || stat -f '%u' "${STUDIO_BACKUP_DESTINATION}")"
if [[
  "${backup_destination_mode}" != "700" ||
  "${backup_destination_owner}" != "$(id -u)"
]]; then
  echo "The local backup destination must be mode 0700 and owned by the service user." >&2
  exit 1
fi
if [[
  "${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" == -* ||
  ! "${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" =~ ^[A-Za-z0-9._@-]+$
]]; then
  echo "The approved off-site backup SSH target is unsafe." >&2
  exit 1
fi
if [[
  ! "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == "/" ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == */ ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == *"/../"* ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == *"/.." ||
  "${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == *"//"*
]]; then
  echo "The approved off-site backup directory is unsafe." >&2
  exit 1
fi
for required_command in flock node psql realpath ssh timeout wc; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "Restore-drill recording is missing a required command." >&2
    exit 1
  fi
done

assert_approved_recorder() {
  local observed_digest observed_digest_line
  observed_digest_line="$("${shasum_path}" -a 256 "${recorder_path}")"
  observed_digest="${observed_digest_line%% *}"
  if [[ "${observed_digest}" != "${approved_recorder_sha256}" ]]; then
    echo "The restore-recorder does not match the explicitly approved candidate digest." >&2
    return 1
  fi
}
assert_approved_recorder

lock_path="${STUDIO_BACKUP_DESTINATION}/.situation-studio-backup.lock"
if [[ -e "${lock_path}" && ( ! -f "${lock_path}" || -L "${lock_path}" ) ]]; then
  echo "The shared backup lock path is unsafe." >&2
  exit 1
fi
if [[ -e "${lock_path}" ]]; then
  lock_mode="$(stat -c '%a' "${lock_path}" 2>/dev/null || stat -f '%Lp' "${lock_path}")"
  lock_owner="$(stat -c '%u' "${lock_path}" 2>/dev/null || stat -f '%u' "${lock_path}")"
  if [[ "${lock_mode}" != "600" || "${lock_owner}" != "$(id -u)" ]]; then
    echo "The shared backup lock must be mode 0600 and owned by the service user." >&2
    exit 1
  fi
fi
exec 9>>"${lock_path}"
if [[ -L "${lock_path}" || ! -f "${lock_path}" ]]; then
  echo "The shared backup lock path changed while it was opened." >&2
  exit 1
fi
chmod 0600 "${lock_path}"
lock_mode="$(stat -c '%a' "${lock_path}" 2>/dev/null || stat -f '%Lp' "${lock_path}")"
lock_owner="$(stat -c '%u' "${lock_path}" 2>/dev/null || stat -f '%u' "${lock_path}")"
if [[ "${lock_mode}" != "600" || "${lock_owner}" != "$(id -u)" ]]; then
  echo "The shared backup lock is not protected." >&2
  exit 1
fi
if ! flock -n 9; then
  echo "Another backup or restore drill is already running." >&2
  exit 75
fi

database_url_field() {
  DATABASE_URL_TO_PARSE="${1}" node -e '
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
  ' "${2}"
}
export PGHOST="$(database_url_field "${STUDIO_BACKUP_QUEUE_DATABASE_URL}" hostname)"
export PGPORT="$(database_url_field "${STUDIO_BACKUP_QUEUE_DATABASE_URL}" port)"
export PGDATABASE="$(database_url_field "${STUDIO_BACKUP_QUEUE_DATABASE_URL}" database)"
export PGUSER="$(database_url_field "${STUDIO_BACKUP_QUEUE_DATABASE_URL}" username)"
export PGPASSWORD="$(database_url_field "${STUDIO_BACKUP_QUEUE_DATABASE_URL}" password)"
export PGCONNECT_TIMEOUT=10
restore_database="$(database_url_field "${STUDIO_RESTORE_DRILL_DATABASE_URL}" database)"
if [[ "${restore_database}" != situation_studio_restore_drill_* ]]; then
  echo "The restore target is not a disposable restore-drill database." >&2
  exit 1
fi

receipt_evidence="$(
  timeout --signal=TERM --kill-after=10s 30s psql \
    --set=ON_ERROR_STOP=1 \
    --set=receipt_id="${receipt_id}" \
    --quiet \
    --tuples-only \
    --no-align \
    --field-separator=$'\t' <<'SQL'
      SELECT receipt.id,
             receipt.xmin::text,
             receipt.destination_id,
             receipt.object_key,
             receipt.checksum,
             receipt.byte_length::text
        FROM backup_receipts AS receipt
       WHERE receipt.id = :'receipt_id'::uuid
         AND receipt.state = 'VERIFIED'
         AND receipt.destination_id ~ '^offsite-verified:[a-f0-9]{64}$'
         AND receipt.object_key ~ '^[A-Za-z0-9._-]+$'
         AND receipt.checksum ~ '^[a-f0-9]{64}$'
         AND receipt.encrypted IS true
         AND receipt.byte_length > 0
         AND receipt.verified_at IS NOT NULL
         AND isfinite(receipt.verified_at)
         AND receipt.verified_at >= current_timestamp - interval '26 hours'
         AND receipt.verified_at <= current_timestamp
         AND isfinite(receipt.created_at)
         AND receipt.created_at <= current_timestamp;
SQL
)"
IFS=$'\t' read -r \
  observed_receipt_id \
  receipt_version \
  destination_id \
  object_key \
  checksum \
  byte_length \
  <<<"${receipt_evidence}"
if [[
  "${observed_receipt_id:-}" != "${receipt_id}" ||
  ! "${receipt_version:-}" =~ ^[0-9]+$ ||
  ! "${destination_id:-}" =~ ^offsite-verified:[a-f0-9]{64}$ ||
  ! "${object_key:-}" =~ ^[A-Za-z0-9._-]+$ ||
  ! "${checksum:-}" =~ ^[a-f0-9]{64}$ ||
  ! "${byte_length:-}" =~ ^[1-9][0-9]*$
]]; then
  echo "The selected receipt is not a recent complete verified off-site receipt." >&2
  exit 1
fi

receipt_fence_active=true
restore_recorded=false
record_failed_drill() {
  local recorded
  recorded="$(
    timeout --signal=TERM --kill-after=10s 30s psql \
      --set=ON_ERROR_STOP=1 \
      --set=receipt_id="${receipt_id}" \
      --set=receipt_version="${receipt_version}" \
      --quiet \
      --tuples-only \
      --no-align <<'SQL' 2>/dev/null || true
        UPDATE backup_receipts
           SET restore_drill_at = current_timestamp,
               restore_drill_result = 'FAILED'
         WHERE id = :'receipt_id'::uuid
           AND xmin::text = :'receipt_version'
           AND state = 'VERIFIED'
        RETURNING id;
SQL
  )"
  if [[ "$(tr -d '[:space:]' <<<"${recorded}")" != "${receipt_id}" ]]; then
    echo "Restore drill failed after its receipt fence changed; no failure result was recorded." >&2
  fi
}
finish_restore_drill() {
  local status="${?}"
  trap - EXIT INT TERM HUP
  if [[
    "${status}" -ne 0 &&
    "${receipt_fence_active}" == "true" &&
    "${restore_recorded}" != "true"
  ]]; then
    set +e
    record_failed_drill
  fi
  exit "${status}"
}
trap finish_restore_drill EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

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
if [[ "${destination_id}" != "${expected_destination_id}" ]]; then
  echo "The receipt is not bound to the currently configured off-site target." >&2
  exit 1
fi

backup_path="${STUDIO_BACKUP_DESTINATION}/${object_key}"
observe_local_object() {
  local before_length after_length observed_checksum observed_checksum_line
  if [[ ! -f "${backup_path}" || -L "${backup_path}" ]]; then
    return 1
  fi
  before_length="$(timeout --signal=TERM --kill-after=10s 60s wc -c <"${backup_path}" | tr -d '[:space:]')"
  observed_checksum_line="$(timeout --signal=TERM --kill-after=10s 120s "${shasum_path}" -a 256 "${backup_path}")"
  observed_checksum="${observed_checksum_line%% *}"
  after_length="$(timeout --signal=TERM --kill-after=10s 60s wc -c <"${backup_path}" | tr -d '[:space:]')"
  [[
    "${before_length}" == "${byte_length}" &&
    "${after_length}" == "${byte_length}" &&
    "${observed_checksum}" == "${checksum}"
  ]]
}
observe_offsite_object() {
  local evidence observed_checksum observed_length
  evidence="$(
    timeout --signal=TERM --kill-after=10s 60s \
      ssh -o BatchMode=yes -o ConnectTimeout=15 -- \
      "${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" bash -s -- \
      "${offsite_final}" <<'REMOTE'
set -euo pipefail
object_path="${1}"
test -f "${object_path}"
test ! -L "${object_path}"
before_length="$(wc -c <"${object_path}" | tr -d '[:space:]')"
observed_checksum="$(sha256sum "${object_path}" | awk '{print $1}')"
after_length="$(wc -c <"${object_path}" | tr -d '[:space:]')"
test "${before_length}" = "${after_length}"
printf '%s\t%s\n' "${observed_checksum}" "${after_length}"
REMOTE
  )"
  IFS=$'\t' read -r observed_checksum observed_length <<<"${evidence}"
  [[
    "${observed_checksum:-}" == "${checksum}" &&
    "${observed_length:-}" == "${byte_length}"
  ]]
}

if ! observe_local_object; then
  echo "The local backup object does not match the selected receipt." >&2
  exit 1
fi
if ! observe_offsite_object; then
  echo "The off-site backup object does not match the selected receipt." >&2
  exit 1
fi

restore_output="$(
  STUDIO_RESTORE_DRILL_DATABASE_URL="${STUDIO_RESTORE_DRILL_DATABASE_URL}" \
  STUDIO_RESTORE_DRILL_BACKUP="${backup_path}" \
    timeout --signal=TERM --kill-after=30s 15m \
    "${current_restore_script}"
)"
observed_restore_database="$(
  RESTORE_DRILL_OUTPUT="${restore_output}" node -e '
    const input = process.env.RESTORE_DRILL_OUTPUT ?? "";
    if (Buffer.byteLength(input, "utf8") > 4096) process.exit(2);
    const lines = input
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const serializedResult = lines.pop();
    const legacyPsqlNoise = /^(?:set_config|-+|\(1 row\))$/u;
    if (
      !serializedResult ||
      lines.some((line) => !legacyPsqlNoise.test(line))
    )
      process.exit(2);
    const value = JSON.parse(serializedResult);
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.database !== "string" ||
      !/^situation_studio_restore_drill_[A-Za-z0-9_]+$/u.test(value.database)
    )
      process.exit(2);
    for (const field of [
      "migrations",
      "situations",
      "productionVersions",
      "contentBlobs",
      "auditEvents",
    ]) {
      if (!Number.isSafeInteger(value[field]) || value[field] < 0)
        process.exit(2);
    }
    if (
      value.migrations < 1 ||
      value.situations < 1 ||
      value.productionVersions < 1 ||
      value.contentBlobs < 1
    ) {
      console.error(
        "The restore drill did not recover a non-empty Studio production dataset.",
      );
      process.exit(2);
    }
    process.stdout.write(value.database);
  '
)"
if [[ "${observed_restore_database}" != "${restore_database}" ]]; then
  echo "The restore drill reported a different disposable database." >&2
  exit 1
fi

# Recheck both immutable copies after the drill before attaching its result to
# the exact receipt version that was selected above.
if ! observe_local_object || ! observe_offsite_object; then
  echo "A backup object changed while the restore drill was running." >&2
  exit 1
fi
assert_approved_recorder

recorded_receipt_id="$(
  timeout --signal=TERM --kill-after=10s 30s psql \
    --set=ON_ERROR_STOP=1 \
    --set=receipt_id="${receipt_id}" \
    --set=receipt_version="${receipt_version}" \
    --set=destination_id="${destination_id}" \
    --set=object_key="${object_key}" \
    --set=checksum="${checksum}" \
    --set=byte_length="${byte_length}" \
    --quiet \
    --tuples-only \
    --no-align <<'SQL'
      UPDATE backup_receipts
         SET restore_drill_at = current_timestamp,
             restore_drill_result = 'PASSED'
       WHERE id = :'receipt_id'::uuid
         AND xmin::text = :'receipt_version'
         AND state = 'VERIFIED'
         AND destination_id = :'destination_id'
         AND object_key = :'object_key'
         AND checksum = :'checksum'
         AND encrypted IS true
         AND byte_length = :'byte_length'::bigint
         AND verified_at IS NOT NULL
         AND isfinite(verified_at)
         AND verified_at <= current_timestamp
         AND isfinite(created_at)
         AND created_at <= current_timestamp
      RETURNING id;
SQL
)"
recorded_receipt_id="$(tr -d '[:space:]' <<<"${recorded_receipt_id}")"
if [[ "${recorded_receipt_id}" != "${receipt_id}" ]]; then
  echo "The selected receipt changed before the restore result could be recorded." >&2
  exit 1
fi
restore_recorded=true
receipt_fence_active=false

printf \
  '{"receiptId":"%s","restoreDrillResult":"PASSED","recorderSha256":"%s","restoreScriptReleaseCommit":"%s"}\n' \
  "${receipt_id}" \
  "${approved_recorder_sha256}" \
  "${release_commit}"
