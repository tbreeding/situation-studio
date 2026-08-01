#!/usr/bin/env bash
set -euo pipefail

: "${BACKUP_ENVIRONMENT:?missing backup environment path}"

protected_backup_environment="${BACKUP_ENVIRONMENT}"
node_path="$(type -P node || true)"
environment_serializer='process.stdout.write(JSON.stringify(process.env));'
if [[
  "${protected_backup_environment}" != /* ||
  ! -f "${protected_backup_environment}" ||
  -L "${protected_backup_environment}" ||
  "${node_path}" != /* ||
  ! -x "${node_path}"
]]; then
  echo "The protected backup environment cannot be read safely." >&2
  exit 1
fi
readonly protected_backup_environment node_path environment_serializer

PROTECTED_BACKUP_ENVIRONMENT="${protected_backup_environment}" \
BACKUP_ENV_NODE_BINARY="${node_path}" \
BACKUP_ENV_SERIALIZER="${environment_serializer}" \
  /bin/bash -c '
    set -euo pipefail
    readonly protected_backup_environment="${PROTECTED_BACKUP_ENVIRONMENT}"
    readonly node_path="${BACKUP_ENV_NODE_BINARY}"
    readonly environment_serializer="${BACKUP_ENV_SERIALIZER}"
    set -a
    source "${protected_backup_environment}" >&2 </dev/null
    set +a
    unset NODE_OPTIONS
    "${node_path}" -e "${environment_serializer}"
  ' </dev/null |
  "${node_path}" -e '
    const requiredNames = [
      "STUDIO_BACKUP_DATABASE_URL",
      "STUDIO_BACKUP_QUEUE_DATABASE_URL",
      "STUDIO_BACKUP_DESTINATION",
      "STUDIO_BACKUP_GPG_RECIPIENT",
      "STUDIO_BACKUP_REQUIRE_OFFSITE",
      "STUDIO_BACKUP_OFFSITE_SSH_TARGET",
      "STUDIO_BACKUP_OFFSITE_DIRECTORY",
    ];
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      let values;
      try {
        values = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        console.error("The protected backup environment did not load completely.");
        process.exit(1);
      }
      if (!values || typeof values !== "object" || Array.isArray(values))
        process.exit(1);
      for (const name of requiredNames) {
        const value = values[name];
        if (typeof value !== "string" || !value || /[\r\n\0]/u.test(value)) {
          console.error(
            `The protected backup environment is missing a safe ${name} value.`,
          );
          process.exit(1);
        }
        process.stdout.write(
          `${name}\t${Buffer.from(value, "utf8").toString("base64")}\n`,
        );
      }
    });
  '
