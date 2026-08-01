#!/usr/bin/env bash
set -euo pipefail

: "${STUDIO_BACKUP_DATABASE_URL:?missing Studio backup database URL}"
: "${STUDIO_BACKUP_QUEUE_DATABASE_URL:?missing backup queue database URL}"
: "${STUDIO_BACKUP_DESTINATION:?missing Studio backup destination}"
: "${STUDIO_BACKUP_GPG_RECIPIENT:?missing Studio backup GPG recipient}"

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

pg_dump_timeout_seconds="${STUDIO_BACKUP_PG_DUMP_TIMEOUT_SECONDS:-900}"
gpg_timeout_seconds="${STUDIO_BACKUP_GPG_TIMEOUT_SECONDS:-900}"
ssh_timeout_seconds="${STUDIO_BACKUP_SSH_TIMEOUT_SECONDS:-120}"
scp_timeout_seconds="${STUDIO_BACKUP_SCP_TIMEOUT_SECONDS:-900}"
timeout_kill_after_seconds="${STUDIO_BACKUP_TIMEOUT_KILL_AFTER_SECONDS:-30}"
positive_timeout_seconds \
  STUDIO_BACKUP_PG_DUMP_TIMEOUT_SECONDS "${pg_dump_timeout_seconds}"
positive_timeout_seconds \
  STUDIO_BACKUP_GPG_TIMEOUT_SECONDS "${gpg_timeout_seconds}"
positive_timeout_seconds \
  STUDIO_BACKUP_SSH_TIMEOUT_SECONDS "${ssh_timeout_seconds}"
positive_timeout_seconds \
  STUDIO_BACKUP_SCP_TIMEOUT_SECONDS "${scp_timeout_seconds}"
positive_timeout_seconds \
  STUDIO_BACKUP_TIMEOUT_KILL_AFTER_SECONDS "${timeout_kill_after_seconds}"

