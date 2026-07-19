import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const studioRoot = path.resolve(import.meta.dirname, "../../..");
const deployPath = path.join(studioRoot, "deploy.sh");
const publisherStartPath = path.join(studioRoot, "ops/start-publisher.sh");
const leadershipStartPath = path.join(
  studioRoot,
  "ops/start-leadership-release.sh",
);
const bootstrapApplyPath = path.join(
  studioRoot,
  "packages/testing/src/backfill-database-bootstrap.ts",
);
let script = "";

beforeAll(async () => {
  script = await readFile(deployPath, "utf8");
});

describe("database-publication launcher contract", () => {
  it("selects exactly one publisher backend and fails closed", async () => {
    const launcher = await readFile(publisherStartPath, "utf8");
    await expect(
      execute("bash", ["-n", publisherStartPath]),
    ).resolves.toMatchObject({ stderr: "" });
    expect(launcher).toContain('case "${PUBLICATION_BACKEND:-git}" in');
    expect(launcher).toContain("apps/publisher/src/main.ts");
    expect(launcher).toContain("apps/publisher/src/database-main.ts");
    expect(launcher).toContain("PUBLICATION_BACKEND must be git or database");
  });

  it("loads Leadership database secrets outside immutable releases", async () => {
    const launcher = await readFile(leadershipStartPath, "utf8");
    await expect(
      execute("bash", ["-n", leadershipStartPath]),
    ).resolves.toMatchObject({ stderr: "" });
    expect(launcher).toContain("/home/admin/projects/leadership/shared");
    expect(launcher).toContain('source "${leadership_content_env}"');
    expect(launcher).toContain("export LEADERSHIP_RELEASE_ID=");
    expect(launcher).toContain(
      "LEADERSHIP_CANDIDATE_EXCHANGE_SECRET:?missing Leadership candidate exchange secret",
    );
    expect(launcher).toContain(
      "LEADERSHIP_ATTESTATION_KEY_ID:?missing Leadership attestation key ID",
    );
    expect(launcher.indexOf('source "${leadership_content_env}"')).toBeLessThan(
      launcher.indexOf('exec "${leadership_node}"'),
    );
  });

  it("requires an exact target and manifest hash before production bootstrap", async () => {
    const bootstrap = await readFile(bootstrapApplyPath, "utf8");
    expect(bootstrap).toContain("situation_studio_migration_test_");
    expect(bootstrap).toContain(
      "bootstrap:leadership-production:${manifestHash}",
    );
    expect(bootstrap).toContain('targetCode === "leadership-production"');
    expect(bootstrap).toContain(
      "Existing Leadership publication target is not the exact clean bootstrap boundary.",
    );
  });
});

function position(fragment: string) {
  const index = script.indexOf(fragment);
  expect(
    index,
    `missing deploy contract fragment: ${fragment}`,
  ).toBeGreaterThan(-1);
  return index;
}

