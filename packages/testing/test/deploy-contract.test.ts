import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const executeFile = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const deployPath = path.join(root, "deploy.sh");
const publicGatePath = path.join(root, "ops/verify-public-gate.sh");
const codexReviewPath = path.join(root, "ops/run-codex-review.sh");
const installReviewClisPath = path.join(root, "ops/install-review-clis.sh");
const isolatedLauncherPath = path.join(root, "ops/start-isolated-process.sh");
const backupPath = path.join(root, "ops/backup-studio.sh");
const provisionDatabasePath = path.join(
  root,
  "ops/provision-studio-database.sql",
);
const provisionPasswordsPath = path.join(
  root,
  "ops/provision-studio-role-passwords.sql",
);
const runtimeGrantsPath = path.join(root, "ops/grant-runtime-roles.sql");
const releaseSchemaPath = path.join(root, "ops/apply-studio-release-schema.sh");
const leadershipCapabilitiesVerifierPath = path.join(
  root,
  "ops/verify-leadership-runtime-capabilities.mjs",
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
    const firstSsh = position(source, 'ssh "${studio_ssh_target}"');
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
      "SITUATION_STUDIO_DEPLOY_USER",
      "LEADERSHIP_RUNTIME_CAPABILITIES_URL",
      "ops/verify-leadership-runtime-capabilities.mjs",
    ])
      expect(position(source, guard)).toBeLessThan(firstSsh);
  });

  test("the launcher verifies the exact Leadership runtime before contacting production", async () => {
    const [source, verifier] = await Promise.all([
      readFile(deployPath, "utf8"),
      readFile(leadershipCapabilitiesVerifierPath, "utf8"),
    ]);
    const firstSsh = position(source, 'ssh "${studio_ssh_target}"');
    expect(
      position(source, "node ops/verify-leadership-runtime-capabilities.mjs"),
    ).toBeLessThan(firstSsh);
    for (const fragment of [
      "leadership-studio-capabilities-v1",
      "typed-projection-parity-v1",
      "affected-route-proof-v2",
      "6441251640d45ac3b5280a8e586c108e0e678612c13f7421566b342326321aba",
    ])
      position(verifier, fragment);
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
      "ops/apply-studio-release-schema.sh",
      ".release-commit",
    ])
      position(source, fragment);
    expect(
      position(source, "Applying additive Studio migrations"),
    ).toBeLessThan(
      position(source, "Cutting over the three isolated processes"),
    );
  });

  test("release schema application is owner-scoped, fail-closed, and reapplies least-privilege grants", async () => {
    await expect(
      executeFile("bash", ["-n", releaseSchemaPath]),
    ).resolves.toMatchObject({ stderr: "" });
    const source = await readFile(releaseSchemaPath, "utf8");
    for (const fragment of [
      "STUDIO_OWNER_MIGRATION_PASSWORD",
      "ALTER ROLE situation_studio_owner LOGIN PASSWORD",
      "trap disable_owner_login EXIT",
      "nvm use --silent",
      "pnpm db:migrate:deploy",
      "ALTER ROLE situation_studio_owner NOLOGIN",
      "ops/grant-runtime-roles.sql",
      "has_table_privilege",
      "lane_owner",
      "failure_reason_code",
      "failure_phase",
      "failure_stage_ordinal",
      "failure_stage_role",
      "review_jobs_one_lane_owner",
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

  test("subscription review uses a constrained Codex PTY and an isolated service home", async () => {
    await expect(
      Promise.all([
        executeFile("bash", ["-n", codexReviewPath]),
        executeFile("bash", ["-n", installReviewClisPath]),
        executeFile("bash", ["-n", isolatedLauncherPath]),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
    ]);
    const codexSource = await readFile(codexReviewPath, "utf8");
    for (const fragment of [
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "read-only",
      "model_reasoning_effort",
      "shell_environment_policy.inherit",
      "shell_environment_policy.set.PATH",
      "--output-schema",
      "--output-last-message",
      "script -qec",
      "</dev/null",
    ])
      position(codexSource, fragment);
    const launcherSource = await readFile(isolatedLauncherPath, "utf8");
    for (const fragment of [
      'service_home="$(getent passwd "$(id -u)"',
      "stat -c '%a'",
      "stat -c '%u'",
      'HOME="${service_home}"',
      'USER="${service_user}"',
      'LOGNAME="${service_user}"',
    ])
      position(launcherSource, fragment);
    const installerSource = await readFile(installReviewClisPath, "utf8");
    for (const fragment of [
      'codex_version="0.145.0"',
      'claude_version="2.1.218"',
      'codex_integrity="sha512-/PSPSF',
      'claude_integrity="sha512-BHV951',
      'npm view "@openai/codex@${codex_version}" dist.integrity',
      'npm view "@anthropic-ai/claude-code@${claude_version}" dist.integrity',
      '"@openai/codex@${codex_version}"',
      '"@anthropic-ai/claude-code@${claude_version}"',
      '--prefix "${HOME}/.local"',
    ])
      position(installerSource, fragment);
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

  test("the review worker can append system retry audits without broader audit mutation", async () => {
    const grants = await readFile(runtimeGrantsPath, "utf8");
    expect(grants).toContain(
      "GRANT INSERT ON audit_events\n  TO situation_studio_review_worker;",
    );
    expect(grants).not.toContain(
      "GRANT SELECT, INSERT, UPDATE ON audit_events\n  TO situation_studio_review_worker;",
    );
  });

  test("the web runtime can create the initial publication event", async () => {
    const [grants, releaseSchema] = await Promise.all([
      readFile(runtimeGrantsPath, "utf8"),
      readFile(releaseSchemaPath, "utf8"),
    ]);
    expect(grants).toContain(
      "GRANT SELECT, INSERT ON publication_events\n  TO situation_studio_web;",
    );
    expect(releaseSchema).toContain(
      "'situation_studio_web',\n        'public.publication_events',\n        'INSERT'",
    );
  });
});
