#!/usr/bin/env bash
set -euo pipefail

: "${STUDIO_BACKUP_DATABASE_URL:?missing Studio backup database URL}"
: "${STUDIO_BACKUP_QUEUE_DATABASE_URL:?missing backup queue database URL}"

SOURCE_DATABASE_URL="${STUDIO_BACKUP_DATABASE_URL}" \
QUEUE_DATABASE_URL="${STUDIO_BACKUP_QUEUE_DATABASE_URL}" node <<'NODE'
function fail(message) {
  console.error(message);
  process.exit(1);
}

function databaseIdentity(label, rawUrl) {
  const authorityMatch =
    typeof rawUrl === "string"
      ? rawUrl.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/u)
      : null;
  const rawAuthority = authorityMatch?.[1] ?? "";
  const rawEndpoint = rawAuthority.slice(rawAuthority.lastIndexOf("@") + 1);
  if (!/^[A-Za-z0-9.-]+(?::[0-9]+)?$/u.test(rawEndpoint))
    fail(
      `The ${label} database URL must identify exactly one ASCII hostname endpoint; IPv6, percent-encoded hosts, and libpq host lists are not supported.`,
    );

  let value;
  try {
    value = new URL(rawUrl);
  } catch {
    fail(`The ${label} database URL is invalid.`);
  }
  if (!value || !["postgres:", "postgresql:"].includes(value.protocol))
    fail(`The ${label} database URL must use PostgreSQL.`);

  let database;
  try {
    database = decodeURIComponent(value.pathname.replace(/^\//u, ""));
  } catch {
    fail(`The ${label} database URL is invalid.`);
  }
  for (const override of [
    "host",
    "hostaddr",
    "port",
    "dbname",
    "service",
    "servicefile",
  ]) {
    if (value.searchParams.has(override))
      fail(
        `The ${label} database URL must not override its database endpoint in query parameters.`,
      );
  }

  const hostname = value.hostname.toLowerCase().replace(/\.$/u, "");
  const port = value.port || "5432";
  if (
    !hostname ||
    hostname.split(".").some(
      (part) =>
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(part),
    ) ||
    !/^[0-9]+$/u.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    /[\r\n\0]/u.test(database)
  )
    fail(`The ${label} database URL is invalid.`);
  if (database !== "situation_studio")
    fail(`The ${label} database must be situation_studio.`);

  return { hostname, port: String(Number(port)), database };
}

const source = databaseIdentity("Studio backup source", process.env.SOURCE_DATABASE_URL);
const queue = databaseIdentity("backup receipt queue", process.env.QUEUE_DATABASE_URL);
if (
  source.hostname !== queue.hostname ||
  source.port !== queue.port ||
  source.database !== queue.database
)
  fail(
    "Studio backup source and receipt queue must use the same normalized database host, port, and database.",
  );
NODE
