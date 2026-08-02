import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const executeFile = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const backupPath = path.join(root, "ops/backup-studio.sh");
const queuePath = path.join(root, "ops/process-backup-queue.sh");
const deploymentBackupPath = path.join(root, "ops/run-deployment-backup.sh");
const databaseIdentityVerifierPath = path.join(
  root,
  "ops/verify-studio-backup-database-identity.sh",
);
const receiptId = "10000000-0000-4000-8000-000000000001";

function position(source: string, fragment: string) {
  const index = source.indexOf(fragment);
  expect(index, `missing backup-runner fragment: ${fragment}`).toBeGreaterThan(
    -1,
  );
  return index;
}

async function writeExecutable(file: string, source: string) {
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
}

function backupEnvironment(destination: string) {
  return {
    ...process.env,
    STUDIO_BACKUP_DATABASE_URL:
      "postgresql://backup" + ":unused@localhost/situation_studio",
    STUDIO_BACKUP_QUEUE_DATABASE_URL:
      "postgresql://operator" + ":unused@localhost:5432/situation_studio",
    STUDIO_BACKUP_DESTINATION: destination,
    STUDIO_BACKUP_GPG_RECIPIENT: "backup-test@example.invalid",
  };
}

function postgresConnection(authorityAndPath: string) {
  return "postgresql://" + authorityAndPath;
}

async function queueFixture(transitionCount: 0 | 1) {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "studio-backup-runner-"),
  );
  const fakeBin = path.join(temporaryRoot, "bin");
  const backupDestination = path.join(temporaryRoot, "backups");
  const psqlState = path.join(temporaryRoot, "psql-state");
  const psqlLog = path.join(temporaryRoot, "psql-log");
  await executeFile("mkdir", ["-p", fakeBin]);
  await writeExecutable(
    path.join(fakeBin, "flock"),
    `#!/usr/bin/env bash
set -euo pipefail
exit "\${FAKE_FLOCK_STATUS:-0}"
`,
  );
  await writeExecutable(
    path.join(fakeBin, "timeout"),
    `#!/usr/bin/env bash
set -euo pipefail
while [[ "\${#}" -gt 0 && "\${1}" == --* ]]; do
  shift
done
if [[ "\${#}" -lt 2 ]]; then
  exit 64
fi
shift
if [[ "\${1}" == */backup-studio.sh ]]; then
  if [[ "\${FAKE_PRECLAIM:-false}" == "true" ]]; then
    object_key="situation-studio-20260801T200000Z-\${FAKE_RECEIPT_ID}.dump.gpg"
    printf 'artifact' >"\${STUDIO_BACKUP_DESTINATION}/\${object_key}"
    chmod 0600 "\${STUDIO_BACKUP_DESTINATION}/\${object_key}"
    printf '{"objectKey":"%s","checksum":"%s","byteLength":8,"encrypted":true,"offsite":"backup@example:/srv/offsite/%s"}\\n' \
      "\${object_key}" "$(printf 'a%.0s' {1..64})" "\${object_key}"
  else
    printf '{"objectKey":"situation-studio-test.dump.gpg","checksum":"%s","byteLength":4096,"encrypted":true,"offsite":""}\\n' "$(printf 'a%.0s' {1..64})"
  fi
  exit 0
fi
exec "\${@}"
`,
  );
  await writeExecutable(
    path.join(fakeBin, "shasum"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s  %s\\n' "$(printf 'a%.0s' {1..64})" "\${@: -1}"
`,
  );
  await writeExecutable(
    path.join(fakeBin, "gpg"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAKE_GPG_CATALOG_SIGPIPE:-false}" == "true" ]]; then
  invocation=0
  if [[ -f "\${FAKE_GPG_STATE}" ]]; then
    invocation="$(cat "\${FAKE_GPG_STATE}")"
  fi
  invocation="$((invocation + 1))"
  printf '%s' "\${invocation}" >"\${FAKE_GPG_STATE}"
  if [[ "\${invocation}" == "2" ]]; then
    printf 'catalog-prefix'
    exit 141
  fi
fi
cat "\${@: -1}"
`,
  );
  await writeExecutable(
    path.join(fakeBin, "pg_restore"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAKE_PG_RESTORE_EARLY_CLOSE:-false}" == "true" ]]; then
  exit 0
fi
cat >/dev/null
exit "\${FAKE_PG_RESTORE_STATUS:-0}"
`,
  );
  await writeExecutable(
    path.join(fakeBin, "psql"),
    `#!/usr/bin/env bash
set -euo pipefail
invocation=0
if [[ -f "\${FAKE_PSQL_STATE}" ]]; then
  invocation="$(cat "\${FAKE_PSQL_STATE}")"
fi
invocation="$((invocation + 1))"
printf '%s' "\${invocation}" >"\${FAKE_PSQL_STATE}"
stdin_sql=""
stdin_sql="$(cat)"
for argument in "\${@}"; do
  case "\${argument}" in
    -c|-[^-]*c|--command|--command=*)
      echo "fake psql rejects command-string SQL" >&2
      exit 64
      ;;
  esac
done
if [[ -z "\${stdin_sql}" ]]; then
  echo "fake psql requires controlled stdin SQL" >&2
  exit 65
fi
{
  printf '%s\\n' "--- invocation \${invocation} ---"
  printf '%s\\n' "\${*}"
  printf '%s\\n' "\${stdin_sql}"
} >>"\${FAKE_PSQL_LOG}"
case "\${invocation}" in
  1)
    printf '%s\\t%s\\n' "\${FAKE_RECEIPT_ID}" '2026-08-01 20:00:00+00'
    ;;
  2)
    if [[ "\${FAKE_TRANSITION_COUNT}" == "1" ]]; then
      printf '1\\t%s\\n' "\${FAKE_RECEIPT_ID}"
    else
      printf '0\\t\\n'
    fi
    ;;
