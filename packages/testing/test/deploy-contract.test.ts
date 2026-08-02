import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
const processBackupQueuePath = path.join(root, "ops/process-backup-queue.sh");
const attestLegacyBackupPath = path.join(
  root,
  "ops/attest-legacy-offsite-backup.sh",
);
const publicationBackupStatePath = path.join(
  root,
  "ops/publication-backup-state.sql",
);
const backupReadinessModeVerifierPath = path.join(
  root,
  "ops/verify-backup-readiness-mode.sh",
);
const backupDatabaseIdentityVerifierPath = path.join(
  root,
  "ops/verify-studio-backup-database-identity.sh",
);
const backupEnvironmentReaderPath = path.join(
  root,
  "ops/read-studio-backup-environment.sh",
);
const previousReleaseDecoderPath = path.join(
  root,
  "ops/decode-studio-previous-release.sh",
);
const bufferedRemoteRunnerPath = path.join(
  root,
  "ops/run-buffered-remote-script.sh",
);
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
const activeReviewStatePath = path.join(root, "ops/active-review-state.sql");
const expectedReviewLaneStatePath = path.join(
  root,
  "ops/expected-review-lane-state.sql",
);
const reviewLaneStatePath = path.join(root, "ops/review-lane-state.sql");
const publicationDrainStatePath = path.join(
  root,
  "ops/publication-drain-state.sql",
);
const leadershipCapabilitiesVerifierPath = path.join(
  root,
  "ops/verify-leadership-runtime-capabilities.mjs",
);

function position(source: string, fragment: string) {
  const index = source.indexOf(fragment);
  expect(index, `missing deployment fragment: ${fragment}`).toBeGreaterThan(-1);
  return index;
}

