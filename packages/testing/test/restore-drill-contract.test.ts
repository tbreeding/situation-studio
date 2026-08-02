import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const executeFile = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const recorderPath = path.join(root, "ops/record-restore-drill.sh");
const restoreDrillPath = path.join(root, "ops/restore-drill.sh");
const publicationBackupStatePath = path.join(
  root,
  "ops/publication-backup-state.sql",
);

const receiptId = "a0000000-0000-4000-8000-000000000001";
const objectKey = "situation-studio-20260801T210000Z.dump.gpg";
const offsiteTarget = "backup@example";
const offsiteDirectory = "/srv/offsite";
const objectBody = Buffer.from("encrypted-backup-fixture", "utf8");
const checksum = createHash("sha256").update(objectBody).digest("hex");
const destinationId = `offsite-verified:${createHash("sha256")
  .update(`${offsiteTarget}:${offsiteDirectory}/${objectKey}`)
  .digest("hex")}`;
const backupQueueUrl =
  "postgresql://backup" + ":secret@localhost/situation_studio";
const restoreDrillUrl =
  "postgresql://restore" +
  ":secret@localhost/situation_studio_restore_drill_contract";

async function writeExecutable(file: string, body: string) {
  await writeFile(file, body, "utf8");
  await chmod(file, 0o755);
}

