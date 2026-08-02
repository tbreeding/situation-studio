import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { expect, test } from "vitest";

const executeFile = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const migrationsRoot = path.join(root, "packages/db/prisma/migrations");
const targetMigration =
  "20260801173000_focused_review_lane_and_failure_reasons";
const legacyBackupAttestationPath = path.join(
  root,
  "ops/attest-legacy-offsite-backup.sh",
);
const backupQueuePath = path.join(root, "ops/process-backup-queue.sh");
const backupIdentityVerifierPath = path.join(
  root,
  "ops/verify-studio-backup-database-identity.sh",
);

async function runSqlFile(
  databaseUrl: string,
  file: string,
  variables: Record<string, string> = {},
) {
  const argumentsList = [databaseUrl, "-v", "ON_ERROR_STOP=1", "-X", "-qAt"];
  for (const [name, value] of Object.entries(variables))
    argumentsList.push("-v", `${name}=${value}`);
  argumentsList.push("-f", file);
  const result = await executeFile("psql", argumentsList, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function backupPolicyState(output: string) {
  return output.split("|", 1)[0];
}

test("the focused-review migration preserves active state and assigns the expected lane owner", async () => {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("situation_studio")
    .start();
  const databaseUrl = container
    .getConnectionUri()
    .replace(/^postgres:\/\//u, "postgresql://");
  try {
    const directories = (await readdir(migrationsRoot))
      .filter((directory) => directory < targetMigration)
      .sort();
    for (const directory of directories)
      await runSqlFile(
        databaseUrl,
        path.join(migrationsRoot, directory, "migration.sql"),
      );

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO users (
          id, username, display_name, password_hash, updated_at
        ) VALUES (
          '10000000-0000-4000-8000-000000000001',
          'continuity-editor',
          'Continuity editor',
          'not-used',
          now()
        );

        INSERT INTO situations (
          id, slug, title, visibility, fence, updated_at
        ) VALUES
          (
            '20000000-0000-4000-8000-000000000001',
            'continuity-one',
            'Continuity one',
            'PUBLIC',
            1,
            now()
          ),
          (
            '20000000-0000-4000-8000-000000000002',
            'continuity-two',
            'Continuity two',
            'PUBLIC',
            1,
            now()
          );

        INSERT INTO drafts (
          id, situation_id, lineage, state, current_revision_number,
          current_bundle_hash, updated_at
        ) VALUES
          (
            '30000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000001',
            1,
            'ACTIVE',
            1,
            repeat('1', 64),
            now()
          ),
          (
            '30000000-0000-4000-8000-000000000002',
            '20000000-0000-4000-8000-000000000002',
            1,
            'ACTIVE',
            1,
            repeat('2', 64),
            now()
          );

        INSERT INTO draft_revisions (
          id, draft_id, revision, bundle_hash, bundle_manifest,
          contract_version, validation_policy, actor_id
        ) VALUES
          (
            '40000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            1,
            repeat('1', 64),
            '{}'::jsonb,
            '1.0.0',
            'policy-v1',
            '10000000-0000-4000-8000-000000000001'
          ),
          (
            '40000000-0000-4000-8000-000000000002',
            '30000000-0000-4000-8000-000000000002',
            1,
            repeat('2', 64),
            '{}'::jsonb,
            '1.0.0',
            'policy-v1',
            '10000000-0000-4000-8000-000000000001'
          );

        INSERT INTO situation_checkouts (
          id, situation_id, holder_id, draft_id, fence, acquired_at
        ) VALUES
          (
            '50000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            1,
            '2026-01-01T00:00:00Z'
          ),
          (
            '50000000-0000-4000-8000-000000000002',
            '20000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002',
            1,
            '2026-01-01T00:00:00Z'
          );

        INSERT INTO review_jobs (
          id, situation_id, input_revision_id, checkout_id, checkout_fence,
          state, context_hash, contract_version, policy_version,
          queued_at, started_at
        ) VALUES
          (
            '60000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000001',
            '40000000-0000-4000-8000-000000000001',
            '50000000-0000-4000-8000-000000000001',
            1,
            'RUNNING',
            repeat('a', 64),
            '1.0.0',
            'policy-v1',
            '2026-02-01T00:00:00Z',
            '2026-02-02T00:00:00Z'
          ),
          (
            '60000000-0000-4000-8000-000000000002',
            '20000000-0000-4000-8000-000000000002',
            '40000000-0000-4000-8000-000000000002',
            '50000000-0000-4000-8000-000000000002',
            1,
            'QUEUED',
            repeat('b', 64),
            '1.0.0',
            'policy-v1',
            '2026-01-01T00:00:00Z',
            NULL
          );

        INSERT INTO audit_events (
          id, actor_id, action, subject_type, subject_id, payload, occurred_at
        ) VALUES
          (
            '70000000-0000-4000-8000-000000000001',
            '10000000-0000-4000-8000-000000000001',
            'REVIEW_QUEUED',
            'REVIEW_JOB',
            '60000000-0000-4000-8000-000000000001',
            '{}'::jsonb,
            '2026-01-02T00:00:00Z'
          ),
          (
            '70000000-0000-4000-8000-000000000002',
            '10000000-0000-4000-8000-000000000001',
            'REVIEW_QUEUED',
            'REVIEW_JOB',
            '60000000-0000-4000-8000-000000000002',
            '{}'::jsonb,
            '2026-01-03T00:00:00Z'
          );
      `);
    } finally {
      await client.end();
    }

    const stateBefore = await runSqlFile(
      databaseUrl,
      path.join(root, "ops/active-review-state.sql"),
    );
    const expectedLane = await runSqlFile(
      databaseUrl,
      path.join(root, "ops/expected-review-lane-state.sql"),
    );
    await runSqlFile(
      databaseUrl,
      path.join(migrationsRoot, targetMigration, "migration.sql"),
    );
    const stateAfter = await runSqlFile(
      databaseUrl,
      path.join(root, "ops/active-review-state.sql"),
    );
    const actualLane = await runSqlFile(
      databaseUrl,
      path.join(root, "ops/review-lane-state.sql"),
    );

    expect(stateAfter).toBe(stateBefore);
    expect(actualLane).toBe(expectedLane);
    expect(JSON.parse(actualLane)).toMatchObject({
      laneOwnerId: "60000000-0000-4000-8000-000000000001",
      jobs: [
        [
          "60000000-0000-4000-8000-000000000001",
          "2026-01-02T00:00:00+00:00",
          true,
        ],
        [
          "60000000-0000-4000-8000-000000000002",
          "2026-01-03T00:00:00+00:00",
          false,
        ],
      ],
    });

    const publicationClient = new Client({ connectionString: databaseUrl });
    await publicationClient.connect();
    try {
      await publicationClient.query(`
        INSERT INTO publication_jobs (
          id, publication_id, situation_id, target_revision_id,
          checkout_id, checkout_fence, source_kind, state,
          target_bundle_hash, finished_at
        ) VALUES (
          '80000000-0000-4000-8000-000000000001',
          '80000000-0000-4000-8000-000000000002',
          '20000000-0000-4000-8000-000000000001',
          '40000000-0000-4000-8000-000000000001',
          '50000000-0000-4000-8000-000000000001',
          1,
          'MANUAL',
          'FAILED',
          repeat('1', 64),
          now()
        );

        INSERT INTO publication_attempts (
          id, job_id, attempt, started_at
        ) VALUES (
          '90000000-0000-4000-8000-000000000001',
          '80000000-0000-4000-8000-000000000001',
          1,
          now()
        );
      `);

      const drainStatePath = path.join(root, "ops/publication-drain-state.sql");
      expect(await runSqlFile(databaseUrl, drainStatePath)).toBe("0|0|1");

      await publicationClient.query(`
        UPDATE publication_attempts
           SET finished_at = now()
         WHERE id = '90000000-0000-4000-8000-000000000001'
      `);
      expect(await runSqlFile(databaseUrl, drainStatePath)).toBe("0|0|0");

      await publicationClient.query(`
        UPDATE publication_jobs
           SET state = 'RECOVERY_REQUIRED'
         WHERE id = '80000000-0000-4000-8000-000000000001'
      `);
      expect(await runSqlFile(databaseUrl, drainStatePath)).toBe("0|1|0");
    } finally {
      await publicationClient.end();
    }
  } finally {
    await container.stop();
  }
});

test("backup workers transport receipt fences through real psql input", async () => {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("situation_studio")
    .start();
  const databaseUrl = container
    .getConnectionUri()
    .replace(/^postgres:\/\//u, "postgresql://");
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "studio-real-backup-worker-"),
  );
  let client: Client | undefined;
  try {
    const directories = (await readdir(migrationsRoot))
      .filter((entry) => /^\d+_/u.test(entry))
      .sort();
    for (const directory of directories)
      await runSqlFile(
        databaseUrl,
        path.join(migrationsRoot, directory, "migration.sql"),
      );

    const operationsRoot = path.join(temporaryRoot, "ops");
    const fakeBin = path.join(temporaryRoot, "bin");
    const backupDestination = path.join(temporaryRoot, "backups");
    await Promise.all([
      mkdir(operationsRoot, { recursive: true }),
      mkdir(fakeBin, { recursive: true }),
      mkdir(backupDestination, { recursive: true, mode: 0o700 }),
    ]);
    await chmod(backupDestination, 0o700);
    const copiedQueuePath = path.join(
      operationsRoot,
      "process-backup-queue.sh",
    );
    await Promise.all([
      copyFile(backupQueuePath, copiedQueuePath),
      copyFile(
        backupIdentityVerifierPath,
        path.join(operationsRoot, "verify-studio-backup-database-identity.sh"),
      ),
      writeFile(
        path.join(operationsRoot, "backup-studio.sh"),
        "#!/usr/bin/env bash\nexit 42\n",
        "utf8",
      ),
      writeFile(
        path.join(fakeBin, "flock"),
        "#!/usr/bin/env bash\nexit 0\n",
        "utf8",
      ),
      writeFile(
        path.join(fakeBin, "timeout"),
        `#!/usr/bin/env bash
set -euo pipefail
while [[ "\${1:-}" == --* ]]; do shift; done
if [[ "\${#}" -lt 2 ]]; then exit 64; fi
shift
exec "\${@}"
`,
        "utf8",
      ),
    ]);
    await Promise.all([
      chmod(path.join(operationsRoot, "backup-studio.sh"), 0o755),
      chmod(path.join(fakeBin, "flock"), 0o755),
      chmod(path.join(fakeBin, "timeout"), 0o755),
    ]);

    const workerEnvironment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      STUDIO_BACKUP_DATABASE_URL: databaseUrl,
      STUDIO_BACKUP_QUEUE_DATABASE_URL: databaseUrl,
      STUDIO_BACKUP_DESTINATION: backupDestination,
      STUDIO_BACKUP_DATABASE_TIMEOUT_SECONDS: "10",
      STUDIO_BACKUP_OVERALL_TIMEOUT_SECONDS: "1",
      STUDIO_BACKUP_TIMEOUT_KILL_AFTER_SECONDS: "1",
      STUDIO_BACKUP_DEPLOYMENT_LOCK_WAIT_SECONDS: "1",
      STUDIO_BACKUP_DEPLOYMENT_RESTORE_CHECK_TIMEOUT_SECONDS: "1",
      STUDIO_BACKUP_STALE_AFTER_SECONDS: "304",
    };
    client = new Client({ connectionString: databaseUrl });
    await client.connect();

    const preclaimedId = "a1000000-0000-4000-8000-000000000001";
    const preclaimed = await client.query<{ started_at: string }>(
      `INSERT INTO backup_receipts (
         id, state, destination_id, encrypted, started_at, created_at
       ) VALUES (
         $1, 'RUNNING', 'deployment-quiesced', true,
         current_timestamp, current_timestamp
       )
       RETURNING started_at::text`,
      [preclaimedId],
    );
    const preclaimedStartedAt = preclaimed.rows[0]?.started_at;
    if (!preclaimedStartedAt)
      throw new Error("preclaimed receipt did not return a start fence");
    await expect(
      executeFile(
        "bash",
        [copiedQueuePath, "--preclaimed", preclaimedId, preclaimedStartedAt],
        {
          cwd: temporaryRoot,
          env: workerEnvironment,
        },
      ),
    ).rejects.toMatchObject({
      code: 42,
      stderr: expect.stringContaining("Backup command failed with status 42"),
    });
    expect(
      await client.query(
        "SELECT state, failure_code FROM backup_receipts WHERE id = $1",
        [preclaimedId],
      ),
    ).toMatchObject({
      rows: [
        {
          state: "FAILED",
          failure_code: "DEPLOYMENT_BACKUP_FAILED",
        },
      ],
    });

    const staleId = "a1000000-0000-4000-8000-000000000002";
    const queuedId = "a1000000-0000-4000-8000-000000000003";
    await client.query(
      `INSERT INTO backup_receipts (
         id, state, destination_id, encrypted, started_at, created_at
       ) VALUES
         (
           $1, 'RUNNING', 'configured-encrypted-backup', true,
           current_timestamp - interval '10 minutes',
           current_timestamp - interval '10 minutes'
         ),
         (
           $2, 'QUEUED', 'configured-encrypted-backup', true,
           NULL, current_timestamp
         )`,
      [staleId, queuedId],
    );
    await expect(
      executeFile("bash", [copiedQueuePath], {
        cwd: temporaryRoot,
        env: workerEnvironment,
      }),
    ).rejects.toMatchObject({
      code: 42,
      stderr: expect.stringContaining("Backup command failed with status 42"),
    });
    const terminalReceipts = await client.query<{
      id: string;
      state: string;
      failure_code: string | null;
    }>(
      `SELECT id, state, failure_code
         FROM backup_receipts
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[staleId, queuedId]],
    );
    expect(terminalReceipts.rows).toEqual([
      {
        id: staleId,
        state: "FAILED",
        failure_code: "BACKUP_RUNNER_STALE",
      },
      {
        id: queuedId,
        state: "FAILED",
        failure_code: "BACKUP_COMMAND_FAILED",
      },
    ]);
  } finally {
    await client?.end();
    await rm(temporaryRoot, { recursive: true, force: true });
    await container.stop();
  }
});

test("the deployment backup query rejects local-only, stale, and future evidence", async () => {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("situation_studio")
    .start();
  const databaseUrl = container
    .getConnectionUri()
    .replace(/^postgres:\/\//u, "postgresql://");
  const backupPolicyPath = path.join(root, "ops/publication-backup-state.sql");
  try {
    const directories = (await readdir(migrationsRoot))
      .filter((entry) => /^\d+_/u.test(entry))
      .sort();
    for (const directory of directories)
      await runSqlFile(
        databaseUrl,
        path.join(migrationsRoot, directory, "migration.sql"),
      );

    expect(
      backupPolicyState(await runSqlFile(databaseUrl, backupPolicyPath)),
    ).toBe("BACKUP_MISSING");
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const legacyReceiptId = "a0000000-0000-4000-8000-000000000000";
      const legacyObjectKey = "situation-studio-legacy.dump.gpg";
      const legacyChecksum = "9".repeat(64);
      const legacyByteLength = 8_192;
      await client.query(
        `INSERT INTO backup_receipts (
           id, state, destination_id, object_key, checksum, encrypted,
           byte_length, verified_at, restore_drill_at, restore_drill_result
         ) VALUES (
           $1, 'VERIFIED', 'configured-encrypted-backup', $2, $3, true,
           $4, now(), now(), 'PASSED'
         )`,
        [legacyReceiptId, legacyObjectKey, legacyChecksum, legacyByteLength],
      );
      const fakeBin = await mkdtemp(
        path.join(os.tmpdir(), "studio-backup-attestation-"),
      );
      try {
        const fakeSsh = path.join(fakeBin, "ssh");
        const fakeTimeout = path.join(fakeBin, "timeout");
        await writeFile(
          fakeTimeout,
          `#!/usr/bin/env bash
set -euo pipefail
while [[ "\${1:-}" == --* ]]; do shift; done
shift
exec "\${@}"
`,
          "utf8",
        );
        await writeFile(
          fakeSsh,
          `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' "\${FAKE_OFFSITE_CHECKSUM}" "\${FAKE_OFFSITE_BYTE_LENGTH}"
`,
          "utf8",
        );
        await Promise.all([chmod(fakeSsh, 0o755), chmod(fakeTimeout, 0o755)]);
        const attestationEnvironment = {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          STUDIO_BACKUP_QUEUE_DATABASE_URL: databaseUrl,
          STUDIO_BACKUP_REQUIRE_OFFSITE: "true",
          STUDIO_BACKUP_OFFSITE_SSH_TARGET: "backup@example",
          STUDIO_BACKUP_OFFSITE_DIRECTORY: "/srv/offsite",
          FAKE_OFFSITE_CHECKSUM: legacyChecksum,
          FAKE_OFFSITE_BYTE_LENGTH: String(legacyByteLength),
        };
        const firstAttestation = await executeFile(
          "bash",
          [legacyBackupAttestationPath],
          { env: attestationEnvironment },
        );
        const firstEvidence = JSON.parse(firstAttestation.stdout) as {
          sourceReceiptId: string;
          attestedReceiptId: string;
          destinationId: string;
        };
        const expectedDestinationId = `offsite-verified:${createHash("sha256")
          .update(`backup@example:/srv/offsite/${legacyObjectKey}`)
          .digest("hex")}`;
        expect(firstEvidence).toMatchObject({
          sourceReceiptId: legacyReceiptId,
          destinationId: expectedDestinationId,
        });
        expect(firstEvidence.attestedReceiptId).not.toBe(legacyReceiptId);

        const receipts = await client.query<{
          id: string;
          destination_id: string;
          verified_at: Date;
          restore_drill_at: Date | null;
          restore_drill_result: string | null;
        }>(
          `SELECT id, destination_id, verified_at,
                  restore_drill_at, restore_drill_result
             FROM backup_receipts
            WHERE object_key = $1
            ORDER BY created_at`,
          [legacyObjectKey],
        );
        expect(receipts.rows).toHaveLength(2);
        expect(receipts.rows[0]?.destination_id).toBe(
          "configured-encrypted-backup",
        );
        expect(receipts.rows[1]).toMatchObject({
          id: firstEvidence.attestedReceiptId,
          destination_id: expectedDestinationId,
          verified_at: receipts.rows[0]?.verified_at,
          restore_drill_at: null,
          restore_drill_result: null,
        });

        const repeatedAttestation = await executeFile(
          "bash",
          [legacyBackupAttestationPath],
          { env: attestationEnvironment },
        );
        expect(JSON.parse(repeatedAttestation.stdout)).toMatchObject({
          sourceReceiptId: firstEvidence.attestedReceiptId,
          attestedReceiptId: firstEvidence.attestedReceiptId,
          destinationId: expectedDestinationId,
        });
        expect(
          await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM backup_receipts
              WHERE object_key = $1`,
            [legacyObjectKey],
          ),
        ).toMatchObject({ rows: [{ count: "2" }] });
      } finally {
        await rm(fakeBin, { recursive: true, force: true });
      }
      await client.query("DELETE FROM backup_receipts");

      await client.query(`
        INSERT INTO backup_receipts (
          id, state, destination_id, object_key, checksum, encrypted,
          byte_length, verified_at
        ) VALUES (
          'a0000000-0000-4000-8000-000000000001',
          'VERIFIED',
          'local-only',
          'situation-studio-test.dump.gpg',
          repeat('a', 64),
          true,
          4096,
          now()
        );
      `);
      expect(
        backupPolicyState(await runSqlFile(databaseUrl, backupPolicyPath)),
      ).toBe("BACKUP_INCOMPLETE");

      await client.query(`
        UPDATE backup_receipts
           SET destination_id = 'offsite-verified:' || repeat('f', 64),
               verified_at = now() + interval '6 minutes',
               restore_drill_at = now(),
               restore_drill_result = 'PASSED'
         WHERE id = 'a0000000-0000-4000-8000-000000000001';
      `);
      expect(
        backupPolicyState(await runSqlFile(databaseUrl, backupPolicyPath)),
      ).toBe("BACKUP_TIMESTAMP_INVALID");

      await client.query(`
        UPDATE backup_receipts
           SET verified_at = now() - interval '27 hours'
         WHERE id = 'a0000000-0000-4000-8000-000000000001';
      `);
      expect(
        backupPolicyState(await runSqlFile(databaseUrl, backupPolicyPath)),
      ).toBe("BACKUP_STALE");

      await client.query(`
        UPDATE backup_receipts
           SET verified_at = now(),
               restore_drill_at = NULL,
               restore_drill_result = NULL
         WHERE id = 'a0000000-0000-4000-8000-000000000001';
      `);
      expect(
        backupPolicyState(await runSqlFile(databaseUrl, backupPolicyPath)),
      ).toBe("RESTORE_DRILL_MISSING");

      await client.query(`
        UPDATE backup_receipts
           SET restore_drill_at = now() + interval '6 minutes',
               restore_drill_result = 'PASSED'
         WHERE id = 'a0000000-0000-4000-8000-000000000001';
      `);
      expect(
        backupPolicyState(await runSqlFile(databaseUrl, backupPolicyPath)),
      ).toBe("RESTORE_DRILL_TIMESTAMP_INVALID");

      await client.query(`
        UPDATE backup_receipts
           SET restore_drill_at = now(),
               restore_drill_result = 'FAILED'
         WHERE id = 'a0000000-0000-4000-8000-000000000001';
      `);
      expect(
        backupPolicyState(await runSqlFile(databaseUrl, backupPolicyPath)),
      ).toBe("RESTORE_DRILL_FAILED");

      await client.query(`
        UPDATE backup_receipts
           SET restore_drill_result = 'PASSED'
         WHERE id = 'a0000000-0000-4000-8000-000000000001';
      `);
      const readyEvidence = await runSqlFile(databaseUrl, backupPolicyPath);
      expect(backupPolicyState(readyEvidence)).toBe("READY");
      expect(readyEvidence.split("|")).toHaveLength(7);

      await client.query("DELETE FROM backup_receipts");
      const quiescedAt = new Date(Date.now() - 5_000).toISOString();
      const releaseId = "20260801T200000Z";
      const commit = "c".repeat(40);
      const reviewHash = "d".repeat(64);
      const laneHash = "e".repeat(64);
      const anchorVariables = {
        quiesced_at: quiescedAt,
        release_id: releaseId,
        commit,
        review_hash: reviewHash,
        lane_hash: laneHash,
      };
      const anchorEvidence = await runSqlFile(
        databaseUrl,
        path.join(root, "ops/create-deployment-backup-anchor.sql"),
        anchorVariables,
      );
      const [deploymentReceiptId, receiptStartedAt, receiptCreatedAt] =
        anchorEvidence.split("|");
      expect(deploymentReceiptId).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
      );
      if (!deploymentReceiptId || !receiptStartedAt || !receiptCreatedAt)
        throw new Error("deployment backup anchor evidence is incomplete");
      expect(receiptStartedAt).toBe(receiptCreatedAt);
      const expectedDestinationId = `offsite-verified:${"f".repeat(64)}`;
      const objectKey = `situation-studio-${releaseId}-${deploymentReceiptId}.dump.gpg`;
      await client.query(
        `UPDATE backup_receipts
            SET state = 'VERIFIED',
                destination_id = $2,
                object_key = $3,
                checksum = repeat('a', 64),
                byte_length = 4096,
                verified_at = clock_timestamp(),
                failure_code = NULL
          WHERE id = $1`,
        [deploymentReceiptId, expectedDestinationId, objectKey],
      );
      const gateVariables = {
        ...anchorVariables,
        receipt_id: deploymentReceiptId,
        receipt_started_at: receiptStartedAt,
        receipt_created_at: receiptCreatedAt,
        expected_destination_id: expectedDestinationId,
      };
      const checkpointReady = await runSqlFile(
        databaseUrl,
        path.join(root, "ops/verify-deployment-backup.sql"),
        gateVariables,
      );
      expect(backupPolicyState(checkpointReady)).toBe("READY");
      expect(checkpointReady.split("|")).toHaveLength(9);

      expect(
        backupPolicyState(
          await runSqlFile(
            databaseUrl,
            path.join(root, "ops/verify-deployment-backup.sql"),
            {
              ...gateVariables,
              expected_destination_id: `offsite-verified:${"0".repeat(64)}`,
            },
          ),
        ),
      ).toBe("RECEIPT_INCOMPLETE");

      await client.query(
        `INSERT INTO audit_events (
           id, action, subject_type, subject_id, payload, occurred_at
         ) VALUES (
           gen_random_uuid(), 'DEPLOYMENT_BACKUP_ANCHORED',
           'BACKUP_RECEIPT', $1, '{}'::jsonb, now()
         )`,
        [deploymentReceiptId],
      );
      expect(
        backupPolicyState(
          await runSqlFile(
            databaseUrl,
            path.join(root, "ops/verify-deployment-backup.sql"),
            gateVariables,
          ),
        ),
      ).toBe("ANCHOR_MISMATCH");
    } finally {
      await client.end();
    }
  } finally {
    await container.stop();
  }
});
