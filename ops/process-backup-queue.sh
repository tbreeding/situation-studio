#!/usr/bin/env bash
set -euo pipefail

: "${STUDIO_BACKUP_QUEUE_DATABASE_URL:?missing backup queue database URL}"

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

receipt_id="$(
  psql \
    --set=ON_ERROR_STOP=1 \
    --quiet \
    --tuples-only \
    --no-align \
    --command "
      WITH selected AS (
         SELECT id
           FROM backup_receipts
          WHERE state = 'QUEUED'
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
      ), claimed AS (
        UPDATE backup_receipts receipt
           SET state = 'RUNNING', started_at = now(), failure_code = NULL
          FROM selected
         WHERE receipt.id = selected.id
        RETURNING receipt.id
       )
      SELECT id FROM claimed;
    " | tr -d '[:space:]'
)"

if [[ -z "${receipt_id}" ]]; then
  exit 0
fi

mark_failed() {
  psql \
    --set=ON_ERROR_STOP=1 \
    --set=receipt_id="${receipt_id}" \
    --quiet <<'SQL' >/dev/null 2>&1 || true
      UPDATE backup_receipts
         SET state = 'FAILED', failure_code = 'BACKUP_COMMAND_FAILED'
       WHERE id = :'receipt_id'::uuid AND state = 'RUNNING';
SQL
}
trap mark_failed ERR

receipt="$(ops/backup-studio.sh)"
parsed="$(
  node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = JSON.parse(input);
      if (!/^[a-zA-Z0-9._-]+$/.test(value.objectKey)) process.exit(2);
      if (!/^[a-f0-9]{64}$/.test(value.checksum)) process.exit(2);
      if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 1)
        process.exit(2);
      process.stdout.write(
        `${value.objectKey}\t${value.checksum}\t${value.byteLength}`,
      );
    });
  ' <<<"${receipt}"
)"
IFS=$'\t' read -r object_key checksum byte_length <<<"${parsed}"

psql \
  --set=ON_ERROR_STOP=1 \
  --set=receipt_id="${receipt_id}" \
  --set=object_key="${object_key}" \
  --set=checksum="${checksum}" \
  --set=byte_length="${byte_length}" \
  --quiet <<'SQL' >/dev/null
    UPDATE backup_receipts
       SET state = 'VERIFIED',
           object_key = :'object_key',
           checksum = :'checksum',
           encrypted = true,
           byte_length = :'byte_length'::bigint,
           verified_at = now(),
           failure_code = NULL
     WHERE id = :'receipt_id'::uuid AND state = 'RUNNING';
SQL
trap - ERR