describe("production deployment safety contract", () => {
  it("is valid Bash with strict error handling", async () => {
    await expect(execute("bash", ["-n", deployPath])).resolves.toMatchObject({
      stderr: "",
    });
    expect(script.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n")).toBe(
      true,
    );
  });

  it.each([
    "SITUATION_STUDIO_APPROVED_COMMIT",
    "git branch --show-current",
    "git diff --quiet",
    "git diff --cached --quiet",
    "git ls-files --others --exclude-standard",
    "git ls-remote origin refs/heads/main",
    "git archive --format=tar",
    "SITUATION_STUDIO_RELEASE_ID must use",
  ])("runs the local %s guard before contacting production", (guard) => {
    expect(position(guard)).toBeLessThan(position('ssh "${studio_host}"'));
  });

  it("requires exact approval for the resolved HEAD", () => {
    expect(script).toContain('studio_commit="$(git rev-parse HEAD)"');
    expect(script).toContain(
      '[[ "${SITUATION_STUDIO_APPROVED_COMMIT:-}" != "${studio_commit}" ]]',
    );
    expect(script).toContain(
      "Production deployment requires explicit approval for exact commit",
    );
  });

  it("requires a clean main branch whose exact commit is origin/main", () => {
    expect(script).toContain('[[ "$(git branch --show-current)" != "main" ]]');
    expect(script).toContain("Production deployment requires a clean worktree");
    expect(script).toContain(
      '[[ "${studio_remote_main}" != "${studio_commit}" ]]',
    );
  });

  it("caps the committed source archive at 50 MiB", () => {
    expect(script).toContain(
      "studio_archive_limit_bytes=$((50 * 1024 * 1024))",
    );
    expect(script).toContain(
      "(( studio_archive_bytes > studio_archive_limit_bytes ))",
    );
  });

  it("preflights health, configuration, memory, and disk before verification", () => {
    const preflight = position("[1/11] Preflighting");
    expect(position("publisher.env")).toBeGreaterThan(preflight);
    expect(position("/health/live")).toBeGreaterThan(preflight);
    expect(position("/health/ready")).toBeGreaterThan(preflight);
    expect(position("MemAvailable:")).toBeGreaterThan(preflight);
    expect(position("df --output=avail")).toBeGreaterThan(preflight);
    expect(position("[2/11] Verifying")).toBeGreaterThan(preflight);
  });

  it("provides a preflight-only exit before tests or release creation", () => {
    const gate = position("SITUATION_STUDIO_PREFLIGHT_ONLY");
    expect(gate).toBeLessThan(position("pnpm verify"));
    expect(gate).toBeLessThan(position("mkdir -p '${studio_release}'"));
    expect(script.slice(gate, position("[2/11] Verifying"))).toContain(
      "exit 0",
    );
  });

  it("runs the complete local verification gate before creating a release", () => {
    expect(position("pnpm verify")).toBeLessThan(
      position("mkdir -p '${studio_release}'"),
    );
  });

  it("ships only committed bytes with git archive", () => {
    expect(script).toContain(
      'git archive --format=tar "${studio_commit}" | ssh',
    );
    expect(script).not.toMatch(/\brsync\b/u);
    expect(script).not.toMatch(/\bscp\b/u);
    expect(script).not.toContain("tar -cf - .");
  });

  it("refuses to overwrite a release identifier", () => {
    expect(script).toContain("test ! -e '${studio_release}'");
    expect(script).toContain("mkdir -p '${studio_release}'");
  });

  it("installs from the lockfile with the pinned pnpm version", () => {
    expect(script).toContain("corepack prepare pnpm@11.9.0 --activate");
    expect(script).toContain("pnpm install --frozen-lockfile");
  });

  it("migrates before importing, building, or cutting over", () => {
    const migrate = position("db:migrate:deploy");
    expect(migrate).toBeLessThan(position("import:baseline"));
    expect(migrate).toBeLessThan(position("pnpm build"));
    expect(migrate).toBeLessThan(position("[10/11] Cutting over"));
  });

  it("builds before changing the current release symlink", () => {
    expect(position("pnpm build")).toBeLessThan(
      position("ln -sfn '${studio_release}'"),
    );
  });

  it("captures the prior release before cutover", () => {
    expect(position('studio_previous="$(ssh')).toBeLessThan(
      position("ln -sfn '${studio_release}'"),
    );
  });

  it("uses an atomic next-link rename for cutover", () => {
    expect(script).toContain(
      "ln -sfn '${studio_release}' '${studio_root}/current.next'",
    );
    expect(script).toContain(
      "mv -Tf '${studio_root}/current.next' '${studio_root}/current'",
    );
  });

  it.each([
    "situation-studio-web",
    "situation-studio-worker",
    "situation-studio-publisher",
    "leadership-field-guide",
  ])("verifies or manages the required process %s", (processName) => {
    expect(script).toContain(processName);
  });

  it("verifies both Studio endpoints and Leadership after cutover", () => {
    const verify = position("[11/11] Verifying");
    expect(script.indexOf("/health/live", verify)).toBeGreaterThan(verify);
    expect(script.indexOf("/health/ready", verify)).toBeGreaterThan(verify);
    expect(script.indexOf("192.168.1.120:3005", verify)).toBeGreaterThan(
      verify,
    );
  });

  it("restores the prior current symlink on failed health", () => {
    const failure = position("Release health failed");
    expect(
      script.indexOf("ln -sfn '${studio_previous}'", failure),
    ).toBeGreaterThan(failure);
    expect(script.indexOf("exit 1", failure)).toBeGreaterThan(failure);
    expect(
      script.indexOf("pm2 start ops/leadership-processes.config.cjs", failure),
    ).toBeGreaterThan(failure);
  });

  it("saves the process list only after health succeeds", () => {
    expect(position("pm2 save")).toBeGreaterThan(position("[11/11] Verifying"));
  });

  it.each([
    /(^|\/)node_modules(\/|$)/u,
    /(^|\/)\.env$/u,
    /(^|\/)artifacts\/runtime(\/|$)/u,
    /(^|\/)\.next(\/|$)/u,
  ])(
    "does not track deploy-host runtime material matching %s",
    async (pattern) => {
      const { stdout } = await execute("git", ["ls-files", "-z"], {
        cwd: studioRoot,
      });
      const offenders = stdout.split("\0").filter((file) => pattern.test(file));
      expect(offenders).toEqual([]);
    },
  );
});
