#!/usr/bin/env bash
set -euo pipefail

receipt_id="${1:-}"
receipt_started_at="${2:-}"
expected_backup_configuration_id="${3:-}"
if [[
  "${#}" -ne 3 ||
  ! "${receipt_id}" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ||
  ! "${receipt_started_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9:.+-]+$ ||
  ! "${expected_backup_configuration_id}" =~ ^configured-offsite:[a-f0-9]{64}$
]]; then
  echo "Provide one canonical deployment backup receipt, start-time fence, and preflight configuration fence." >&2
  exit 64
fi

: "${SITUATION_STUDIO_RELEASE:?missing immutable Studio release}"
: "${BACKUP_ENVIRONMENT:?missing protected backup environment}"
studio_release="${SITUATION_STUDIO_RELEASE}"
if [[
  ! "${studio_release}" =~ ^/[A-Za-z0-9._/-]+/releases/[0-9]{8}T[0-9]{6}Z$ ||
  ! -d "${studio_release}" ||
  -L "${studio_release}"
]]; then
  echo "The deployment backup requires one real immutable timestamp release." >&2
  exit 1
fi

environment_reader="${studio_release}/ops/read-studio-backup-environment.sh"
queue_runner="${studio_release}/ops/process-backup-queue.sh"
if [[
  ! -f "${environment_reader}" ||
  -L "${environment_reader}" ||
  ! -f "${queue_runner}" ||
  -L "${queue_runner}"
]]; then
  echo "The candidate deployment backup tools are missing or unsafe." >&2
  exit 1
fi

backup_environment_values="$(
  BACKUP_ENVIRONMENT="${BACKUP_ENVIRONMENT}" \
    /bin/bash "${environment_reader}" </dev/null
)"
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
if [[ "${STUDIO_BACKUP_REQUIRE_OFFSITE}" != "true" ]]; then
  echo "A deployment checkpoint requires encrypted off-site backup replication." >&2
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
if ! backup_encryption_fingerprint="$(primary_gpg_fingerprint public)" ||
  ! backup_decryption_fingerprint="$(primary_gpg_fingerprint secret)"; then
  echo "The deployment backup recipient must resolve to one available public and secret key." >&2
  exit 1
fi
if [[
  ! "${backup_encryption_fingerprint}" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ||
  "${backup_decryption_fingerprint}" != "${backup_encryption_fingerprint}"
]]; then
  echo "The deployment backup recipient public and secret key fingerprints do not match." >&2
  exit 1
fi

observed_backup_configuration_id="$(
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
        `configured-offsite:${createHash("sha256")
          .update(configured)
          .digest("hex")}`,
      );
    '
)"
if [[ "${observed_backup_configuration_id}" != "${expected_backup_configuration_id}" ]]; then
  echo "The protected backup configuration changed after deployment preflight." >&2
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

cd "${studio_release}"
STUDIO_BACKUP_DEPLOYMENT_LOCK_WAIT_SECONDS=300 \
  /bin/bash "${queue_runner}" \
    --preclaimed "${receipt_id}" "${receipt_started_at}"

object_key="$(
  timeout --signal=TERM --kill-after=10s 60s \
    psql \
    --set=ON_ERROR_STOP=1 \
    --set=receipt_id="${receipt_id}" \
    --set=receipt_started_at="${receipt_started_at}" \
    --quiet \
    --tuples-only \
    --no-align \
    --command "
      SELECT object_key
        FROM backup_receipts
       WHERE id = :'receipt_id'::uuid
         AND state = 'VERIFIED'
         AND started_at = :'receipt_started_at'::timestamptz;
    "
)"
if [[
  ! "${object_key}" =~ ^situation-studio-[0-9]{8}T[0-9]{6}Z-${receipt_id}\.dump\.gpg$ ||
  "${object_key}" == *$'\n'*
]]; then
  echo "The deployment backup worker did not verify its exact receipt-bound object." >&2
  exit 1
fi

OFFSITE_TARGET="${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" \
OFFSITE_DIRECTORY="${STUDIO_BACKUP_OFFSITE_DIRECTORY}" \
CONFIGURATION_ID="${observed_backup_configuration_id}" \
OBJECT_KEY="${object_key}" node -e '
  const { createHash } = require("node:crypto");
  const target = process.env.OFFSITE_TARGET;
  const directory = process.env.OFFSITE_DIRECTORY;
  const configurationId = process.env.CONFIGURATION_ID;
  const objectKey = process.env.OBJECT_KEY;
  if (!target || !directory || !configurationId || !objectKey)
    process.exit(2);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const offsiteLocation = `${target}:${directory}/${objectKey}`;
  process.stdout.write(
    `${configurationId}\toffsite-verified:${digest(offsiteLocation)}`,
  );
'
