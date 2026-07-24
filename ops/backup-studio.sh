#!/usr/bin/env bash
set -euo pipefail

: "${STUDIO_BACKUP_DATABASE_URL:?missing Studio backup database URL}"
: "${STUDIO_BACKUP_DESTINATION:?missing Studio backup destination}"
: "${STUDIO_BACKUP_GPG_RECIPIENT:?missing Studio backup GPG recipient}"

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
if [[ "${backup_destination}" != /* || "${backup_destination}" == "/" ]]; then
  echo "Backup destination must be an explicit absolute directory." >&2
  exit 1
fi
install -d -m 0700 "${backup_destination}"

backup_work="$(mktemp -d)"
trap 'rm -rf -- "${backup_work}"' EXIT
backup_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_encrypted="${backup_work}/situation-studio-${backup_stamp}.dump.gpg"
backup_final="${backup_destination}/situation-studio-${backup_stamp}.dump.gpg"

pg_dump \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges |
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
installed_checksum="$(shasum -a 256 "${backup_final}" | awk '{print $1}')"
if [[ "${installed_checksum}" != "${checksum}" ]]; then
  echo "Installed backup checksum verification failed." >&2
  exit 1
fi

offsite_location=""
if [[ "${STUDIO_BACKUP_REQUIRE_OFFSITE:-false}" == "true" ]]; then
  : "${STUDIO_BACKUP_OFFSITE_SSH_TARGET:?missing off-site SSH target}"
  : "${STUDIO_BACKUP_OFFSITE_DIRECTORY:?missing off-site backup directory}"
  offsite_target="${STUDIO_BACKUP_OFFSITE_SSH_TARGET}"
  offsite_directory="${STUDIO_BACKUP_OFFSITE_DIRECTORY}"
  if [[ ! "${offsite_target}" =~ ^[A-Za-z0-9._@-]+$ ]]; then
    echo "Off-site SSH target contains unsupported characters." >&2
    exit 1
  fi
  if [[
    ! "${offsite_directory}" =~ ^/[A-Za-z0-9._/-]+$ ||
    "${offsite_directory}" == "/" ||
    "${offsite_directory}" == *"/../"* ||
    "${offsite_directory}" == *"/.." ||
    "${offsite_directory}" == *"//"*
  ]]; then
    echo "Off-site backup directory must be an explicit safe absolute path." >&2
    exit 1
  fi
  object_key="$(basename "${backup_final}")"
  offsite_partial="${offsite_directory}/.${object_key}.partial"
  offsite_final="${offsite_directory}/${object_key}"
  ssh "${offsite_target}" install -d -m 0700 "${offsite_directory}"
  scp -q -- "${backup_final}" "${offsite_target}:${offsite_partial}"
  offsite_checksum="$(
    ssh "${offsite_target}" bash -s -- \
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
  if [[ "${offsite_checksum}" != "${checksum}" ]]; then
    echo "Final off-site backup checksum verification failed." >&2
    exit 1
  fi
  offsite_location="${offsite_target}:${offsite_final}"
elif [[ "${STUDIO_BACKUP_REQUIRE_OFFSITE:-false}" != "false" ]]; then
  echo "STUDIO_BACKUP_REQUIRE_OFFSITE must be true or false." >&2
  exit 1
fi

printf '{"objectKey":"%s","checksum":"%s","byteLength":%s,"encrypted":true,"offsite":"%s"}\n' \
  "$(basename "${backup_final}")" \
  "${checksum}" \
  "${byte_length}" \
  "${offsite_location}"
