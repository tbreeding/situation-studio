#!/usr/bin/env bash
set -euo pipefail

: "${STUDIO_RELEASE:?missing immutable Studio release}"
: "${STUDIO_PROVISION_ENV_FILE:?missing protected provisioning environment}"

if [[
  ! "${STUDIO_RELEASE}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${STUDIO_RELEASE}" == "/" ||
  "${STUDIO_RELEASE}" == *"/../"* ||
  "${STUDIO_RELEASE}" == *"/.." ||
  "${STUDIO_RELEASE}" == *"//"* ||
  ! "${STUDIO_PROVISION_ENV_FILE}" =~ ^/[A-Za-z0-9._/-]+$
 ]]; then
  echo "Studio release or provisioning path contains unsupported characters." >&2
  exit 1
fi

test -d "${STUDIO_RELEASE}"
test -f "${STUDIO_PROVISION_ENV_FILE}"
provision_mode="$(stat -c '%a' "${STUDIO_PROVISION_ENV_FILE}")"
[[ "${provision_mode}" == "400" || "${provision_mode}" == "600" ]]

# shellcheck disable=SC1090
source "${STUDIO_PROVISION_ENV_FILE}"
: "${STUDIO_OWNER_MIGRATION_PASSWORD:?missing Studio owner migration password}"
if ((${#STUDIO_OWNER_MIGRATION_PASSWORD} < 32)); then
  echo "Studio owner migration password must be at least 32 characters." >&2
  exit 1
fi

disable_owner_login() {
  docker exec postgres16 psql \
    -v ON_ERROR_STOP=1 \
    -U postgres \
    -d postgres \
    -c "ALTER ROLE situation_studio_owner NOLOGIN" >/dev/null
}
trap disable_owner_login EXIT

docker exec -i \
  -e "STUDIO_OWNER_MIGRATION_PASSWORD=${STUDIO_OWNER_MIGRATION_PASSWORD}" \
  postgres16 \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
\getenv owner_password STUDIO_OWNER_MIGRATION_PASSWORD
SELECT 1 / (length(:'owner_password') >= 32)::integer
  AS owner_password_length_guard;
SELECT format(
  'ALTER ROLE situation_studio_owner LOGIN PASSWORD %L',
  :'owner_password'
)\gexec
SQL

source ~/.nvm/nvm.sh
owner_database_url="$(
  DATABASE_PASSWORD="${STUDIO_OWNER_MIGRATION_PASSWORD}" node -e '
    const url = new URL("postgresql://127.0.0.1:5432/situation_studio");
    url.username = "situation_studio_owner";
    url.password = process.env.DATABASE_PASSWORD;
    process.stdout.write(url.toString());
  '
)"
(
  cd "${STUDIO_RELEASE}"
  nvm use --silent
  STUDIO_DATABASE_URL="${owner_database_url}" pnpm db:migrate:deploy
)
disable_owner_login
trap - EXIT

docker exec -i postgres16 \
  psql -v ON_ERROR_STOP=1 -U postgres -d situation_studio \
  <"${STUDIO_RELEASE}/ops/grant-runtime-roles.sql"

docker exec postgres16 psql \
  -v ON_ERROR_STOP=1 \
  -U postgres \
  -d situation_studio \
  -Atqc "
    SELECT 1 / (
      NOT (SELECT rolcanlogin
           FROM pg_roles
           WHERE rolname = 'situation_studio_owner')
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'review_jobs'
          AND column_name = 'retry_not_before'
      )
      AND NOT EXISTS (
        SELECT required.column_name
        FROM (VALUES
          ('lane_owner'),
          ('failure_reason_code'),
          ('failure_phase'),
          ('failure_stage_ordinal'),
          ('failure_stage_role')
        ) AS required(column_name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM information_schema.columns actual
          WHERE actual.table_schema = 'public'
            AND actual.table_name = 'review_jobs'
            AND actual.column_name = required.column_name
        )
      )
      AND EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'review_jobs'
          AND indexname = 'review_jobs_one_lane_owner'
          AND indexdef ILIKE '%WHERE (lane_owner = true)%'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'agent_runs'
          AND column_name = 'provider_attempts'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'agent_candidate_revisions'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'proposal_changes'
          AND column_name = 'application_mode'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'verification_receipts'
          AND column_name = 'capability_digest'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'verification_receipts'
          AND column_name = 'route_probe_code'
      )
      AND NOT EXISTS (
        SELECT required.column_name
        FROM (VALUES
          ('input_bundle_hash')
        ) AS required(column_name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM information_schema.columns actual
          WHERE actual.table_schema = 'public'
            AND actual.table_name = 'review_jobs'
            AND actual.column_name = required.column_name
          )
      )
      AND NOT EXISTS (
        SELECT required.column_name
        FROM (VALUES
          ('input_bundle_hash'),
          ('current_revision_id'),
          ('current_bundle_hash'),
          ('superseded_at'),
          ('superseded_by_revision_id')
        ) AS required(column_name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM information_schema.columns actual
          WHERE actual.table_schema = 'public'
            AND actual.table_name = 'review_proposals'
            AND actual.column_name = required.column_name
        )
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'publication_preflight_receipts'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'publication_preflight_receipts'
          AND column_name = 'sealed_at'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'publication_candidate_artifacts'
      )
      AND NOT EXISTS (
        SELECT required.column_name
        FROM (VALUES
          ('preflight_receipt_id'),
          ('candidate_hash'),
          ('legacy_preflight_exempt')
        ) AS required(column_name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM information_schema.columns actual
          WHERE actual.table_schema = 'public'
            AND actual.table_name = 'publication_jobs'
            AND actual.column_name = required.column_name
        )
      )
      AND has_table_privilege(
        'situation_studio_review_worker',
        'public.audit_events',
        'INSERT'
      )
      AND has_table_privilege(
        'situation_studio_review_worker',
        'public.agent_candidate_revisions',
        'INSERT'
      )
      AND has_table_privilege(
        'situation_studio_review_worker',
        'public.situation_checkouts',
        'SELECT'
      )
      AND has_table_privilege(
        'situation_studio_web',
        'public.publication_events',
        'INSERT'
      )
      AND has_table_privilege(
        'situation_studio_web',
        'public.publication_preflight_receipts',
        'INSERT'
      )
      AND has_table_privilege(
        'situation_studio_web',
        'public.publication_preflight_receipts',
        'UPDATE'
      )
      AND has_table_privilege(
        'situation_studio_web',
        'public.publication_candidate_artifacts',
        'SELECT'
      )
      AND has_table_privilege(
        'situation_studio_web',
        'public.publication_candidate_artifacts',
        'INSERT'
      )
      AND has_table_privilege(
        'situation_studio_publisher',
        'public.publication_preflight_receipts',
        'SELECT'
      )
      AND has_table_privilege(
        'situation_studio_publisher',
        'public.publication_candidate_artifacts',
        'SELECT'
      )
    )::integer AS release_schema_guard;
  " >/dev/null

echo "Studio release migrations and runtime grants applied."
