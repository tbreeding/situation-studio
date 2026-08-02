#!/usr/bin/env bash
set -euo pipefail

runner_mode="queue"
preclaimed_receipt_id=""
preclaimed_started_at=""
if [[ "${#}" -ne 0 ]]; then
  if [[
    "${#}" -ne 3 ||
    "${1:-}" != "--preclaimed" ||
    ! "${2:-}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ||
    ! "${3:-}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9:.+-]+$
  ]]; then
    echo "Provide either no arguments or --preclaimed with one canonical receipt ID and start-time fence." >&2
    exit 64
  fi
  runner_mode="preclaimed"
  preclaimed_receipt_id="${2}"
  preclaimed_started_at="${3}"
fi

: "${STUDIO_BACKUP_QUEUE_DATABASE_URL:?missing backup queue database URL}"
: "${STUDIO_BACKUP_DATABASE_URL:?missing Studio backup database URL}"
: "${STUDIO_BACKUP_DESTINATION:?missing Studio backup destination}"

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
database_identity_verifier="${script_directory}/verify-studio-backup-database-identity.sh"
if [[ ! -f "${database_identity_verifier}" || -L "${database_identity_verifier}" ]]; then
  echo "The committed Studio backup database identity verifier is missing." >&2
  exit 1
fi
STUDIO_BACKUP_DATABASE_URL="${STUDIO_BACKUP_DATABASE_URL}" \
STUDIO_BACKUP_QUEUE_DATABASE_URL="${STUDIO_BACKUP_QUEUE_DATABASE_URL}" \
  /bin/bash "${database_identity_verifier}"

positive_timeout_seconds() {
  local setting_name="${1}"
  local setting_value="${2}"
  if [[
    ! "${setting_value}" =~ ^[1-9][0-9]*$ ||
    "${#setting_value}" -gt 5
  ]] || ((10#${setting_value} > 86400)); then
    echo "${setting_name} must be an integer from 1 through 86400 seconds." >&2
    exit 1
  fi
}

database_timeout_seconds="${STUDIO_BACKUP_DATABASE_TIMEOUT_SECONDS:-60}"
overall_timeout_seconds="${STUDIO_BACKUP_OVERALL_TIMEOUT_SECONDS:-1800}"
timeout_kill_after_seconds="${STUDIO_BACKUP_TIMEOUT_KILL_AFTER_SECONDS:-30}"
deployment_lock_wait_seconds="${STUDIO_BACKUP_DEPLOYMENT_LOCK_WAIT_SECONDS:-300}"
deployment_restore_check_timeout_seconds="${STUDIO_BACKUP_DEPLOYMENT_RESTORE_CHECK_TIMEOUT_SECONDS:-900}"
positive_timeout_seconds \
  STUDIO_BACKUP_DATABASE_TIMEOUT_SECONDS "${database_timeout_seconds}"
positive_timeout_seconds \
  STUDIO_BACKUP_OVERALL_TIMEOUT_SECONDS "${overall_timeout_seconds}"
positive_timeout_seconds \
  STUDIO_BACKUP_TIMEOUT_KILL_AFTER_SECONDS "${timeout_kill_after_seconds}"
positive_timeout_seconds \
  STUDIO_BACKUP_DEPLOYMENT_LOCK_WAIT_SECONDS "${deployment_lock_wait_seconds}"
positive_timeout_seconds \
  STUDIO_BACKUP_DEPLOYMENT_RESTORE_CHECK_TIMEOUT_SECONDS \
  "${deployment_restore_check_timeout_seconds}"
minimum_stale_after_seconds=$((
  overall_timeout_seconds +
    deployment_restore_check_timeout_seconds +
    timeout_kill_after_seconds +
    300
))
stale_after_seconds="${STUDIO_BACKUP_STALE_AFTER_SECONDS:-${minimum_stale_after_seconds}}"
positive_timeout_seconds \
  STUDIO_BACKUP_STALE_AFTER_SECONDS "${stale_after_seconds}"
if [[ "${stale_after_seconds}" -lt "${minimum_stale_after_seconds}" ]]; then
  echo "STUDIO_BACKUP_STALE_AFTER_SECONDS must cover the overall backup and deployment restore-check timeouts plus at least 300 seconds." >&2
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

backup_destination="${STUDIO_BACKUP_DESTINATION}"
if [[
  ! "${backup_destination}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${backup_destination}" == "/" ||
  "${backup_destination}" == */ ||
  "${backup_destination}" == *"/../"* ||
  "${backup_destination}" == *"/.." ||
  "${backup_destination}" == *"//"*
]]; then
  echo "Backup destination must be an explicit safe absolute directory." >&2
  exit 1
fi
if [[ -L "${backup_destination}" ]]; then
  echo "Backup destination must not be a symbolic link." >&2
  exit 1
fi
install -d -m 0700 "${backup_destination}"
if [[ ! -d "${backup_destination}" || -L "${backup_destination}" ]]; then
  echo "Backup destination is not a protected directory." >&2
  exit 1
fi
backup_destination_owner="$(
  stat -c '%u' "${backup_destination}" 2>/dev/null ||
    stat -f '%u' "${backup_destination}"
)"
backup_destination_mode="$(
  stat -c '%a' "${backup_destination}" 2>/dev/null ||
    stat -f '%Lp' "${backup_destination}"
)"
if [[
  "${backup_destination_owner}" != "$(id -u)" ||
  "${backup_destination_mode}" != "700"
]]; then
  echo "Backup destination must be owned by the backup user with mode 0700." >&2
  exit 1
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "The flock command is required for single-flight backups." >&2
  exit 1
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "The GNU timeout command is required for bounded backups." >&2
  exit 1
