import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const executeFile = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const deployPath = path.join(root, "deploy.sh");
const leaseHelperPath = path.join(
  root,
  "ops/manage-studio-deployment-lease.sh",
);
const deploymentBackupRunnerPath = path.join(
  root,
  "ops/run-deployment-backup.sh",
);
const queuePath = path.join(root, "ops/process-backup-queue.sh");
const anchorPath = path.join(root, "ops/create-deployment-backup-anchor.sql");
const backupGatePath = path.join(root, "ops/verify-deployment-backup.sql");
const temporaryRoots: string[] = [];

function position(source: string, fragment: string) {
  const index = source.indexOf(fragment);
  expect(
    index,
    `missing deployment-safety fragment: ${fragment}`,
  ).toBeGreaterThan(-1);
  return index;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("deployment serialization and state backup contract", () => {
  test("the remote lease is atomic, token-fenced, and rejects unsafe parents", async () => {
    await expect(
      executeFile("bash", ["-n", leaseHelperPath]),
    ).resolves.toMatchObject({ stderr: "" });
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "studio-deployment-lease-"),
    );
    temporaryRoots.push(temporaryRoot);
    const studioRoot = path.join(temporaryRoot, "studio");
    const sharedRoot = path.join(studioRoot, "shared");
    await mkdir(sharedRoot, { recursive: true });
    await Promise.all([chmod(studioRoot, 0o755), chmod(sharedRoot, 0o755)]);
    const firstToken = "a".repeat(64);
    const secondToken = "b".repeat(64);
    const commit = "c".repeat(40);

    await expect(
      executeFile(leaseHelperPath, [
        "acquire",
        studioRoot,
        firstToken,
        commit,
        "20260801T120000Z",
      ]),
    ).resolves.toMatchObject({ stderr: "" });
    expect(
      (await stat(path.join(sharedRoot, ".deployment-lease"))).mode & 0o777,
    ).toBe(0o700);
    expect(
      (await stat(path.join(sharedRoot, ".deployment-lease/token"))).mode &
        0o777,
    ).toBe(0o600);
    expect(
      await readFile(
        path.join(sharedRoot, ".deployment-lease/metadata"),
        "utf8",
      ),
    ).toContain(`commit=${commit}`);

    await expect(
      executeFile(leaseHelperPath, [
        "acquire",
        studioRoot,
        secondToken,
        commit,
        "20260801T120001Z",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("deployment lease already exists"),
    });
    await expect(
      executeFile(leaseHelperPath, ["release", studioRoot, secondToken]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("owned by another deployment"),
    });
    await expect(
      executeFile(leaseHelperPath, ["release", studioRoot, firstToken]),
    ).resolves.toMatchObject({ stderr: "" });

    await chmod(sharedRoot, 0o775);
    await expect(
      executeFile(leaseHelperPath, [
        "acquire",
        studioRoot,
        secondToken,
        commit,
        "20260801T120001Z",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("must not be group- or world-writable"),
    });
  });

  test("deploy holds the lease through rollback and gates migration on a post-quiescence backup", async () => {
    const [deploy, leaseHelper, anchor, backupGate, deploymentRunner, queue] =
      await Promise.all([
        readFile(deployPath, "utf8"),
        readFile(leaseHelperPath, "utf8"),
        readFile(anchorPath, "utf8"),
        readFile(backupGatePath, "utf8"),
        readFile(deploymentBackupRunnerPath, "utf8"),
        readFile(queuePath, "utf8"),
      ]);
    await expect(
      Promise.all([
        executeFile("bash", ["-n", deployPath]),
        executeFile("bash", ["-n", deploymentBackupRunnerPath]),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
    ]);

    const acquire = position(deploy, "  acquire \\");
    const preflightMutation = position(
      deploy,
      'install -d -m 0755 "${studio_root}/releases"',
    );
    const releaseCreate = position(deploy, 'test ! -e "${studio_release}"');
    expect(acquire).toBeLessThan(preflightMutation);
    expect(preflightMutation).toBeLessThan(releaseCreate);
    for (const fragment of [
      "trap 'release_deployment_lease \"$?\"' EXIT",
      'release "${studio_root}" "${deployment_lease_token}"',
      "randomBytes(32)",
      "manage-studio-deployment-lease.sh",
      "assert_deployment_lease",
    ])
      position(deploy, fragment);
    position(
      leaseHelper,
      "The Studio deployment lease parent directories must not be group- or world-writable.",
    );

    const publisherStop = position(
      deploy,
      "situation-studio-publisher </dev/null >/dev/null",
    );
    const quiescence = position(deploy, 'deployment_quiesced_at="$(');
    const projection = position(
      deploy,
      'review_state_before="$(capture_active_review_state)"',
    );
    const anchored = position(deploy, "create-deployment-backup-anchor.sql");
    const synchronousBackup = position(deploy, "run-deployment-backup.sh");
    const exactGate = position(deploy, "verify-deployment-backup.sql");
    const projectionRecheck = position(
      deploy,
      "review_state_after_backup_hash",
    );
    const migration = position(
      deploy,
      'bash "${studio_release}/ops/apply-studio-release-schema.sh"',
    );
    expect(publisherStop).toBeLessThan(quiescence);
    expect(quiescence).toBeLessThan(projection);
    expect(projection).toBeLessThan(anchored);
    expect(anchored).toBeLessThan(synchronousBackup);
    expect(synchronousBackup).toBeLessThan(exactGate);
    expect(exactGate).toBeLessThan(projectionRecheck);
    expect(projectionRecheck).toBeLessThan(migration);

    for (const fragment of [
      "'RUNNING'",
      "'deployment-quiesced'",
      "DEPLOYMENT_BACKUP_ANCHORED",
      "reviewStateHash",
      "expectedLaneHash",
      "pg_advisory_xact_lock",
    ])
      position(anchor, fragment);
    for (const fragment of [
      ":'expected_destination_id'",
      "receipt.destination_id IS DISTINCT FROM :'expected_destination_id'",
      "receipt.created_at <= :'quiesced_at'::timestamptz",
      "DEPLOYMENT_BACKUP_ANCHORED",
      "FROM jsonb_object_keys(event.payload)",
      "payload_shape.key_count = 8",
      "deployment-backup-v1",
    ])
      position(backupGate, fragment);
    for (const fragment of [
      "--with-colons --fingerprint",
      "--list-secret-keys",
      "backup_decryption_fingerprint",
      "configured-offsite:",
      "offsite-verified:",
    ])
      position(deploymentRunner, fragment);
    for (const fragment of [
      'runner_mode="preclaimed"',
      "receipt.id = :'receipt_id'::uuid",
      "receipt.destination_id = 'deployment-quiesced'",
      "FOR UPDATE SKIP LOCKED",
      "DEPLOYMENT_BACKUP_FAILED",
      'gpg --batch --quiet --decrypt "${deployment_backup_local}"',
      "pg_restore --list",
      "does not match its exact receipt evidence",
    ])
      position(queue, fragment);
    expect(
      position(
        queue,
        'gpg --batch --quiet --decrypt "${deployment_backup_local}"',
      ),
    ).toBeLessThan(position(queue, "SET state = 'VERIFIED'"));
    expect(position(queue, ">/dev/null; then")).toBeLessThan(
      position(queue, 'deployment_catalog_statuses=("${PIPESTATUS[@]}")'),
    );
    expect(
      position(queue, '"${deployment_catalog_statuses[1]}" != "0"'),
    ).toBeLessThan(position(queue, "SET state = 'VERIFIED'"));
    for (const fragment of [
      "backup_environment_mode",
      "observed_backup_offsite_configuration_id",
      "backup_encryption_fingerprint",
      "STUDIO_DEPLOY_BACKUP_CONFIG",
      '"${deployment_backup_destination_id}" != "${expected_deployment_backup_destination_id}"',
    ])
      position(deploy, fragment);
  });
});
