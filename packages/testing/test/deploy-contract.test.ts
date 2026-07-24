import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const executeFile = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const deployPath = path.join(root, "deploy.sh");
const publicGatePath = path.join(root, "ops/verify-public-gate.sh");
const backupPath = path.join(root, "ops/backup-studio.sh");
const provisionDatabasePath = path.join(
  root,
  "ops/provision-studio-database.sql",
);
const provisionPasswordsPath = path.join(
  root,
  "ops/provision-studio-role-passwords.sql",
);

function position(source: string, fragment: string) {
  const index = source.indexOf(fragment);
  expect(index, `missing deployment fragment: ${fragment}`).toBeGreaterThan(-1);
  return index;
}

describe("production deployment contract", () => {
  test("the launcher is syntactically valid and guards production before SSH", async () => {
    await expect(
      executeFile("bash", ["-n", deployPath]),
    ).resolves.toMatchObject({ stderr: "" });
    const source = await readFile(deployPath, "utf8");
    const firstSsh = position(source, 'ssh "${studio_host}"');
    for (const guard of [
      "SITUATION_STUDIO_APPROVED_COMMIT",
      "git branch --show-current",
      "git diff --quiet",
      "git ls-files --others --exclude-standard",
      "git ls-remote origin refs/heads/main",
      'git archive --format=tar "${studio_commit}"',
      "SITUATION_STUDIO_PUBLIC_ORIGIN",
      "SITUATION_STUDIO_PUBLIC_HOST",
      "SITUATION_STUDIO_PUBLIC_GATE_MODE",
    ])
      expect(position(source, guard)).toBeLessThan(firstSsh);
  });

  test("the launcher uses immutable releases, isolated processes, health checks, and rollback", async () => {
    const source = await readFile(deployPath, "utf8");
    for (const fragment of [
      'test ! -e "${studio_release}"',
      "situation-studio-web",
      "situation-studio-review-worker",
      "situation-studio-publisher",
      "SITUATION_STUDIO_WEB_ENV_FILE",
      "SITUATION_STUDIO_REVIEW_ENV_FILE",
      "SITUATION_STUDIO_PUBLISHER_ENV_FILE",
      "http://127.0.0.1:3015/health/live",
      "http://127.0.0.1:3015/health/ready",
      'ln -sfn "${studio_previous}"',
      "first-deploy-deferred",
      'if [[ -n "${studio_previous}" ]]',
      "ops/verify-public-gate.sh",
    ])
      position(source, fragment);
  });

  test("the public gate is verified as protected, private, and no-store", async () => {
    await expect(
      executeFile("bash", ["-n", publicGatePath]),
    ).resolves.toMatchObject({ stderr: "" });
    const source = await readFile(publicGatePath, "utf8");
    for (const fragment of [
      '"${SITUATION_STUDIO_PUBLIC_ORIGIN}/health/live"',
      'if [[ "${status}" != "403" ]]',
      "cache-control:.*private.*no-store",
    ])
      position(source, fragment);
  });

  test("production backups require checksum-verified encrypted off-site replication", async () => {
    await expect(
      executeFile("bash", ["-n", backupPath]),
    ).resolves.toMatchObject({ stderr: "" });
    const source = await readFile(backupPath, "utf8");
    for (const fragment of [
      "STUDIO_BACKUP_REQUIRE_OFFSITE",
      "STUDIO_BACKUP_OFFSITE_SSH_TARGET",
      "STUDIO_BACKUP_OFFSITE_DIRECTORY",
      "gpg \\\n  --batch",
      'scp -q -- "${backup_final}"',
      'sha256sum "${partial_path}"',
      'sha256sum "${final_path}"',
    ])
      position(source, fragment);
  });

  test("fresh provisioning creates the non-login owner before the database and injects runtime passwords", async () => {
    const databaseSource = await readFile(provisionDatabasePath, "utf8");
    expect(
      position(databaseSource, "CREATE ROLE situation_studio_owner"),
    ).toBeLessThan(
      position(databaseSource, "CREATE DATABASE situation_studio"),
    );
    expect(databaseSource).toContain("NOLOGIN NOSUPERUSER");
    const passwordSource = await readFile(provisionPasswordsPath, "utf8");
    for (const role of [
      "situation_studio_web",
      "situation_studio_review_worker",
      "situation_studio_publisher",
      "situation_studio_backup_inspector",
      "situation_studio_backup_operator",
    ])
      expect(passwordSource).toContain(`ALTER ROLE ${role} PASSWORD`);
  });
});