database_url_field() {
  DATABASE_URL_TO_PARSE="${STUDIO_BACKUP_DATABASE_URL}" node -e '
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

offsite_location=""
if [[ "${STUDIO_BACKUP_REQUIRE_OFFSITE:-false}" == "true" ]]; then
  : "${STUDIO_BACKUP_OFFSITE_SSH_TARGET:?missing off-site SSH target}"
  : "${STUDIO_BACKUP_OFFSITE_DIRECTORY:?missing off-site backup directory}"
  offsite_target="${STUDIO_BACKUP_OFFSITE_SSH_TARGET}"
  offsite_directory="${STUDIO_BACKUP_OFFSITE_DIRECTORY}"
  if [[
    "${offsite_target}" == -* ||
    ! "${offsite_target}" =~ ^[A-Za-z0-9._@][A-Za-z0-9._@-]*$
  ]]; then
    echo "Off-site SSH target contains unsupported characters." >&2
    exit 1
  fi
  if [[
    ! "${offsite_directory}" =~ ^/[A-Za-z0-9._/-]+$ ||
    "${offsite_directory}" == "/" ||
    "${offsite_directory}" == */ ||
    "${offsite_directory}" == *"/../"* ||
    "${offsite_directory}" == *"/.." ||
    "${offsite_directory}" == *"//"*
  ]]; then
    echo "Off-site backup directory must be an explicit safe absolute path." >&2
    exit 1
  fi
elif [[ "${STUDIO_BACKUP_REQUIRE_OFFSITE:-false}" != "false" ]]; then
  echo "STUDIO_BACKUP_REQUIRE_OFFSITE must be true or false." >&2
  exit 1
fi

if ! command -v timeout >/dev/null 2>&1; then
  echo "The GNU timeout command is required for bounded backups." >&2
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

backup_work="$(mktemp -d)"
backup_final=""
backup_installed="false"
backup_completed="false"
offsite_partial=""
offsite_final=""
offsite_remote_promoted="false"

finish_backup() {
  local exit_status="${?}"
  trap - EXIT HUP INT TERM
  if [[ "${backup_completed}" != "true" ]]; then
    if [[
      "${backup_installed}" == "true" &&
      -n "${backup_final}"
    ]]; then
      rm -f -- "${backup_final}" || true
    fi
    rm -rf -- "${backup_work}" || true
    if [[ -n "${offsite_target:-}" ]]; then
      cleanup_remote_path=""
      if [[
        "${offsite_remote_promoted}" == "true" &&
        -n "${offsite_final}"
      ]]; then
        cleanup_remote_path="${offsite_final}"
      elif [[ -n "${offsite_partial}" ]]; then
        cleanup_remote_path="${offsite_partial}"
      fi
      if [[ -n "${cleanup_remote_path}" ]]; then
        timeout \
          --signal=TERM \
          --kill-after=5s \
          10s \
          ssh -o BatchMode=yes -o ConnectTimeout=15 -- \
            "${offsite_target}" rm -f -- "${cleanup_remote_path}" \
          >/dev/null 2>&1 || true
      fi
    fi
  else
    rm -rf -- "${backup_work}" || true
  fi
  exit "${exit_status}"
}

trap finish_backup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_object_suffix="${STUDIO_BACKUP_OBJECT_SUFFIX:-}"
if [[
  -n "${backup_object_suffix}" &&
  ! "${backup_object_suffix}" =~ ^-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$
]]; then
  echo "The backup object suffix is invalid." >&2
  exit 1
fi
backup_encrypted="${backup_work}/situation-studio-${backup_stamp}${backup_object_suffix}.dump.gpg"
backup_final="${backup_destination}/situation-studio-${backup_stamp}${backup_object_suffix}.dump.gpg"

timeout \
  --signal=TERM \
  --kill-after="${timeout_kill_after_seconds}s" \
  "${pg_dump_timeout_seconds}s" \
  pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges |
  timeout \
  --signal=TERM \
  --kill-after="${timeout_kill_after_seconds}s" \
  "${gpg_timeout_seconds}s" \
  gpg \
  --batch \
  --yes \
  --trust-model always \
  --recipient "${STUDIO_BACKUP_GPG_RECIPIENT}" \
  --output "${backup_encrypted}" \
  --encrypt

checksum="$(shasum -a 256 "${backup_encrypted}" | awk '{print $1}')"
byte_length="$(wc -c < "${backup_encrypted}" | tr -d '[:space:]')"
install -m 0600 "${backup_encrypted}" "${backup_final}"
backup_installed="true"
installed_checksum="$(shasum -a 256 "${backup_final}" | awk '{print $1}')"
if [[ "${installed_checksum}" != "${checksum}" ]]; then
  echo "Installed backup checksum verification failed." >&2
  exit 1
fi

if [[ "${STUDIO_BACKUP_REQUIRE_OFFSITE:-false}" == "true" ]]; then
  object_key="$(basename "${backup_final}")"
  offsite_partial="${offsite_directory}/.${object_key}.partial"
  offsite_final="${offsite_directory}/${object_key}"
  timeout \
    --signal=TERM \
    --kill-after="${timeout_kill_after_seconds}s" \
    "${ssh_timeout_seconds}s" \
    ssh -o BatchMode=yes -o ConnectTimeout=15 -- \
      "${offsite_target}" install -d -m 0700 "${offsite_directory}"
  timeout \
    --signal=TERM \
    --kill-after="${timeout_kill_after_seconds}s" \
    "${scp_timeout_seconds}s" \
    scp -q -o BatchMode=yes -o ConnectTimeout=15 -- \
      "${backup_final}" "${offsite_target}:${offsite_partial}"
  offsite_checksum="$(
    timeout \
      --signal=TERM \
      --kill-after="${timeout_kill_after_seconds}s" \
      "${ssh_timeout_seconds}s" \
      ssh -o BatchMode=yes -o ConnectTimeout=15 -- \
        "${offsite_target}" bash -s -- \
      "${offsite_partial}" "${offsite_final}" "${checksum}" <<'REMOTE'
set -euo pipefail
partial_path="${1}"
final_path="${2}"
expected_checksum="${3}"
observed_checksum="$(sha256sum "${partial_path}" | awk '{print $1}')"
if [[ "${observed_checksum}" != "${expected_checksum}" ]]; then
  echo "Off-site backup checksum verification failed." >&2
  exit 1
fi
test ! -e "${final_path}"
chmod 0600 "${partial_path}"
mv "${partial_path}" "${final_path}"
sha256sum "${final_path}" | awk '{print $1}'
REMOTE
  )"
  offsite_remote_promoted="true"
  if [[ "${offsite_checksum}" != "${checksum}" ]]; then
    echo "Final off-site backup checksum verification failed." >&2
    exit 1
  fi
  offsite_location="${offsite_target}:${offsite_final}"
fi

printf '{"objectKey":"%s","checksum":"%s","byteLength":%s,"encrypted":true,"offsite":"%s"}\n' \
  "$(basename "${backup_final}")" \
  "${checksum}" \
  "${byte_length}" \
  "${offsite_location}"
backup_completed="true"
