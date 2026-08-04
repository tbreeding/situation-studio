#!/usr/bin/env bash
set -euo pipefail

report_error() {
  local status="${?}"
  echo "Candidate readiness verification failed at line ${BASH_LINENO[0]} (status ${status})." >&2
  exit "${status}"
}
trap report_error ERR

: "${STUDIO_CANDIDATE_RELEASE:?missing candidate release}"
: "${STUDIO_CANDIDATE_WEB_ENVIRONMENT:?missing web environment}"
: "${STUDIO_CANDIDATE_COMMIT:?missing candidate commit}"
: "${STUDIO_CANDIDATE_PREVIOUS_COMMIT:?missing previous commit}"
: "${STUDIO_CANDIDATE_READINESS_PORT:?missing candidate readiness port}"

readonly candidate_release="${STUDIO_CANDIDATE_RELEASE}"
readonly web_environment="${STUDIO_CANDIDATE_WEB_ENVIRONMENT}"
readonly candidate_commit="${STUDIO_CANDIDATE_COMMIT}"
readonly previous_commit="${STUDIO_CANDIDATE_PREVIOUS_COMMIT}"
readonly readiness_port="${STUDIO_CANDIDATE_READINESS_PORT}"
readonly trusted_path="${PATH}"

if [[
  ! "${candidate_release}" =~ ^/[A-Za-z0-9._/-]+$ ||
  "${candidate_release}" == "/" ||
  "${candidate_release}" == */ ||
  ! "${candidate_commit}" =~ ^[a-f0-9]{40}$ ||
  ! "${previous_commit}" =~ ^[a-f0-9]{40}$ ||
  "${readiness_port}" != "3016"
]]; then
  echo "The candidate-readiness inputs are invalid." >&2
  exit 1
fi
if [[
  ! -d "${candidate_release}" ||
  -L "${candidate_release}" ||
  ! -f "${candidate_release}/.release-commit" ||
  -L "${candidate_release}/.release-commit" ||
  "$(cat "${candidate_release}/.release-commit")" != "${candidate_commit}"
]]; then
  echo "The candidate-readiness release identity does not match." >&2
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
for required_command in node curl mktemp sha256sum; do
  command -v "${required_command}" >/dev/null
done
if curl --silent --max-time 1 \
  "http://127.0.0.1:${readiness_port}/health/live" >/dev/null; then
  echo "The candidate-readiness port is already serving HTTP." >&2
  exit 1
fi

temporary_directory="$(mktemp -d)"
candidate_pid=""
cleanup() {
  if [[ -n "${candidate_pid}" ]] && kill -0 "${candidate_pid}" 2>/dev/null; then
    kill -TERM "${candidate_pid}" 2>/dev/null || true
    wait "${candidate_pid}" 2>/dev/null || true
  fi
  rm -rf -- "${temporary_directory}"
}
trap cleanup EXIT HUP INT TERM

set -a
source "${web_environment}"
set +a
export PATH="${trusted_path}"
export NODE_ENV=production
export SITUATION_STUDIO_DISABLE_BACKGROUND_RECONCILIATION=true
web_release="${candidate_release}/apps/web"
next_binary="${web_release}/node_modules/next/dist/bin/next"
test -f "${next_binary}"
test -d "${web_release}/.next"
cd "${web_release}"
node "${next_binary}" start \
  --hostname 127.0.0.1 \
  --port "${readiness_port}" \
  >"${temporary_directory}/server.log" 2>&1 &
candidate_pid="${!}"

for attempt in $(seq 1 45); do
  if ! kill -0 "${candidate_pid}" 2>/dev/null; then
    tail -100 "${temporary_directory}/server.log" >&2 || true
    echo "The candidate readiness server exited before verification." >&2
    exit 1
  fi
  live_status="$(
    curl \
      --silent \
      --max-time 2 \
      --output /dev/null \
      --write-out '%{http_code}' \
      "http://127.0.0.1:${readiness_port}/health/live" || true
  )"
  ready_status="$(
    curl \
      --silent \
      --max-time 2 \
      --dump-header "${temporary_directory}/ready.headers" \
      --output "${temporary_directory}/ready.body" \
      --write-out '%{http_code}' \
      "http://127.0.0.1:${readiness_port}/health/ready" || true
  )"
  if [[ "${live_status}" == "200" && "${ready_status}" == "200" ]]; then
    CANDIDATE_COMMIT="${candidate_commit}" \
    PREVIOUS_COMMIT="${previous_commit}" \
    READINESS_PORT="${readiness_port}" \
    READINESS_BODY="$(<"${temporary_directory}/ready.body")" \
    READINESS_HEADERS="$(<"${temporary_directory}/ready.headers")" \
    node -e '
      const { createHash } = require("node:crypto");
      let body;
      try {
        body = JSON.parse(process.env.READINESS_BODY ?? "");
      } catch {
        process.exit(1);
      }
      const headers = process.env.READINESS_HEADERS ?? "";
      if (
        body?.status !== "ready" ||
        body?.database !== "reachable" ||
        !/^cache-control:\s*private,\s*no-store\s*$/imu.test(headers) ||
        !/^content-type:\s*application\/json(?:;.*)?$/imu.test(headers)
      ) process.exit(1);
      process.stdout.write(JSON.stringify({
        schemaVersion: "candidate-readiness-transition-v1",
        candidateCommit: process.env.CANDIDATE_COMMIT,
        previousCommit: process.env.PREVIOUS_COMMIT,
        port: Number(process.env.READINESS_PORT),
        liveStatus: 200,
        readinessStatus: 200,
        readinessBodySha256: createHash("sha256")
          .update(process.env.READINESS_BODY ?? "")
          .digest("hex"),
        observedAt: new Date().toISOString(),
      }));
    ' && exit 0
  fi
  sleep 1
done

tail -100 "${temporary_directory}/server.log" >&2 || true
echo "The isolated candidate did not prove genuine readiness." >&2
exit 1