fi

umask 077
backup_lock_path="${backup_destination}/.situation-studio-backup.lock"
if [[ -L "${backup_lock_path}" || ( -e "${backup_lock_path}" && ! -f "${backup_lock_path}" ) ]]; then
  echo "Backup lock must be a regular file, not a link or device." >&2
  exit 1
fi
exec 9>"${backup_lock_path}"
chmod 0600 "${backup_lock_path}"
backup_lock_owner="$(
  stat -c '%u' "${backup_lock_path}" 2>/dev/null ||
    stat -f '%u' "${backup_lock_path}"
)"
backup_lock_mode="$(
  stat -c '%a' "${backup_lock_path}" 2>/dev/null ||
    stat -f '%Lp' "${backup_lock_path}"
)"
if [[
  ! -f "${backup_lock_path}" ||
  -L "${backup_lock_path}" ||
  "${backup_lock_owner}" != "$(id -u)" ||
  "${backup_lock_mode}" != "600"
]]; then
  echo "Backup lock must be owned by the backup user with mode 0600." >&2
  exit 1
fi
if [[ "${runner_mode}" == "preclaimed" ]]; then
  lock_arguments=(-w "${deployment_lock_wait_seconds}")
else
  lock_arguments=(-n)
fi
flock "${lock_arguments[@]}" 9 || {
  lock_status="${?}"
  if [[ "${lock_status}" == "1" && "${runner_mode}" == "queue" ]]; then
    exit 0
  fi
  if [[ "${runner_mode}" == "preclaimed" ]]; then
    echo "Unable to acquire the backup single-flight lock for the deployment checkpoint." >&2
  else
    echo "Unable to acquire the backup single-flight lock." >&2
  fi
  exit "${lock_status}"
}

receipt_id=""
receipt_started_at=""
runner_succeeded="false"
receipt_file=""
active_backup_pid=""
failure_code="BACKUP_COMMAND_FAILED"
if [[ "${runner_mode}" == "preclaimed" ]]; then
  receipt_id="${preclaimed_receipt_id}"
  receipt_started_at="${preclaimed_started_at}"
  failure_code="DEPLOYMENT_BACKUP_FAILED"
