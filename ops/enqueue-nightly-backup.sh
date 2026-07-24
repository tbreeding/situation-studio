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

psql --set=ON_ERROR_STOP=1 --quiet <<'SQL' >/dev/null
  INSERT INTO backup_receipts (
    id, state, destination_id, encrypted, created_at
  ) VALUES (
    gen_random_uuid(), 'QUEUED', 'nightly-encrypted-backup', true, now()
  );
SQL
