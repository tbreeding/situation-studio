#!/usr/bin/env bash
set -euo pipefail

: "${STUDIO_BACKUP_QUEUE_DATABASE_URL:?missing backup queue database URL}"
: "${STUDIO_BACKUP_OFFSITE_SSH_TARGET:?missing off-site SSH target}"
: "${STUDIO_BACKUP_OFFSITE_DIRECTORY:?missing off-site backup directory}"

if [[ "${STUDIO_BACKUP_REQUIRE_OFFSITE:-}" != "true" ]]; then
  echo "Legacy attestation requires the approved off-site destination." >&2
  exit 1
fi
if [[
  ! "${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" =~ ^[A-Za-z0-9._@-]+$ ||
  "${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" == -*
]]; then
  echo "The approved off-site backup SSH target contains unsupported characters." >&2
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
  echo "The approved off-site backup directory is not a safe absolute path." >&2
  exit 1
fi
if ! command -v timeout >/dev/null 2>&1; then
  echo "Legacy attestation requires GNU timeout." >&2
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

legacy_evidence="$(
  timeout --signal=TERM --kill-after=10s 30s psql \
    --set=ON_ERROR_STOP=1 \
    --quiet \
    --tuples-only \
    --no-align \
    --field-separator=$'\t' \
    --command "
      WITH latest AS (
        SELECT id,
               destination_id,
               object_key,
               checksum,
               encrypted,
               byte_length,
               verified_at
          FROM backup_receipts
         WHERE state = 'VERIFIED'
           AND verified_at IS NOT NULL
         ORDER BY verified_at DESC, created_at DESC
         LIMIT 1
      )
      SELECT id,
             destination_id,
             object_key,
             checksum,
             byte_length::text
        FROM latest
       WHERE object_key ~ '^[A-Za-z0-9._-]+$'
         AND checksum ~ '^[a-f0-9]{64}$'
         AND encrypted IS true
         AND byte_length > 0
         AND verified_at >= current_timestamp - interval '26 hours'
         AND verified_at <= current_timestamp + interval '5 minutes';
    "
)"
IFS=$'\t' read -r \
  source_receipt_id \
  source_destination_id \
  object_key \
  checksum \
  byte_length \
  <<<"${legacy_evidence}"
if [[ -z "${source_receipt_id}" ]]; then
  echo "The latest verified receipt is not eligible for legacy off-site attestation." >&2
  exit 1
fi

offsite_final="${STUDIO_BACKUP_OFFSITE_DIRECTORY}/${object_key}"
offsite_location="${STUDIO_BACKUP_OFFSITE_SSH_TARGET}:${offsite_final}"
destination_id="$(
  OFFSITE_LOCATION="${offsite_location}" node -e '
    const { createHash } = require("node:crypto");
    process.stdout.write(
      `offsite-verified:${createHash("sha256")
        .update(process.env.OFFSITE_LOCATION)
        .digest("hex")}`,
    );
  '
)"
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
  echo "The approved off-site object does not match the legacy receipt." >&2
  exit 1
fi

if [[ "${source_destination_id}" == "${destination_id}" ]]; then
  printf \
    '{"sourceReceiptId":"%s","attestedReceiptId":"%s","destinationId":"%s"}\n' \
    "${source_receipt_id}" \
    "${source_receipt_id}" \
    "${destination_id}"
  exit 0
fi
if [[
  "${source_destination_id}" != "configured-encrypted-backup" &&
  "${source_destination_id}" != "nightly-encrypted-backup"
]]; then
  echo "The latest verified receipt does not use a supported legacy destination label." >&2
  exit 1
fi

attested_receipt_id="$(
  timeout --signal=TERM --kill-after=10s 30s psql \
    --set=ON_ERROR_STOP=1 \
    --set=source_receipt_id="${source_receipt_id}" \
    --set=destination_id="${destination_id}" \
    --quiet \
    --tuples-only \
    --no-align <<'SQL'
      BEGIN;
      SELECT pg_advisory_xact_lock(hashtext('legacy-offsite-backup-attestation'));
      WITH source AS (
        SELECT receipt.*
          FROM backup_receipts AS receipt
         WHERE receipt.id = :'source_receipt_id'::uuid
           AND receipt.state = 'VERIFIED'
           AND receipt.destination_id IN (
                 'configured-encrypted-backup',
                 'nightly-encrypted-backup'
               )
           AND receipt.object_key ~ '^[A-Za-z0-9._-]+$'
           AND receipt.checksum ~ '^[a-f0-9]{64}$'
           AND receipt.encrypted IS true
           AND receipt.byte_length > 0
           AND receipt.verified_at >=
             current_timestamp - interval '26 hours'
           AND receipt.verified_at <=
             current_timestamp + interval '5 minutes'
         FOR SHARE
      ), existing AS (
        SELECT receipt.id
          FROM backup_receipts AS receipt
          JOIN source
            ON receipt.object_key = source.object_key
           AND receipt.checksum = source.checksum
           AND receipt.byte_length = source.byte_length
           AND receipt.verified_at = source.verified_at
         WHERE receipt.state = 'VERIFIED'
           AND receipt.destination_id = :'destination_id'
         ORDER BY receipt.created_at DESC
         LIMIT 1
      ), inserted AS (
        INSERT INTO backup_receipts (
          id,
          publication_job_id,
          state,
          destination_id,
          object_key,
          checksum,
          encrypted,
          byte_length,
          started_at,
          verified_at,
          failure_code,
          restore_drill_at,
          restore_drill_result,
          created_at
        )
        SELECT gen_random_uuid(),
               source.publication_job_id,
               'VERIFIED',
               :'destination_id',
               source.object_key,
               source.checksum,
               source.encrypted,
               source.byte_length,
               source.started_at,
               source.verified_at,
               NULL,
               NULL,
               NULL,
               current_timestamp
          FROM source
         WHERE NOT EXISTS (SELECT 1 FROM existing)
        RETURNING id
      )
      SELECT id FROM inserted
      UNION ALL
      SELECT id FROM existing
      LIMIT 1;
      COMMIT;
SQL
)"
attested_receipt_id="$(tr -d '[:space:]' <<<"${attested_receipt_id}")"
if [[ ! "${attested_receipt_id}" =~ ^[a-f0-9-]{36}$ ]]; then
  echo "The legacy attestation receipt was not persisted." >&2
  exit 1
fi

printf \
  '{"sourceReceiptId":"%s","attestedReceiptId":"%s","destinationId":"%s"}\n' \
  "${source_receipt_id}" \
  "${attested_receipt_id}" \
  "${destination_id}"