fi

mark_failed() {
  timeout \
    --signal=TERM \
    --kill-after="${timeout_kill_after_seconds}s" \
    "${database_timeout_seconds}s" \
    psql \
    --set=ON_ERROR_STOP=1 \
    --set=receipt_id="${receipt_id}" \
    --set=receipt_started_at="${receipt_started_at}" \
    --set=failure_code="${failure_code}" \
    --set=runner_mode="${runner_mode}" \
    --quiet <<'SQL' >/dev/null 2>&1 || true
      UPDATE backup_receipts
         SET state = 'FAILED', failure_code = :'failure_code'
       WHERE id = :'receipt_id'::uuid
         AND state = 'RUNNING'
         AND started_at = :'receipt_started_at'::timestamptz
         AND (
           :'runner_mode' <> 'preclaimed'
           OR destination_id = 'deployment-quiesced'
         );
SQL
}

finish_runner() {
  local exit_status="${?}"
  trap - EXIT HUP INT TERM
  if [[ -n "${active_backup_pid}" ]]; then
    kill -TERM "${active_backup_pid}" >/dev/null 2>&1 || true
    wait "${active_backup_pid}" >/dev/null 2>&1 || true
    active_backup_pid=""
  fi
  if [[
    "${runner_succeeded}" != "true" &&
    -n "${receipt_id}" &&
    -n "${receipt_started_at}"
  ]]; then
    mark_failed
  fi
  if [[ -n "${receipt_file}" ]]; then
    rm -f -- "${receipt_file}"
  fi
  exit "${exit_status}"
}

handle_signal() {
  local signal_status="${1}"
  if [[ -n "${active_backup_pid}" ]]; then
    kill -TERM "${active_backup_pid}" >/dev/null 2>&1 || true
  fi
  exit "${signal_status}"
}

trap finish_runner EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

if [[ "${runner_mode}" == "preclaimed" ]]; then
  claim="$(
    timeout \
      --signal=TERM \
      --kill-after="${timeout_kill_after_seconds}s" \
      "${database_timeout_seconds}s" \
      psql \
      --set=ON_ERROR_STOP=1 \
      --set=receipt_id="${preclaimed_receipt_id}" \
      --set=receipt_started_at="${preclaimed_started_at}" \
      --quiet \
      --tuples-only \
      --no-align \
      --field-separator=$'\t' <<'SQL'
        SELECT receipt.id::text, receipt.started_at::text
          FROM backup_receipts AS receipt
         WHERE receipt.id = :'receipt_id'::uuid
           AND receipt.state = 'RUNNING'
           AND receipt.destination_id = 'deployment-quiesced'
           AND receipt.encrypted IS TRUE
           AND receipt.started_at = :'receipt_started_at'::timestamptz
           AND receipt.created_at = receipt.started_at
           AND receipt.object_key IS NULL
           AND receipt.checksum IS NULL
           AND receipt.byte_length IS NULL
           AND receipt.verified_at IS NULL
           AND receipt.failure_code IS NULL;
SQL
  )"
else
  claim="$(
  timeout \
    --signal=TERM \
    --kill-after="${timeout_kill_after_seconds}s" \
    "${database_timeout_seconds}s" \
    psql \
    --set=ON_ERROR_STOP=1 \
    --set=stale_after_seconds="${stale_after_seconds}" \
    --quiet \
    --tuples-only \
    --no-align <<'SQL'
      WITH recovered AS (
        UPDATE backup_receipts
           SET state = 'FAILED', failure_code = 'BACKUP_RUNNER_STALE'
         WHERE state = 'RUNNING'
           AND (
             started_at IS NULL OR
             started_at < now() - make_interval(
               secs => :'stale_after_seconds'::integer
             )
           )
        RETURNING id
      ), selected AS (
         SELECT id
           FROM backup_receipts
          WHERE state = 'QUEUED'
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
      ), claimed AS (
        UPDATE backup_receipts receipt
           SET state = 'RUNNING',
               started_at = clock_timestamp(),
               failure_code = NULL
          FROM selected
         WHERE receipt.id = selected.id
        RETURNING receipt.id, receipt.started_at
      ), recovery_summary AS (
        SELECT count(*) AS recovered_count FROM recovered
      )
      SELECT claimed.id::text || E'\t' || claimed.started_at::text
        FROM claimed
        CROSS JOIN recovery_summary;