esac
`,
  );

  return {
    backupDestination,
    cleanup: () => rm(temporaryRoot, { force: true, recursive: true }),
    environment: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      FAKE_FLOCK_STATUS: "0",
      FAKE_GPG_STATE: path.join(temporaryRoot, "gpg-state"),
      FAKE_PSQL_LOG: psqlLog,
      FAKE_PSQL_STATE: psqlState,
      FAKE_RECEIPT_ID: receiptId,
      FAKE_TRANSITION_COUNT: String(transitionCount),
      STUDIO_BACKUP_DESTINATION: backupDestination,
      STUDIO_BACKUP_DATABASE_URL:
        "postgresql://backup" + ":unused@localhost/situation_studio",
      STUDIO_BACKUP_QUEUE_DATABASE_URL:
        "postgresql://operator" + ":unused@localhost:5432/situation_studio",
    },
    psqlLog,
    psqlState,
  };
}

describe("production backup runner contract", () => {
  test("both runners are syntactically valid and every external backup phase is bounded", async () => {
    await expect(
      Promise.all([
        executeFile("bash", ["-n", backupPath]),
        executeFile("bash", ["-n", queuePath]),
        executeFile("bash", ["-n", deploymentBackupPath]),
        executeFile("bash", ["-n", databaseIdentityVerifierPath]),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
    ]);
    const [backup, queue] = await Promise.all([
      readFile(backupPath, "utf8"),
      readFile(queuePath, "utf8"),
    ]);
    for (const fragment of [
      "STUDIO_BACKUP_PG_DUMP_TIMEOUT_SECONDS",
      "STUDIO_BACKUP_GPG_TIMEOUT_SECONDS",
      "STUDIO_BACKUP_SSH_TIMEOUT_SECONDS",
      "STUDIO_BACKUP_SCP_TIMEOUT_SECONDS",
      '"${pg_dump_timeout_seconds}s" \\\n  pg_dump',
      '"${gpg_timeout_seconds}s" \\\n  gpg',
      '"${ssh_timeout_seconds}s" \\\n    ssh',
      '"${scp_timeout_seconds}s" \\\n    scp',
    ])
      position(backup, fragment);
    for (const fragment of [
      "STUDIO_BACKUP_OVERALL_TIMEOUT_SECONDS",
      '"${overall_timeout_seconds}s" \\\n  ops/backup-studio.sh',
      "trap finish_runner EXIT",
      "trap 'handle_signal 143' TERM",
    ])
      position(queue, fragment);
  });

  test("the deployment wrapper rejects backup-configuration drift before running its preclaimed worker", async () => {
    const source = await readFile(deploymentBackupPath, "utf8");
    const configurationFence = position(
      source,
      '"${observed_backup_configuration_id}" != "${expected_backup_configuration_id}"',
    );
    const queueInvocation = position(source, '/bin/bash "${queue_runner}"');
    expect(configurationFence).toBeLessThan(queueInvocation);
    for (const fragment of [
      'expected_backup_configuration_id="${3:-}"',
      "^configured-offsite:[a-f0-9]{64}$",
      "LOCAL_DESTINATION",
      "ENCRYPTION_FINGERPRINT",
      "The protected backup configuration changed after deployment preflight.",
    ])
      position(source, fragment);
  });

  test("source and receipt URLs must identify the same situation_studio database", async () => {
    const runVerifier = (sourceUrl: string, queueUrl: string) =>
      executeFile("bash", [databaseIdentityVerifierPath], {
        env: {
          ...process.env,
          STUDIO_BACKUP_DATABASE_URL: sourceUrl,
          STUDIO_BACKUP_QUEUE_DATABASE_URL: queueUrl,
        },
      });

    await expect(
      runVerifier(
        postgresConnection("reader:one@DB.EXAMPLE.:5432/situation_studio"),
        "postgres://operator" + ":two@db.example/situation_studio",
      ),
    ).resolves.toMatchObject({ stderr: "", stdout: "" });
    for (const [sourceUrl, queueUrl, message] of [
      [
        postgresConnection("reader:one@db-a.example/situation_studio"),
        postgresConnection("operator:two@db-b.example/situation_studio"),
        "same normalized database host, port, and database",
      ],
      [
        postgresConnection("reader:one@db.example:5432/situation_studio"),
        postgresConnection("operator:two@db.example:5433/situation_studio"),
        "same normalized database host, port, and database",
      ],
      [
        postgresConnection("reader:one@db.example/not_situation_studio"),
        postgresConnection("operator:two@db.example/not_situation_studio"),
        "Studio backup source database must be situation_studio",
      ],
      [
        postgresConnection(
          "reader:one@db-a.example,db-b.example/situation_studio",
        ),
        postgresConnection("operator:two@db-a.example/situation_studio"),
        "must identify exactly one ASCII hostname endpoint",
      ],
      [
        postgresConnection("reader:one@db%2Cshadow.example/situation_studio"),
        postgresConnection("operator:two@db.example/situation_studio"),
        "must identify exactly one ASCII hostname endpoint",
      ],
      [
        postgresConnection("reader:one@[::1]/situation_studio"),
        postgresConnection("operator:two@localhost/situation_studio"),
        "IPv6, percent-encoded hosts, and libpq host lists are not supported",
      ],
      [
        postgresConnection(
          "reader:one@db.example/situation_studio?host=shadow.example",
        ),
        postgresConnection("operator:two@db.example/situation_studio"),
        "must not override its database endpoint in query parameters",
      ],
    ] as const) {
      await expect(runVerifier(sourceUrl, queueUrl)).rejects.toMatchObject({
        stderr: expect.stringContaining(message),
      });
    }
  });

  test("the destination lock precedes recovery and claim and terminal updates are fenced", async () => {
    const queue = await readFile(queuePath, "utf8");
    const identity = position(
      queue,
      '/bin/bash "${database_identity_verifier}"',
    );
    const lock = position(queue, 'flock "${lock_arguments[@]}" 9');
    const recovery = position(queue, "WITH recovered AS (");
    const claim = position(queue, 'claim="$(');
    expect(identity).toBeLessThan(lock);
    expect(lock).toBeLessThan(claim);
    expect(lock).toBeLessThan(recovery);
    for (const fragment of [
      ".situation-studio-backup.lock",
      "stat -c '%u' \"${backup_destination}\"",
      "stat -c '%a' \"${backup_destination}\"",
      '"${backup_destination_owner}" != "$(id -u)"',
      '"${backup_destination_mode}" != "700"',
      '"${backup_lock_mode}" != "600"',
      "failure_code = 'BACKUP_RUNNER_STALE'",
      "started_at IS NULL",
      "started_at < now() - make_interval(",
      'failure_code="BACKUP_COMMAND_FAILED"',
      'failure_code="DEPLOYMENT_BACKUP_FAILED"',
      'runner_mode="preclaimed"',
      "destination_id = 'deployment-quiesced'",
      'flock "${lock_arguments[@]}" 9',
      'lock_arguments=(-w "${deployment_lock_wait_seconds}")',
      'export STUDIO_BACKUP_OBJECT_SUFFIX="-${receipt_id}"',
      "--no-align <<'SQL'",
      "AND state = 'RUNNING'",
      "AND started_at = :'receipt_started_at'::timestamptz",
      "SELECT count(*)::text || E'\\t'",
      '"${transition_count}" != "1"',
      '"${transitioned_receipt_id}" != "${receipt_id}"',
    ])
      position(queue, fragment);
    expect(queue).not.toContain('--command "');
    expect(queue).not.toContain(String.raw`E'\\t'`);
    expect(queue.match(/E'\\t'/gu)).toHaveLength(2);
    expect(await readFile(deploymentBackupPath, "utf8")).not.toContain(
      '--command "',
    );
  });

  test("unsafe local and off-site paths and option-like SSH targets fail before backup work", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "studio-backup-paths-"),
    );
    try {
      for (const destination of [
        "/",
        `${temporaryRoot}/`,
        `${temporaryRoot}//backups`,
        `${temporaryRoot}/nested/../backups`,
      ]) {
        await expect(
          executeFile("bash", [backupPath], {
            env: backupEnvironment(destination),
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            "Backup destination must be an explicit safe absolute directory.",
          ),
        });
      }

      const safeDestination = `${temporaryRoot}/local`;
      await expect(
        executeFile("bash", [backupPath], {
          env: {
            ...backupEnvironment(safeDestination),
            STUDIO_BACKUP_OFFSITE_DIRECTORY: "/srv/backups",
            STUDIO_BACKUP_OFFSITE_SSH_TARGET: "-ProxyCommand=unsafe",
            STUDIO_BACKUP_REQUIRE_OFFSITE: "true",
          },
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Off-site SSH target contains unsupported characters.",
        ),
      });

      for (const remoteDirectory of [
        "/",
        "/srv/backups/",
        "/srv//backups",
        "/srv/../backups",
      ]) {
        await expect(
          executeFile("bash", [backupPath], {
            env: {
              ...backupEnvironment(safeDestination),
              STUDIO_BACKUP_OFFSITE_DIRECTORY: remoteDirectory,
              STUDIO_BACKUP_OFFSITE_SSH_TARGET: "backup@example",
              STUDIO_BACKUP_REQUIRE_OFFSITE: "true",
            },
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            "Off-site backup directory must be an explicit safe absolute path.",
          ),
        });
      }
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("lock contention exits before querying or claiming a receipt", async () => {
    const fixture = await queueFixture(1);
    try {
      await expect(
        executeFile("bash", [queuePath], {
          cwd: root,
          env: { ...fixture.environment, FAKE_FLOCK_STATUS: "1" },
        }),
      ).resolves.toMatchObject({ stderr: "", stdout: "" });
      await expect(readFile(fixture.psqlState, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("deployment backup lock contention fails instead of reporting idle success", async () => {
    const fixture = await queueFixture(1);
    try {
      await expect(
        executeFile(
          "bash",
          [queuePath, "--preclaimed", receiptId, "2026-08-01 20:00:00+00"],
          {
            cwd: root,
            env: {
              ...fixture.environment,
              FAKE_FLOCK_STATUS: "1",
              STUDIO_BACKUP_DEPLOYMENT_LOCK_WAIT_SECONDS: "1",
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Unable to acquire the backup single-flight lock for the deployment checkpoint.",
        ),
      });
      await expect(readFile(fixture.psqlState, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  test("a failed deployment restore check fences FAILED and never transitions VERIFIED", async () => {
    const fixture = await queueFixture(1);
    try {
      await expect(
        executeFile(
          "bash",
          [queuePath, "--preclaimed", receiptId, "2026-08-01 20:00:00+00"],
          {
            cwd: root,
            env: {
              ...fixture.environment,
              FAKE_PRECLAIM: "true",
              FAKE_PG_RESTORE_STATUS: "1",
              STUDIO_BACKUP_DEPLOYMENT_RESTORE_CHECK_TIMEOUT_SECONDS: "1",
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "does not expose a readable PostgreSQL custom-format catalog",
        ),
      });
      expect(await readFile(fixture.psqlState, "utf8")).toBe("2");
      const sql = await readFile(fixture.psqlLog, "utf8");
      expect(sql).toContain("--set=failure_code=DEPLOYMENT_BACKUP_FAILED");
      expect(sql).toContain("failure_code = :'failure_code'");
      expect(sql).not.toContain("SET state = 'VERIFIED'");
    } finally {
      await fixture.cleanup();
    }
  });

  test("a valid catalog accepts the expected upstream early-close status after full decryption", async () => {
    const fixture = await queueFixture(1);
    try {
      await expect(
        executeFile(
          "bash",
          [queuePath, "--preclaimed", receiptId, "2026-08-01 20:00:00+00"],
          {
            cwd: root,
            env: {
              ...fixture.environment,
              FAKE_PRECLAIM: "true",
              FAKE_GPG_CATALOG_SIGPIPE: "true",
              FAKE_PG_RESTORE_EARLY_CLOSE: "true",
              STUDIO_BACKUP_DEPLOYMENT_RESTORE_CHECK_TIMEOUT_SECONDS: "1",
            },
          },
        ),
      ).resolves.toMatchObject({ stderr: "", stdout: "" });
      expect(await readFile(fixture.psqlState, "utf8")).toBe("2");
      expect(await readFile(fixture.environment.FAKE_GPG_STATE, "utf8")).toBe(
        "2",
      );
      const sql = await readFile(fixture.psqlLog, "utf8");
      expect(sql).toContain(`--set=receipt_id=${receiptId}`);
      expect(sql).toContain("--set=receipt_started_at=2026-08-01 20:00:00+00");
      expect(sql).toContain(
        "SELECT receipt.id::text, receipt.started_at::text",
      );
      expect(sql).toContain("SET state = 'VERIFIED'");
      expect(sql).not.toContain("--set=failure_code=DEPLOYMENT_BACKUP_FAILED");
    } finally {
      await fixture.cleanup();
    }
  });

  test("one fenced RUNNING transition succeeds", async () => {
    const fixture = await queueFixture(1);
    try {
      await expect(
        executeFile("bash", [queuePath], {
          cwd: root,
          env: fixture.environment,
        }),
      ).resolves.toMatchObject({ stderr: "", stdout: "" });
      expect(await readFile(fixture.psqlState, "utf8")).toBe("2");
      const sql = await readFile(fixture.psqlLog, "utf8");
      expect(sql).toContain("failure_code = 'BACKUP_RUNNER_STALE'");
      expect(sql).toContain("AND state = 'RUNNING'");
      expect(sql).toContain(
        "AND started_at = :'receipt_started_at'::timestamptz",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test("a zero-row success transition fails and performs a fenced failure update", async () => {
    const fixture = await queueFixture(0);
    try {
      await expect(
        executeFile("bash", [queuePath], {
          cwd: root,
          env: fixture.environment,
        }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Backup verification did not transition exactly one fenced RUNNING receipt.",
        ),
      });
      expect(await readFile(fixture.psqlState, "utf8")).toBe("3");
      const sql = await readFile(fixture.psqlLog, "utf8");
      expect(sql).toContain("--set=failure_code=BACKUP_COMMAND_FAILED");
      expect(sql).toContain("failure_code = :'failure_code'");
      expect(sql).toContain(
        "AND started_at = :'receipt_started_at'::timestamptz",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  test("failed backups clean local finals and remote partials before returning", async () => {
    const backup = await readFile(backupPath, "utf8");
    for (const fragment of [
      "trap finish_backup EXIT",
      '"${backup_destination_owner}" != "$(id -u)"',
      '"${backup_destination_mode}" != "700"',
      '"${backup_completed}" != "true"',
      'rm -f -- "${backup_final}"',
      '"${offsite_remote_promoted}" == "true"',
      'cleanup_remote_path="${offsite_partial}"',
      'cleanup_remote_path="${offsite_final}"',
      "ssh -o BatchMode=yes -o ConnectTimeout=15 --",
      '"${offsite_target}" rm -f -- "${cleanup_remote_path}"',
    ])
      position(backup, fragment);

    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "studio-backup-cleanup-"),
    );
    const fakeBin = path.join(temporaryRoot, "bin");
    const destination = path.join(temporaryRoot, "backups");
    const remoteLog = path.join(temporaryRoot, "remote-log");
    try {
      await executeFile("mkdir", ["-p", fakeBin]);
      await writeExecutable(
        path.join(fakeBin, "timeout"),
        `#!/usr/bin/env bash
set -euo pipefail
while [[ "\${#}" -gt 0 && "\${1}" == --* ]]; do
  shift
done
shift
exec "\${@}"
`,
      );
      await writeExecutable(
        path.join(fakeBin, "pg_dump"),
        `#!/usr/bin/env bash
set -euo pipefail
printf 'encrypted-input'
`,
      );
      await writeExecutable(
        path.join(fakeBin, "gpg"),
        `#!/usr/bin/env bash
set -euo pipefail
output=''
while [[ "\${#}" -gt 0 ]]; do
  if [[ "\${1}" == "--output" ]]; then
    shift
    output="\${1}"
  fi
  shift
done
cat >"\${output}"
`,
      );
      await writeExecutable(
        path.join(fakeBin, "scp"),
        `#!/usr/bin/env bash
set -euo pipefail
printf 'scp %s\\n' "\${*}" >>"\${FAKE_REMOTE_LOG}"
`,
      );
      await writeExecutable(
        path.join(fakeBin, "ssh"),
        `#!/usr/bin/env bash
set -euo pipefail
printf 'ssh %s\\n' "\${*}" >>"\${FAKE_REMOTE_LOG}"
if [[ " \${*} " == *" backup@example bash -s -- "* ]]; then
  cat >/dev/null
  exit 42
fi
`,
      );

      await expect(
        executeFile("bash", [backupPath], {
          env: {
            ...backupEnvironment(destination),
            FAKE_REMOTE_LOG: remoteLog,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            STUDIO_BACKUP_OFFSITE_DIRECTORY: "/srv/situation-studio",
            STUDIO_BACKUP_OFFSITE_SSH_TARGET: "backup@example",
            STUDIO_BACKUP_REQUIRE_OFFSITE: "true",
          },
        }),
      ).rejects.toBeDefined();
      expect(await readdir(destination)).toEqual([]);
      expect(await readFile(remoteLog, "utf8")).toMatch(
        /ssh -o BatchMode=yes -o ConnectTimeout=15 -- backup@example rm -f -- \/srv\/situation-studio\/\.situation-studio-[^\s]+\.dump\.gpg\.partial/u,
      );
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});