async function createFixture() {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "studio-restore-recorder-"),
  );
  const releases = path.join(temporaryRoot, "releases");
  const release = path.join(releases, "20260801T210000Z");
  const current = path.join(temporaryRoot, "current");
  const ops = path.join(release, "ops");
  const candidateOps = path.join(temporaryRoot, "candidate", "ops");
  const candidateRecorder = path.join(candidateOps, "record-restore-drill.sh");
  const fakeBin = path.join(temporaryRoot, "bin");
  const backupDirectory = path.join(temporaryRoot, "backups");
  const environmentFile = path.join(temporaryRoot, "backup.env");
  const databaseLog = path.join(temporaryRoot, "database.log");
  const sshLog = path.join(temporaryRoot, "ssh.log");
  const localObject = path.join(backupDirectory, objectKey);
  await Promise.all([
    mkdir(ops, { recursive: true }),
    mkdir(candidateOps, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(backupDirectory, { recursive: true }),
  ]);
  await copyFile(recorderPath, candidateRecorder);
  await chmod(candidateRecorder, 0o755);
  await writeFile(
    path.join(release, ".release-commit"),
    `${"a".repeat(40)}\n`,
    "utf8",
  );
  await symlink(release, current, "dir");
  await chmod(backupDirectory, 0o700);
  await writeFile(localObject, objectBody);
  await chmod(localObject, 0o600);

  await writeExecutable(
    path.join(ops, "restore-drill.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
test "\${STUDIO_RESTORE_DRILL_BACKUP}" = "\${FAKE_EXPECTED_BACKUP}"
test "\${STUDIO_RESTORE_DRILL_DATABASE_URL}" = "\${FAKE_EXPECTED_RESTORE_URL}"
if [[ "\${FAKE_RESTORE_FAIL:-false}" == "true" ]]; then
  exit 9
fi
if [[ "\${FAKE_RESTORE_EMPTY:-false}" == "true" ]]; then
  printf '{"database":"situation_studio_restore_drill_contract","migrations":1,"situations":0,"productionVersions":0,"contentBlobs":0,"auditEvents":0}\n'
  exit 0
fi
if [[ "\${FAKE_RESTORE_LEGACY_PSQL_NOISE:-false}" == "true" ]]; then
  printf ' set_config \n------------\n \n(1 row)\n\n'
fi
if [[ "\${FAKE_RESTORE_UNEXPECTED_NOISE:-false}" == "true" ]]; then
  printf 'unexpected restore output\n'
fi
printf '{"database":"situation_studio_restore_drill_contract","migrations":1,"situations":2,"productionVersions":3,"contentBlobs":4,"auditEvents":5}\n'
`,
  );
  await writeExecutable(
    path.join(fakeBin, "flock"),
    `#!/usr/bin/env bash
exit 0
`,
  );
  await writeExecutable(
    path.join(fakeBin, "timeout"),
    `#!/usr/bin/env bash
set -euo pipefail
while [[ "\${1:-}" == --* ]]; do shift; done
shift
exec "\${@}"
`,
  );
  await writeExecutable(
    path.join(fakeBin, "ssh"),
    `#!/usr/bin/env bash
set -euo pipefail
cat >/dev/null
printf '%s\n' "\${*}" >>"\${FAKE_SSH_LOG}"
printf '%s\t%s\n' "\${FAKE_CHECKSUM}" "\${FAKE_BYTE_LENGTH}"
`,
  );
  await writeExecutable(
    path.join(fakeBin, "psql"),
    `#!/usr/bin/env bash
set -euo pipefail
sql="$(cat)"
if [[ "\${sql}" == *"SELECT receipt.id,"* ]]; then
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "\${FAKE_RECEIPT_ID}" \
    "\${FAKE_RECEIPT_VERSION}" \
    "\${FAKE_DESTINATION_ID}" \
    "\${FAKE_OBJECT_KEY}" \
    "\${FAKE_CHECKSUM}" \
    "\${FAKE_BYTE_LENGTH}"
elif [[ "\${sql}" == *"restore_drill_result = 'PASSED'"* ]]; then
  if [[ "\${FAKE_FENCE_CHANGED:-false}" != "true" ]]; then
    printf 'PASSED\n' >>"\${FAKE_DATABASE_LOG}"
    printf '%s\n' "\${FAKE_RECEIPT_ID}"
  fi
elif [[ "\${sql}" == *"restore_drill_result = 'FAILED'"* ]]; then
  if [[ "\${FAKE_FENCE_CHANGED:-false}" != "true" ]]; then
    printf 'FAILED\n' >>"\${FAKE_DATABASE_LOG}"
    printf '%s\n' "\${FAKE_RECEIPT_ID}"
  fi
else
  exit 2
fi
`,
  );
  await writeFile(
    environmentFile,
    [
      `STUDIO_BACKUP_QUEUE_DATABASE_URL='${backupQueueUrl}'`,
      `STUDIO_BACKUP_DESTINATION='${backupDirectory}'`,
      "STUDIO_BACKUP_REQUIRE_OFFSITE='true'",
      `STUDIO_BACKUP_OFFSITE_SSH_TARGET='${offsiteTarget}'`,
      `STUDIO_BACKUP_OFFSITE_DIRECTORY='${offsiteDirectory}'`,
      `STUDIO_RESTORE_DRILL_DATABASE_URL='${restoreDrillUrl}'`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(environmentFile, 0o600);
  const approvedRecorderDigest = createHash("sha256")
    .update(await readFile(candidateRecorder))
    .digest("hex");

  return {
    temporaryRoot,
    release,
    current,
    recorder: candidateRecorder,
    environmentFile,
    databaseLog,
    sshLog,
    localObject,
    environment: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      SITUATION_STUDIO_RELEASE: current,
      SITUATION_STUDIO_PROCESS_ENV_FILE: environmentFile,
      SITUATION_STUDIO_APPROVED_RESTORE_RECORDER_SHA256: approvedRecorderDigest,
      FAKE_RECEIPT_ID: receiptId,
      FAKE_RECEIPT_VERSION: "812",
      FAKE_DESTINATION_ID: destinationId,
      FAKE_OBJECT_KEY: objectKey,
      FAKE_CHECKSUM: checksum,
      FAKE_BYTE_LENGTH: String(objectBody.byteLength),
      FAKE_DATABASE_LOG: databaseLog,
      FAKE_SSH_LOG: sshLog,
      FAKE_EXPECTED_BACKUP: localObject,
      FAKE_EXPECTED_RESTORE_URL: restoreDrillUrl,
    },
  };
}

describe("restore-drill evidence recorder", () => {
  test("is syntax-valid and contains bounded, receipt-fenced safety contracts", async () => {
    await expect(
      Promise.all([
        executeFile("bash", ["-n", recorderPath]),
        executeFile("bash", ["-n", restoreDrillPath]),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
    ]);
    const [source, restoreSource] = await Promise.all([
      readFile(recorderPath, "utf8"),
      readFile(restoreDrillPath, "utf8"),
    ]);
    for (const required of [
      ".situation-studio-backup.lock",
      "flock -n 9",
      "timeout --signal=TERM --kill-after=10s 60s",
      "timeout --signal=TERM --kill-after=10s 30s psql",
      "timeout --signal=TERM --kill-after=30s 15m",
      "ssh -o BatchMode=yes -o ConnectTimeout=15 --",
      "receipt.xmin::text",
      "AND xmin::text = :'receipt_version'",
      "restore_drill_result = 'FAILED'",
      "restore_drill_result = 'PASSED'",
      "trap finish_restore_drill EXIT",
      "trap 'exit 143' TERM",
      "SITUATION_STUDIO_APPROVED_RESTORE_RECORDER_SHA256",
      "assert_approved_recorder",
      "current_restore_script",
      'test ! -L "${object_path}"',
    ])
      expect(source).toContain(required);
    for (const required of [
      "SELECT 1 FROM _prisma_migrations WHERE finished_at IS NOT NULL",
      "NOT EXISTS (SELECT 1 FROM situations)",
      "NOT EXISTS (SELECT 1 FROM production_situation_versions)",
      "NOT EXISTS (SELECT 1 FROM content_blobs)",
      "Restore drill rejected an empty Studio production dataset.",
    ])
      expect(restoreSource).toContain(required);
  });

  test("keeps deployment output stable while requiring fresh receipt-bound drill evidence", async () => {
    const source = await readFile(publicationBackupStatePath, "utf8");
    expect(source).toContain(
      `END AS policy_state,
       backup.id,
       backup.destination_id,
       backup.object_key,
       backup.checksum,
       backup.byte_length,
       restore_drill.id AS restore_drill_receipt_id`,
    );
    for (const required of [
      "RESTORE_DRILL_INCOMPLETE",
      "RESTORE_DRILL_TIMESTAMP_INVALID",
      "RESTORE_DRILL_STALE",
      "RESTORE_DRILL_FAILED",
      "current_timestamp - interval '30 days'",
      "restore_drill.restore_drill_at < restore_drill.verified_at",
      "restore_drill.restore_drill_at < restore_drill.created_at",
      "restore_drill.restore_drill_result IS DISTINCT FROM 'PASSED'",
      "receipt.destination_id",
      "receipt.encrypted",
      "receipt.object_key",
      "receipt.checksum",
      "receipt.byte_length",
      "receipt.verified_at",
    ])
      expect(source).toContain(required);
  });

  test("records PASSED only after the exact local and remote object restore succeeds", async () => {
    const fixture = await createFixture();
    try {
      const result = await executeFile(fixture.recorder, [receiptId], {
        env: fixture.environment,
      });
      expect(JSON.parse(result.stdout)).toEqual({
        receiptId,
        restoreDrillResult: "PASSED",
        recorderSha256:
          fixture.environment.SITUATION_STUDIO_APPROVED_RESTORE_RECORDER_SHA256,
        restoreScriptReleaseCommit: "a".repeat(40),
      });
      expect(await readFile(fixture.databaseLog, "utf8")).toBe("PASSED\n");
      expect(
        (await readFile(fixture.sshLog, "utf8")).trim().split("\n"),
      ).toHaveLength(2);
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  test("accepts only the known legacy psql set_config noise before the restore result", async () => {
    const fixture = await createFixture();
    try {
      const result = await executeFile(fixture.recorder, [receiptId], {
        env: {
          ...fixture.environment,
          FAKE_RESTORE_LEGACY_PSQL_NOISE: "true",
        },
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        receiptId,
        restoreDrillResult: "PASSED",
      });
      expect(await readFile(fixture.databaseLog, "utf8")).toBe("PASSED\n");
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects unexpected restore output before the result", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        executeFile(fixture.recorder, [receiptId], {
          env: {
            ...fixture.environment,
            FAKE_RESTORE_UNEXPECTED_NOISE: "true",
          },
        }),
      ).rejects.toThrow();
      expect(await readFile(fixture.databaseLog, "utf8")).toBe("FAILED\n");
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  test("records a fenced FAILED result when the bounded restore command fails", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        executeFile(fixture.recorder, [receiptId], {
          env: { ...fixture.environment, FAKE_RESTORE_FAIL: "true" },
        }),
      ).rejects.toThrow();
      expect(await readFile(fixture.databaseLog, "utf8")).toBe("FAILED\n");
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects an empty restored production dataset and records FAILED", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        executeFile(fixture.recorder, [receiptId], {
          env: { ...fixture.environment, FAKE_RESTORE_EMPTY: "true" },
        }),
      ).rejects.toThrow(/non-empty Studio production dataset/u);
      expect(await readFile(fixture.databaseLog, "utf8")).toBe("FAILED\n");
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  test("does not attach a result after the selected receipt version changes", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        executeFile(fixture.recorder, [receiptId], {
          env: { ...fixture.environment, FAKE_FENCE_CHANGED: "true" },
        }),
      ).rejects.toThrow();
      await expect(readFile(fixture.databaseLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects a candidate recorder that does not match the approved digest", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        executeFile(fixture.recorder, [receiptId], {
          env: {
            ...fixture.environment,
            SITUATION_STUDIO_APPROVED_RESTORE_RECORDER_SHA256: "0".repeat(64),
          },
        }),
      ).rejects.toThrow(/explicitly approved candidate digest/u);
      await expect(readFile(fixture.databaseLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });

  test("rejects a current release without its immutable commit marker", async () => {
    const fixture = await createFixture();
    try {
      await rm(path.join(fixture.release, ".release-commit"));
      await expect(
        executeFile(fixture.recorder, [receiptId], {
          env: fixture.environment,
        }),
      ).rejects.toThrow(/current immutable release/u);
      await expect(readFile(fixture.databaseLog, "utf8")).rejects.toThrow();
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });
});
