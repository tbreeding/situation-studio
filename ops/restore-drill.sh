#!/usr/bin/env bash
set -euo pipefail

: "${STUDIO_RESTORE_DRILL_DATABASE_URL:?missing restore-drill database URL}"
: "${STUDIO_RESTORE_DRILL_BACKUP:?missing encrypted backup path}"

database_url_field() {
  DATABASE_URL_TO_PARSE="${STUDIO_RESTORE_DRILL_DATABASE_URL}" node -e '
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

restore_database="$(
  psql -Atc "SELECT current_database()"
)"
if [[ "${restore_database}" != situation_studio_restore_drill_* ]]; then
  echo "Restore drill database name must start with situation_studio_restore_drill_." >&2
  exit 1
fi

restore_table_count="$(
  psql -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
)"
if [[ "${restore_table_count}" != "0" ]]; then
  echo "Restore drill target must be empty." >&2
  exit 1
fi

gpg --batch --quiet --decrypt "${STUDIO_RESTORE_DRILL_BACKUP}" |
  pg_restore \
  --file=- \
  --no-owner \
  --no-privileges |
  sed '/^SET transaction_timeout =/d' |
  psql \
    --set=ON_ERROR_STOP=1 \
    --quiet \
    >/dev/null

psql -v ON_ERROR_STOP=1 -qAt <<'SQL'
  DO $restore_dataset$
  BEGIN
    IF NOT EXISTS (
         SELECT 1 FROM _prisma_migrations WHERE finished_at IS NOT NULL
       )
       OR NOT EXISTS (SELECT 1 FROM situations)
       OR NOT EXISTS (SELECT 1 FROM production_situation_versions)
       OR NOT EXISTS (SELECT 1 FROM content_blobs) THEN
      RAISE EXCEPTION
        'Restore drill rejected an empty Studio production dataset.';
    END IF;
  END
  $restore_dataset$;

  SELECT json_build_object(
    'database', current_database(),
    'migrations', (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL),
    'situations', (SELECT count(*) FROM situations),
    'productionVersions', (SELECT count(*) FROM production_situation_versions),
    'contentBlobs', (SELECT count(*) FROM content_blobs),
    'auditEvents', (SELECT count(*) FROM audit_events)
  );
SQL