function currentReadinessVerifier(source: string) {
  const marker = 'READINESS_JSON="${readiness_json}" node -e \'\n';
  const start = position(source, marker) + marker.length;
  const end = source.indexOf("\n'\nfi\nREMOTE", start);
  expect(end, "missing current-readiness verifier terminator").toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

function backupReceiptParser(source: string) {
  const marker = "parsed=\"$(\n  node -e '\n";
  const start = position(source, marker) + marker.length;
  const end = source.indexOf('\n  \' <<<"${receipt}"', start);
  expect(end, "missing backup-receipt parser terminator").toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

function executeWithInput(file: string, args: string[], input: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`command exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

describe("production deployment contract", () => {
  test("the remote runner consumes the complete program before executing it", async () => {
    await expect(
      executeFile("bash", ["-n", bufferedRemoteRunnerPath]),
    ).resolves.toMatchObject({ stderr: "" });
    expect(await readFile(bufferedRemoteRunnerPath, "utf8")).toContain(
      'exec /bin/bash -c "${remote_script}" -- "$@" </dev/null',
    );
    const result = await executeWithInput(
      "bash",
      [bufferedRemoteRunnerPath, "first", "second"],
      `set -euo pipefail
test "\${1}" = first
test "\${2}" = second
test -z "$(cat)"
printf 'buffered:%s:%s\\n' "\${1}" "\${2}"
`,
    );
    expect(result).toEqual({
      stdout: "buffered:first:second\n",
      stderr: "",
    });

    const trapped = await executeFile("bash", [
      "-c",
      `set +e
/bin/bash "\${1}" first <<'PAYLOAD'
set -euo pipefail
trap 'printf "trap:%s\\n" "\${1}"' EXIT
exit 37
PAYLOAD
status="\${?}"
printf 'status:%s\\n' "\${status}"
`,
      "buffered-runner-test",
      bufferedRemoteRunnerPath,
    ]);
    expect(trapped).toMatchObject({
      stdout: "trap:first\nstatus:37\n",
      stderr: "",
    });
    await expect(
      executeWithInput("bash", [bufferedRemoteRunnerPath], "  \n\t\n"),
    ).rejects.toThrow("The buffered remote script is empty.");
  });

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
      "SITUATION_STUDIO_WEB_USER",
      "SITUATION_STUDIO_REVIEW_USER",
      "SITUATION_STUDIO_PUBLISHER_USER",
      "LEADERSHIP_RUNTIME_CAPABILITIES_URL",
      "ops/verify-leadership-runtime-capabilities.mjs",
      "ops/run-buffered-remote-script.sh",
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
      "affected-route-proof-json-v1",
      "ef9a723608977b3f9ea3c25bd1a7cd5f323871854937c0e462a21ca057ee9f7f",
      "5a0b47948760e9134eaac1727bc658de56c87e52bcc9e03db424bb80ea2d4c95",
    ])
      position(verifier, fragment);
  });

  test("production preflight fails closed without complete backup and restore evidence", async () => {
    const [source, backupPolicy, databaseIdentityVerifier] = await Promise.all([
      readFile(deployPath, "utf8"),
      readFile(publicationBackupStatePath, "utf8"),
      readFile(backupDatabaseIdentityVerifierPath, "utf8"),
    ]);
    const preflightOnly = position(
      source,
      'if [[ "${SITUATION_STUDIO_PREFLIGHT_ONLY:-}" == "1" ]]',
    );
    const releaseCreation = position(source, 'test ! -e "${studio_release}"');
    for (const fragment of [
      "SITUATION_STUDIO_BACKUP_USER",
      'backup_environment="${studio_root}/shared/backup.env"',
      'test "$(stat -c \'%U\' "${backup_environment}")" = "${backup_user}"',
      'backup_path="${backup_home}/.local/bin:${PATH}"',
      "STUDIO_BACKUP_DATABASE_URL",
      "STUDIO_BACKUP_QUEUE_DATABASE_URL",
      "backup_database_identity_verifier_base64",
      "BACKUP_DATABASE_IDENTITY_VERIFIER_BASE64",
      "backup_environment_reader_base64",
      "BACKUP_ENVIRONMENT_READER_BASE64",
      "STUDIO_BACKUP_GPG_RECIPIENT",
      '[[ "${STUDIO_BACKUP_REQUIRE_OFFSITE:-}" != "true" ]]',
      "STUDIO_BACKUP_OFFSITE_SSH_TARGET",
      "STUDIO_BACKUP_OFFSITE_DIRECTORY",
      "Production backup tooling is missing ${required_backup_command}.",
      "The configured backup encryption recipient is unavailable to the backup operator.",
      "The backup operator cannot decrypt the configured recipient for restore drills.",
      '"${STUDIO_BACKUP_DESTINATION}" == */',
      '"${STUDIO_BACKUP_OFFSITE_DIRECTORY}" == */',
      '"${STUDIO_BACKUP_OFFSITE_SSH_TARGET}" == -*',
      '"$(stat -c \'%a\' "${STUDIO_BACKUP_DESTINATION}")" != "700"',
      "systemctl is-active --quiet cron",
      'sudo -n crontab -u "${backup_user}" -l',
      'test -x "${studio_root}/current/ops/${backup_command}"',
      "start-isolated-process.sh backup-queue",
      "start-isolated-process.sh backup-nightly",
      "ops/publication-backup-state.sql",
      "BACKUP_POLICY_SQL_BASE64=${backup_policy_sql_base64}",
      "backup_mode_verifier_base64",
      "EXPECTED_BACKUP_READINESS_MODE=${expected_backup_readiness_mode}",
      "Production backup evidence is not publication-ready",
      "The latest backup receipt is not bound to the configured off-site destination.",
      "The configured off-site backup no longer matches its verified receipt.",
      'sha256sum "${offsite_final}"',
      "http://127.0.0.1:3015/health/ready",
      'process.env.READINESS_HTTP_STATUS === "200"',
      'readiness?.status === "ready"',
    ]) {
      const guard = position(source, fragment);
      expect(guard).toBeLessThan(preflightOnly);
      expect(guard).toBeLessThan(releaseCreation);
    }
    for (const fragment of [
      "BEGIN TRANSACTION READ ONLY",
      "offsite-verified:[a-f0-9]{64}",
      "BACKUP_INCOMPLETE",
      "BACKUP_TIMESTAMP_INVALID",
      "interval '26 hours'",
      "RESTORE_DRILL_TIMESTAMP_INVALID",
      "restore_drill.restore_drill_result IS DISTINCT FROM 'PASSED'",
      "backup.id",
      "restore_drill.id AS restore_drill_receipt_id",
      "'READY'",
    ])
      position(backupPolicy, fragment);
    for (const fragment of [
      'database !== "situation_studio"',
      "same normalized database host, port, and database",
    ])
      position(databaseIdentityVerifier, fragment);
  });

  test("the protected backup environment cannot exit early or override candidate controls", async () => {
    await expect(
      executeFile("bash", ["-n", backupEnvironmentReaderPath]),
    ).resolves.toMatchObject({ stderr: "" });
    const fixtureDirectory = await mkdtemp(
      path.join(os.tmpdir(), "studio-backup-environment-"),
    );
    const backupEnvironment = path.join(fixtureDirectory, "backup.env");
    const runReader = () =>
      executeFile("bash", [backupEnvironmentReaderPath], {
        env: {
          ...process.env,
          BACKUP_ENVIRONMENT: backupEnvironment,
        },
      });
    try {
      await writeFile(
        backupEnvironment,
        [
          "STUDIO_BACKUP_DATABASE_URL='postgresql://reader" +
            ":secret@db.example/situation_studio'",
          "STUDIO_BACKUP_QUEUE_DATABASE_URL='postgresql://operator" +
            ":secret@db.example/situation_studio'",
          "STUDIO_BACKUP_DESTINATION='/srv/studio-backups'",
          "STUDIO_BACKUP_GPG_RECIPIENT='backup@example.invalid'",
          "STUDIO_BACKUP_REQUIRE_OFFSITE='true'",
          "STUDIO_BACKUP_OFFSITE_SSH_TARGET='backup@example'",
          "STUDIO_BACKUP_OFFSITE_DIRECTORY='/srv/offsite'",
          "BACKUP_DATABASE_IDENTITY_VERIFIER_BASE64='untrusted-override'",
          "",
        ].join("\n"),
      );
      const loaded = await runReader();
      const settingNames = loaded.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("\t", 1)[0]);
      expect(settingNames).toEqual([
        "STUDIO_BACKUP_DATABASE_URL",
        "STUDIO_BACKUP_QUEUE_DATABASE_URL",
        "STUDIO_BACKUP_DESTINATION",
        "STUDIO_BACKUP_GPG_RECIPIENT",
        "STUDIO_BACKUP_REQUIRE_OFFSITE",
        "STUDIO_BACKUP_OFFSITE_SSH_TARGET",
        "STUDIO_BACKUP_OFFSITE_DIRECTORY",
      ]);
      expect(loaded.stdout).not.toContain(
        "BACKUP_DATABASE_IDENTITY_VERIFIER_BASE64",
      );

      await writeFile(
        backupEnvironment,
        "STUDIO_BACKUP_DATABASE_URL='ignored'\nexit 0\n",
      );
      await expect(runReader()).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "The protected backup environment did not load completely.",
        ),
      });
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  test("the backup gate applies to an existing release while the first release stays publication locked", async () => {
    const source = await readFile(deployPath, "utf8");
    const currentReleaseProbe = position(
      source,
      'if [[ -L "${studio_root}/current" ]]',
    );
    const existingReleaseGate = position(
      source,
      'if [[ "${has_current_release}" == "true" ]]; then',
    );
    const backupUserCheck = position(source, 'id "${backup_user}" >/dev/null');

    expect(position(source, 'public_gate_mode="${13}"')).toBeLessThan(
      currentReleaseProbe,
    );
    expect(currentReleaseProbe).toBeLessThan(existingReleaseGate);
    expect(existingReleaseGate).toBeLessThan(backupUserCheck);
    for (const fragment of [
      "The current Studio release pointer is dangling.",
      "The current Studio release path exists but is not a symlink.",
      "The current Studio pointer does not identify an immutable recorded release.",
      "Studio release history exists without a current pointer; recovery is required.",
      "First-deploy deferral is forbidden when a current Studio release exists.",
      "A first Studio release must use the publication-locked first-deploy-deferred mode.",
      "The current Studio release disappeared after preflight; refusing an unprotected cutover.",
      "The current Studio release changed to an unsafe or unrecorded path after preflight.",
      "The current Studio release changed after preflight.",
      "A Studio current pointer appeared after first-release preflight.",
      'studio_previous_argument="${studio_previous:-NO_PREVIOUS_STUDIO_RELEASE}"',
      "ops/decode-studio-previous-release.sh",
    ])
      position(source, fragment);
  });

  test("the remote cutover decodes an explicit nonempty first-release sentinel", async () => {
    const source = await readFile(deployPath, "utf8");
    await expect(
      executeFile("bash", ["-n", previousReleaseDecoderPath]),
    ).resolves.toMatchObject({ stderr: "" });
    const sentinel = "NO_PREVIOUS_STUDIO_RELEASE";
    await expect(
      executeFile("bash", [
        previousReleaseDecoderPath,
        "/srv/situation-studio",
        sentinel,
      ]),
    ).resolves.toMatchObject({ stdout: "" });
    await expect(
      executeFile("bash", [
        previousReleaseDecoderPath,
        "/srv/situation-studio",
        "/srv/situation-studio/releases/20260801T211500Z",
      ]),
    ).resolves.toMatchObject({
      stdout: "/srv/situation-studio/releases/20260801T211500Z\n",
    });
    await expect(
      executeFile("bash", [
        previousReleaseDecoderPath,
        "/srv/situation-studio",
        "/srv/situation-studio/releases/release;touch-bad",
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "not a direct immutable timestamp release",
      ),
    });
    expect(
      position(
        source,
        'studio_previous_argument="${studio_previous:-NO_PREVIOUS_STUDIO_RELEASE}"',
      ),
    ).toBeLessThan(position(source, '"${studio_previous_argument}"'));
    position(source, "ops/decode-studio-previous-release.sh");
  });

  test("first and follow-up deployments require their explicit web backup modes", async () => {
    const [source, verifier] = await Promise.all([
      readFile(deployPath, "utf8"),
      readFile(backupReadinessModeVerifierPath, "utf8"),
    ]);
    await expect(
      executeFile("bash", ["-n", backupReadinessModeVerifierPath]),
    ).resolves.toMatchObject({ stderr: "" });

    const verifierInvocation = position(
      source,
      '"EXPECTED_BACKUP_READINESS_MODE=${expected_backup_readiness_mode}"',
    );
    expect(
      position(source, 'expected_backup_readiness_mode="required"'),
    ).toBeLessThan(verifierInvocation);
    expect(
      position(source, 'expected_backup_readiness_mode="deferred"'),
    ).toBeLessThan(verifierInvocation);
    expect(verifierInvocation).toBeLessThan(
      position(source, 'id "${backup_user}" >/dev/null'),
    );
    for (const fragment of [
      "Follow-up deployment requires backup readiness mode required in web.env.",
      "First deployment requires backup readiness mode deferred in web.env.",
      'case "${expected_mode}" in',
    ])
      position(verifier, fragment);

    const fixtureDirectory = await mkdtemp(
      path.join(os.tmpdir(), "studio-backup-mode-"),
    );
    const webEnvironment = path.join(fixtureDirectory, "web.env");
    const runVerifier = (expectedMode: string) =>
      executeFile("bash", [backupReadinessModeVerifierPath], {
        env: {
          ...process.env,
          WEB_ENVIRONMENT: webEnvironment,
          EXPECTED_BACKUP_READINESS_MODE: expectedMode,
        },
      });
    try {
      await writeFile(
        webEnvironment,
        "SITUATION_STUDIO_BACKUP_READINESS_MODE=deferred\n",
      );
      await expect(runVerifier("deferred")).resolves.toMatchObject({
        stderr: "",
      });
      await expect(runVerifier("required")).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Follow-up deployment requires backup readiness mode required",
        ),
      });

      await writeFile(
        webEnvironment,
        "SITUATION_STUDIO_BACKUP_READINESS_MODE=required\n",
      );
      await expect(runVerifier("required")).resolves.toMatchObject({
        stderr: "",
      });
      await expect(runVerifier("deferred")).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "First deployment requires backup readiness mode deferred",
        ),
      });
      await expect(runVerifier("unexpected")).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Expected backup readiness mode must be required or deferred.",
        ),
      });

      await writeFile(
        webEnvironment,
        [
          "EXPECTED_BACKUP_READINESS_MODE=deferred",
          "SITUATION_STUDIO_BACKUP_READINESS_MODE=deferred",
          "",
        ].join("\n"),
      );
      await expect(runVerifier("required")).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Follow-up deployment requires backup readiness mode required",
        ),
      });
      await writeFile(
        webEnvironment,
        "SITUATION_STUDIO_BACKUP_READINESS_MODE=required\nexit 0\n",
      );
      await expect(runVerifier("required")).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "Follow-up deployment requires backup readiness mode required",
        ),
      });
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  test("the current-service probe remains compatible with a deferred legacy release", async () => {
    const source = await readFile(deployPath, "utf8");
    const verifier = currentReadinessVerifier(source);
    const valid = {
      status: "ready",
      backup: { state: "deferred" },
    };
    const runVerifier = (httpStatus: string, value: unknown) =>
      executeFile("node", ["-e", verifier], {
        env: {
          ...process.env,
          READINESS_HTTP_STATUS: httpStatus,
          READINESS_JSON:
            typeof value === "string" ? value : JSON.stringify(value),
        },
      });

    await expect(runVerifier("200", valid)).resolves.toMatchObject({
      stderr: "",
    });
    for (const [httpStatus, value] of [
      ["503", valid],
      ["200", { ...valid, status: "degraded" }],
    ] as const) {
      await expect(runVerifier(httpStatus, value)).rejects.toMatchObject({
        stderr: expect.stringContaining(
          "The current Studio service is not ready for deployment.",
        ),
      });
    }
    await expect(runVerifier("200", "not-json")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Studio readiness did not return valid JSON.",
      ),
    });
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
      'if [[ -z "${studio_previous}" ]]',
      "ops/verify-public-gate.sh",
      "ops/apply-studio-release-schema.sh",
      "ops/active-review-state.sql",
      "ops/publication-drain-state.sql",
      "active-review-state-continuity-v2",
      "expected-review-lane-state.sql",
      "review-lane-state.sql",
      "laneMatched",
      "verify_local_health",
      "rollback_to_previous_release",
      "Previous Studio release restored and locally verified",
      ".release-commit",
    ])
      position(source, fragment);
    expect(
      position(source, '"${pm2_bin}" stop "${process_name}"'),
    ).toBeLessThan(position(source, "publication_drain_state()"));
    expect(position(source, '<<<"$(publication_drain_state)"')).toBeLessThan(
      position(source, "situation-studio-publisher </dev/null >/dev/null"),
    );
    expect(position(source, "if ((unfinished_attempts > 0))")).toBeLessThan(
      position(source, "if ((recovery_required > 0))"),
    );
    expect(position(source, "if ((recovery_required > 0))")).toBeLessThan(
      position(source, "if ((active_publications == 0))"),
    );
    expect(
      position(source, "situation-studio-publisher </dev/null >/dev/null"),
    ).toBeLessThan(position(source, "capture_active_review_state"));
    expect(position(source, "capture_active_review_state")).toBeLessThan(
      position(
        source,
        'bash "${studio_release}/ops/apply-studio-release-schema.sh"',
      ),
    );
    expect(position(source, "review_state_before_hash")).toBeLessThan(
      position(source, "review_state_after_hash"),
    );
    expect(position(source, "review_state_after_hash")).toBeLessThan(
      position(source, 'start_release "${studio_release}"'),
    );
    expect(position(source, "expected_review_lane_state_hash")).toBeLessThan(
      position(source, "review_lane_state_after_hash"),
    );
    expect(source.lastIndexOf("rollback_to_previous_release")).toBeGreaterThan(
      position(source, "ops/verify-public-gate.sh"),
    );
    const logicalCommands = source.replace(/\\\n[\t ]*/gu, " ").split("\n");
    const processManagerCommands = logicalCommands.filter((command) =>
      command.includes('"${pm2_bin}"'),
    );
    expect(processManagerCommands).toHaveLength(12);
    for (const command of processManagerCommands)
      expect(command).toContain("</dev/null");
    const interactiveDatabaseCommands = logicalCommands.filter((command) =>
      command.includes("docker exec -i postgres16 psql"),
    );
    expect(interactiveDatabaseCommands).toHaveLength(7);
    for (const command of interactiveDatabaseCommands)
      expect(command).toMatch(/\s<<?/u);
    const databaseClockCommand = logicalCommands.find((command) =>
      command.includes("SELECT clock_timestamp()::text"),
    );
    expect(databaseClockCommand).toContain("docker exec postgres16 psql");
    expect(databaseClockCommand).not.toContain("docker exec -i");
  });

  test("stateful cutover retains the deployment lease until success or verified rollback", async () => {
    const source = await readFile(deployPath, "utf8");
    const cutoverHeading = position(
      source,
      'echo "[5-6/8] Quiescing Studio, preserving review state, applying additive migrations, and cutting over"',
    );
    const releaseUnsafe = source.indexOf(
      "deployment_lease_release_safe=false",
      cutoverHeading,
    );
    const cutoverSsh = source.indexOf(
      '"${studio_release}/${buffered_remote_runner_path}"',
      releaseUnsafe,
    );
    const cutoverStatus = source.indexOf('cutover_status="${?}"', cutoverSsh);
    const ambiguousCutover = source.indexOf(
      "if ((cutover_status != 0)); then",
      cutoverStatus,
    );
    const localGate = source.indexOf('echo "[7/8]', ambiguousCutover);
    expect(releaseUnsafe).toBeGreaterThan(cutoverHeading);
    expect(releaseUnsafe).toBeLessThan(cutoverSsh);
    expect(cutoverSsh).toBeLessThan(cutoverStatus);
    expect(cutoverStatus).toBeLessThan(ambiguousCutover);
    expect(ambiguousCutover).toBeLessThan(localGate);
    expect(source).toContain(
      '"${pm2_bin}" startup systemd -u root --hp /root \\\n  </dev/null \\\n  >/dev/null',
    );

    const ambiguousBlock = source.slice(ambiguousCutover, localGate);
    expect(ambiguousBlock).toContain(
      "No competing rollback was started because the remote command may still be running",
    );
    expect(ambiguousBlock).not.toContain("rollback_to_previous_release");
    expect(source).toContain('"${deployment_lease_release_safe}" != "true"');
    expect(source).toContain(
      "the token-fenced deployment lease was deliberately retained",
    );
    expect(source.match(/deployment_lease_release_safe=true/gu)).toHaveLength(
      4,
    );
  });

  test("the quiesced backup receives the exact preflight configuration fence", async () => {
    const source = await readFile(deployPath, "utf8");
    const runner = position(
      source,
      '/bin/bash "${studio_release}/ops/run-deployment-backup.sh"',
    );
    const configurationArgument = source.indexOf(
      '"${backup_offsite_configuration_id}"',
      runner,
    );
    const evidenceComparison = source.indexOf(
      '"${backup_offsite_configuration_id}" != "${observed_backup_offsite_configuration_id}"',
      configurationArgument,
    );
    expect(configurationArgument).toBeGreaterThan(runner);
    expect(configurationArgument).toBeLessThan(evidenceComparison);
  });

  test("the publication drain includes attempts whose job already became terminal", async () => {
    const source = await readFile(publicationDrainStatePath, "utf8");
    for (const fragment of [
      "BEGIN TRANSACTION READ ONLY",
      "REQUESTED",
      "ASSEMBLING",
      "PROMOTING",
      "VERIFYING",
      "RECOVERY_REQUIRED",
      "publication_attempts",
      "attempt.finished_at IS NULL",
    ])
      position(source, fragment);
  });

  test("the quiesced migration continuity snapshot covers resumable review state without content bodies", async () => {
    const [source, expectedLane, actualLane] = await Promise.all([
      readFile(activeReviewStatePath, "utf8"),
      readFile(expectedReviewLaneStatePath, "utf8"),
      readFile(reviewLaneStatePath, "utf8"),
    ]);
    for (const fragment of [
      "BEGIN TRANSACTION READ ONLY",
      "situation_checkouts",
      "draft_revisions",
      "draft_revision_artifacts",
      "review_jobs",
      "review_steps",
      "agent_runs",
      "review_proposals",
      "agent_candidate_revisions",
      "proposal_changes",
      "bundle_hash",
      "output_hash",
      "proposal_hash",
      "candidate_hash",
      "applied_revision_id",
    ])
      position(source, fragment);
    expect(source).not.toMatch(/text_body|body\s*,|summary|rationale/iu);
    for (const fragment of [
      "REVIEW_QUEUED",
      "min(event.occurred_at)",
      "COALESCE(original.occurred_at, job.queued_at)",
      "job.started_at NULLS LAST, job.queued_at, job.id",
      "laneOwnerId",
    ])
      position(expectedLane, fragment);
    for (const fragment of ["job.queued_at", "job.lane_owner", "laneOwnerId"])
      position(actualLane, fragment);
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
      Promise.all([
        executeFile("bash", ["-n", backupPath]),
        executeFile("bash", ["-n", processBackupQueuePath]),
        executeFile("bash", ["-n", attestLegacyBackupPath]),
        executeFile("bash", ["-n", backupDatabaseIdentityVerifierPath]),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
      expect.objectContaining({ stderr: "" }),
    ]);
    const [source, queueSource] = await Promise.all([
      readFile(backupPath, "utf8"),
      readFile(processBackupQueuePath, "utf8"),
    ]);
    for (const fragment of [
      "STUDIO_BACKUP_REQUIRE_OFFSITE",
      "STUDIO_BACKUP_OFFSITE_SSH_TARGET",
      "STUDIO_BACKUP_OFFSITE_DIRECTORY",
      '"${offsite_directory}" == */',
      "gpg \\\n  --batch",
      "scp -q -o BatchMode=yes -o ConnectTimeout=15 --",
      "ssh -o BatchMode=yes -o ConnectTimeout=15 --",
      'sha256sum "${partial_path}"',
      'sha256sum "${final_path}"',
    ])
      position(source, fragment);
    for (const fragment of [
      "value.offsite",
      'destinationId = "local-only"',
      "offsite-verified:",
      "destination_id = :'destination_id'",
    ])
      position(queueSource, fragment);

    const parser = backupReceiptParser(queueSource);
    const runParser = (offsite: string) =>
      executeWithInput(
        "node",
        ["-e", parser],
        JSON.stringify({
          objectKey: "situation-studio-test.dump.gpg",
          checksum: "a".repeat(64),
          byteLength: 4_096,
          encrypted: true,
          offsite,
        }),
      );
    await expect(runParser("")).resolves.toMatchObject({
      stdout: expect.stringMatching(/\tlocal-only$/u),
    });
    const offsite = "backup@example:/srv/situation-studio/test.dump.gpg";
    const offsiteDigest = createHash("sha256").update(offsite).digest("hex");
    await expect(runParser(offsite)).resolves.toMatchObject({
      stdout: expect.stringMatching(
        new RegExp(`\\toffsite-verified:${offsiteDigest}$`, "u"),
      ),
    });

    const legacyAttestation = await readFile(attestLegacyBackupPath, "utf8");
    for (const fragment of [
      "configured-encrypted-backup",
      "nightly-encrypted-backup",
      "current_timestamp - interval '26 hours'",
      'sha256sum "${offsite_final}"',
      "pg_advisory_xact_lock",
      "FOR SHARE",
      "INSERT INTO backup_receipts",
      "sourceReceiptId",
      "attestedReceiptId",
    ])
      position(legacyAttestation, fragment);
    await expect(
      executeFile("bash", [attestLegacyBackupPath], {
        env: {
          ...process.env,
          STUDIO_BACKUP_QUEUE_DATABASE_URL:
            "postgresql://unused" + ":unused@localhost/unused",
          STUDIO_BACKUP_REQUIRE_OFFSITE: "true",
          STUDIO_BACKUP_OFFSITE_SSH_TARGET: "backup@example",
          STUDIO_BACKUP_OFFSITE_DIRECTORY: "/srv/offsite/",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "The approved off-site backup directory is not a safe absolute path.",
      ),
    });
    await expect(
      executeFile("bash", [attestLegacyBackupPath], {
        env: {
          ...process.env,
          STUDIO_BACKUP_QUEUE_DATABASE_URL:
            "postgresql://unused" + ":unused@localhost/unused",
          STUDIO_BACKUP_REQUIRE_OFFSITE: "true",
          STUDIO_BACKUP_OFFSITE_SSH_TARGET: "-V",
          STUDIO_BACKUP_OFFSITE_DIRECTORY: "/srv/offsite",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "The approved off-site backup SSH target contains unsupported characters.",
      ),
    });
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
    const [grants, releaseSchema] = await Promise.all([
      readFile(runtimeGrantsPath, "utf8"),
      readFile(releaseSchemaPath, "utf8"),
    ]);
    expect(grants).toContain(
      "GRANT INSERT ON audit_events\n  TO situation_studio_review_worker;",
    );
    expect(grants).not.toContain(
      "GRANT SELECT, INSERT, UPDATE ON audit_events\n  TO situation_studio_review_worker;",
    );
    expect(grants).toContain(
      "scoped_artifact_variants, situation_checkouts\n  TO situation_studio_review_worker;",
    );
    expect(releaseSchema).toContain(
      "'situation_studio_review_worker',\n        'public.situation_checkouts',\n        'SELECT'",
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