SQL
  )"
fi

if [[ -z "${claim}" ]]; then
  if [[ "${runner_mode}" == "preclaimed" ]]; then
    echo "The deployment backup receipt is not the exact preclaimed RUNNING fence." >&2
    exit 1
  fi
  runner_succeeded="true"
  exit 0
fi
if [[ "${claim}" == *$'\n'* ]]; then
  echo "Backup claim returned more than one receipt." >&2
  exit 1
fi
IFS=$'\t' read -r receipt_id receipt_started_at claim_extra <<<"${claim}"
if [[
  ! "${receipt_id}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ||
  ! "${receipt_started_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9:.+-]+$ ||
  -n "${claim_extra:-}"
]]; then
  echo "Backup claim did not return one valid fenced receipt." >&2
  exit 1
fi

if [[ "${runner_mode}" == "preclaimed" ]]; then
  export STUDIO_BACKUP_OBJECT_SUFFIX="-${receipt_id}"
fi

receipt_file="$(mktemp)"
timeout \
  --signal=TERM \
  --kill-after="${timeout_kill_after_seconds}s" \
  "${overall_timeout_seconds}s" \
  ops/backup-studio.sh >"${receipt_file}" &
active_backup_pid="${!}"
set +e
wait "${active_backup_pid}"
backup_status="${?}"
set -e
active_backup_pid=""
if [[ "${backup_status}" != "0" ]]; then
  echo "Backup command failed with status ${backup_status}." >&2
  exit "${backup_status}"
fi
receipt="$(<"${receipt_file}")"
parsed="$(
  node -e '
    const { createHash } = require("node:crypto");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (!/^[a-zA-Z0-9._-]+$/.test(value.objectKey)) process.exit(2);
      if (!/^[a-f0-9]{64}$/.test(value.checksum)) process.exit(2);
      if (value.encrypted !== true) process.exit(2);
      if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 1)
        process.exit(2);
      if (typeof value.offsite !== "string") process.exit(2);
      let destinationId = "local-only";
      if (value.offsite) {
        const marker = /^([A-Za-z0-9._@][A-Za-z0-9._@-]*):(\/[A-Za-z0-9._/-]+)$/.exec(
          value.offsite,
        );
        if (!marker) process.exit(2);
        const [, target, remotePath] = marker;
        if (
          target.startsWith("-") ||
          remotePath === "/" ||
          remotePath.endsWith("/") ||
          remotePath.includes("/../") ||
          remotePath.endsWith("/..") ||
          remotePath.includes("//")
        )
          process.exit(2);
        destinationId = `offsite-verified:${createHash("sha256")
          .update(value.offsite)
          .digest("hex")}`;
      }
      process.stdout.write(
        `${value.objectKey}\t${value.checksum}\t${value.byteLength}\t${destinationId}`,
      );
    });
  ' <<<"${receipt}"
)"
IFS=$'\t' read -r object_key checksum byte_length destination_id <<<"${parsed}"

