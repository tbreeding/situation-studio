#!/usr/bin/env bash
set -euo pipefail

: "${STUDIO_TRANSITION_RELEASE:?missing current release}"
: "${STUDIO_TRANSITION_WEB_ENVIRONMENT:?missing web environment}"
: "${STUDIO_TRANSITION_EXPECTED_COMMIT:?missing expected current commit}"
: "${STUDIO_TRANSITION_READINESS_URL:?missing current readiness URL}"

readonly transition_release="${STUDIO_TRANSITION_RELEASE}"
readonly web_environment="${STUDIO_TRANSITION_WEB_ENVIRONMENT}"
readonly expected_commit="${STUDIO_TRANSITION_EXPECTED_COMMIT}"
readonly readiness_url="${STUDIO_TRANSITION_READINESS_URL}"
readonly trusted_path="${PATH}"

if [[
  ! "${transition_release}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${transition_release}" == "/" ||
  "${transition_release}" == */ ||
  ! "${expected_commit}" =~ ^[a-f0-9]{40}$ ||
  "${readiness_url}" != "http://127.0.0.1:3015/health/ready"
]]; then
  echo "The capability-readiness transition inputs are invalid." >&2
  exit 1
fi
if [[
  ! -d "${transition_release}" ||
  -L "${transition_release}" ||
  ! -f "${transition_release}/.release-commit" ||
  -L "${transition_release}/.release-commit" ||
  "$(cat "${transition_release}/.release-commit")" != "${expected_commit}"
]]; then
  echo "The capability-readiness transition release identity does not match." >&2
  exit 1
fi
if [[
  ! -f "${web_environment}" ||
  -L "${web_environment}" ||
  "$(stat -c '%u' "${web_environment}")" != "$(id -u)"
]]; then
  echo "The protected web environment changed owner or type." >&2
  exit 1
fi
web_environment_mode="$(stat -c '%a' "${web_environment}")"
if [[ "${web_environment_mode}" != "400" && "${web_environment_mode}" != "600" ]]; then
  echo "The protected web environment changed mode." >&2
  exit 1
fi

set -a
source "${web_environment}"
set +a
export PATH="${trusted_path}"
: "${STUDIO_DATABASE_URL:?missing Studio web database URL}"
for required_command in node psql timeout curl sha256sum; do
  command -v "${required_command}" >/dev/null
done

database_fields="$(
  DATABASE_URL_TO_PARSE="${STUDIO_DATABASE_URL}" node -e '
    const value = new URL(process.env.DATABASE_URL_TO_PARSE);
    if (!["postgres:", "postgresql:"].includes(value.protocol)) process.exit(2);
    const fields = [
      value.hostname,
      value.port || "5432",
      decodeURIComponent(value.pathname.replace(/^\//u, "")),
      decodeURIComponent(value.username),
      decodeURIComponent(value.password),
    ];
    if (fields.some((field) => !field || /[\r\n\0]/u.test(field))) process.exit(2);
    process.stdout.write(fields.map((field) => Buffer.from(field).toString("base64")).join("\t"));
  '
)"
IFS=$'\t' read -r \
  encoded_host \
  encoded_port \
  encoded_database \
  encoded_user \
  encoded_password \
  database_extra \
  <<<"${database_fields}"
if [[ -n "${database_extra:-}" ]]; then
  echo "The Studio web database identity is ambiguous." >&2
  exit 1
fi
export PGHOST="$(printf '%s' "${encoded_host}" | base64 --decode)"
export PGPORT="$(printf '%s' "${encoded_port}" | base64 --decode)"
export PGDATABASE="$(printf '%s' "${encoded_database}" | base64 --decode)"
export PGUSER="$(printf '%s' "${encoded_user}" | base64 --decode)"
export PGPASSWORD="$(printf '%s' "${encoded_password}" | base64 --decode)"
export PGCONNECT_TIMEOUT=10
unset database_fields encoded_host encoded_port encoded_database encoded_user encoded_password database_extra
if [[ "${PGDATABASE}" != "situation_studio" ]]; then
  echo "The Studio web role does not target the exact production database." >&2
  exit 1
fi
database_probe="$(
  timeout --signal=TERM --kill-after=5s 20s psql \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    --quiet \
    --tuples-only \
    --no-align <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT CASE WHEN current_database() = 'situation_studio' THEN 1 ELSE 0 END;
COMMIT;
SQL
)"
if [[ "${database_probe}" != "1" ]]; then
  echo "The Studio web role did not prove read-only database reachability." >&2
  exit 1
fi

headers_file="$(mktemp)"
body_file="$(mktemp)"
cleanup() {
  rm -f -- "${headers_file}" "${body_file}"
}
trap cleanup EXIT HUP INT TERM
readiness_status="$(
  curl \
    --silent \
    --show-error \
    --max-time 10 \
    --dump-header "${headers_file}" \
    --output "${body_file}" \
    --write-out '%{http_code}' \
    "${readiness_url}"
)"
READINESS_STATUS="${readiness_status}" \
READINESS_BODY="$(<"${body_file}")" \
READINESS_HEADERS="$(<"${headers_file}")" \
EXPECTED_COMMIT="${expected_commit}" \
node -e '
  const { createHash } = require("node:crypto");
  let body;
  try {
    body = JSON.parse(process.env.READINESS_BODY ?? "");
  } catch {
    console.error("The diagnosed readiness response is not valid JSON.");
    process.exit(1);
  }
  const exactBody =
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Object.keys(body).length === 2 &&
    body.status === "not-ready" &&
    body.database === "unreachable";
  const headers = process.env.READINESS_HEADERS ?? "";
  if (
    process.env.READINESS_STATUS !== "503" ||
    !exactBody ||
    !/^cache-control:\s*private,\s*no-store\s*$/imu.test(headers) ||
    !/^content-type:\s*application\/json(?:;.*)?$/imu.test(headers)
  ) {
    console.error("The current release no longer matches the diagnosed capability-readiness failure.");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: "capability-readiness-transition-v1",
    currentCommit: process.env.EXPECTED_COMMIT,
    database: "reachable",
    readinessStatus: 503,
    readinessBodySha256: createHash("sha256")
      .update(process.env.READINESS_BODY ?? "")
      .digest("hex"),
  }));
'