if [[ "${runner_mode}" == "preclaimed" ]]; then
  deployment_backup_local="${backup_destination}/${object_key}"
  deployment_backup_owner="$(
    stat -c '%u' "${deployment_backup_local}" 2>/dev/null ||
      stat -f '%u' "${deployment_backup_local}"
  )"
  deployment_backup_mode="$(
    stat -c '%a' "${deployment_backup_local}" 2>/dev/null ||
      stat -f '%Lp' "${deployment_backup_local}"
  )"
  if [[
    ! "${object_key}" =~ ^situation-studio-[0-9]{8}T[0-9]{6}Z-${receipt_id}\.dump\.gpg$ ||
    ! -f "${deployment_backup_local}" ||
    -L "${deployment_backup_local}" ||
    "${deployment_backup_owner}" != "$(id -u)" ||
    "${deployment_backup_mode}" != "600" ||
    "$(wc -c <"${deployment_backup_local}" | tr -d '[:space:]')" != "${byte_length}" ||
    "$(shasum -a 256 "${deployment_backup_local}" | awk '{print $1}')" != "${checksum}"
  ]]; then
    echo "The deployment backup local artifact does not match its exact receipt evidence." >&2
    exit 1
  fi
  if ! timeout \
    --signal=TERM \
    --kill-after="${timeout_kill_after_seconds}s" \
    "${deployment_restore_check_timeout_seconds}s" \
    gpg --batch --quiet --decrypt "${deployment_backup_local}" \
    >/dev/null; then
    echo "The deployment backup cannot be fully decrypted with the protected backup key." >&2
    exit 1
  fi
  set +e
  timeout \
    --signal=TERM \
    --kill-after="${timeout_kill_after_seconds}s" \
    "${deployment_restore_check_timeout_seconds}s" \
    gpg --batch --quiet --decrypt "${deployment_backup_local}" |
    timeout \
      --signal=TERM \
      --kill-after="${timeout_kill_after_seconds}s" \
      "${deployment_restore_check_timeout_seconds}s" \
      pg_restore --list >/dev/null
  deployment_catalog_statuses=("${PIPESTATUS[@]}")
  set -e
  if [[
    "${#deployment_catalog_statuses[@]}" != "2" ||
    "${deployment_catalog_statuses[1]}" != "0"
  ]]; then
    echo "The decrypted deployment backup does not expose a readable PostgreSQL custom-format catalog." >&2
    exit 1
  fi
fi

transition="$(
  timeout \
    --signal=TERM \
    --kill-after="${timeout_kill_after_seconds}s" \
    "${database_timeout_seconds}s" \
    psql \
    --set=ON_ERROR_STOP=1 \
    --set=receipt_id="${receipt_id}" \
    --set=receipt_started_at="${receipt_started_at}" \
    --set=object_key="${object_key}" \
    --set=checksum="${checksum}" \
    --set=byte_length="${byte_length}" \
    --set=destination_id="${destination_id}" \
    --set=runner_mode="${runner_mode}" \
    --quiet \
    --tuples-only \
    --no-align <<'SQL'
    WITH transitioned AS (
      UPDATE backup_receipts
         SET state = 'VERIFIED',
             object_key = :'object_key',
             checksum = :'checksum',
             destination_id = :'destination_id',
             encrypted = true,
             byte_length = :'byte_length'::bigint,
             verified_at = now(),
             failure_code = NULL
       WHERE id = :'receipt_id'::uuid
         AND state = 'RUNNING'
         AND started_at = :'receipt_started_at'::timestamptz
         AND (
           :'runner_mode' <> 'preclaimed'
           OR destination_id = 'deployment-quiesced'
         )
      RETURNING id
    )
    SELECT count(*)::text || E'\t' || coalesce(min(id::text), '')
      FROM transitioned;
SQL
)"
IFS=$'\t' read -r transition_count transitioned_receipt_id transition_extra \
  <<<"${transition}"
if [[
  "${transition_count}" != "1" ||
  "${transitioned_receipt_id}" != "${receipt_id}" ||
  -n "${transition_extra:-}"
]]; then
  echo "Backup verification did not transition exactly one fenced RUNNING receipt." >&2
  exit 1
fi
runner_succeeded="true"
