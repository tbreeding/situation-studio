import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalBundleHash,
  isApprovedArtifactPath,
  sha256,
  type BundleManifest,
} from "@situation-studio/domain";
import { validateBundleFiles } from "@situation-studio/validator";

const OUTPUT_LIMIT = 10 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;

type Command = { binary: string; args: string[] };

export type PublicationArtifact = {
  path: string;
  body: string | null;
};

export type RepositoryPublication = {
  publicationUuid: string;
  bundleHash: string;
  baseCommit: string;
  manifest: BundleManifest;
  artifacts: PublicationArtifact[];
};

export type RepositoryRollback = {
  rollbackUuid: string;
  expectedHead: string;
  targetCommit: string;
  targetManifestHash: string;
};

export type RepositoryPublisherConfig = {
  remoteUrl: string;
  cachePath: string;
  workRoot: string;
  releaseRoot: string;
  previewLink: string;
  liveLink: string;
  validationCommands: readonly Command[];
  validationEnvironment?: Readonly<Record<string, string>>;
};

export type ReleaseMarker = {
  schemaVersion: "1";
  publicationUuid: string;
  bundleHash: string;
  commitSha: string;
  releasePath: string;
};

type CommandResult = { stdout: string; stderr: string };

async function runCommand(
  command: Command,
  options: {
    cwd?: string;
    input?: string;
    environment?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.binary, command.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.environment ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    let timedOut = false;
    let settled = false;
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    timeout.unref();
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > OUTPUT_LIMIT) {
        exceeded = true;
        stop();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0 && !exceeded && !timedOut) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            timedOut
              ? `Trusted command timed out: ${command.binary}`
              : exceeded
                ? `Trusted command output exceeded the limit: ${command.binary}`
                : `Trusted command failed (${String(code)}): ${command.binary}\n${stderr.slice(-2000)}`,
          ),
        );
    });
    child.stdin.end(options.input ?? "");
  });
}

async function git(
  args: string[],
  options: Parameters<typeof runCommand>[1] = {},
) {
  return runCommand({ binary: "git", args }, options);
}

async function exists(candidate: string) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function resolveApproved(root: string, candidate: string) {
  if (!isApprovedArtifactPath(candidate))
    throw new Error(`Artifact path is not approved: ${candidate}`);
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(absoluteRoot, candidate);
  if (!absolute.startsWith(`${absoluteRoot}${path.sep}`))
    throw new Error(`Artifact path escaped the worktree: ${candidate}`);
  return absolute;
}

async function assertSafeParents(root: string, candidate: string) {
  const segments = candidate.split("/").slice(0, -1);
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!(await exists(current))) {
      await mkdir(current, { mode: 0o755 });
      continue;
    }
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error(`Unsafe artifact parent: ${candidate}`);
  }
}

async function regularFileHash(candidate: string) {
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw new Error(`Artifact is not a regular file: ${candidate}`);
  if ((metadata.mode & 0o111) !== 0)
    throw new Error(`Artifact is executable: ${candidate}`);
  return sha256(await readFile(candidate));
}

function artifactBodies(publication: RepositoryPublication) {
  const bodies = new Map(
    publication.artifacts.map((item) => [item.path, item]),
  );
  if (bodies.size !== publication.artifacts.length)
    throw new Error("Publication contains duplicate artifact bodies.");
  return bodies;
}

async function atomicSymlink(linkPath: string, target: string) {
  await mkdir(path.dirname(linkPath), { recursive: true, mode: 0o755 });
  const temporary = `${linkPath}.next-${process.pid}`;
  await rm(temporary, { force: true });
  await symlink(target, temporary);
  await rename(temporary, linkPath);
}

async function extractCommit(worktree: string, releasePath: string) {
  const temporary = await mkdtemp(path.join(tmpdir(), "studio-release-"));
  try {
    const archivePath = path.join(temporary, "release.tar");
    await runCommand(
      {
        binary: "git",
        args: ["archive", "--format=tar", `--output=${archivePath}`, "HEAD"],
      },
      { cwd: worktree },
    );
    await mkdir(releasePath, { recursive: true, mode: 0o755 });
    await runCommand(
      { binary: "tar", args: ["-xf", archivePath, "-C", releasePath] },
      { timeoutMs: COMMAND_TIMEOUT_MS },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function attachRuntimeDependencies(
  worktree: string,
  releasePath: string,
) {
  const dependencies = path.join(worktree, "node_modules");
  if (await exists(dependencies))
    await symlink(dependencies, path.join(releasePath, "node_modules"));
}

export class RepositoryPublisher {
  constructor(private readonly config: RepositoryPublisherConfig) {}

  private async runValidationCommands(worktree: string) {
    const validationHome = path.join(this.config.workRoot, ".validation-home");
    await mkdir(validationHome, { recursive: true, mode: 0o700 });
    for (const command of this.config.validationCommands)
      await runCommand(command, {
        cwd: worktree,
        environment: {
          PATH: process.env.PATH,
          HOME: validationHome,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG ?? "C.UTF-8",
          CI: "1",
          ...this.config.validationEnvironment,
        },
      });
  }

  worktreePath(publicationUuid: string) {
    return path.join(this.config.workRoot, publicationUuid);
  }

  async prepareWorktree(publication: RepositoryPublication) {
    if (canonicalBundleHash(publication.manifest) !== publication.bundleHash)
      throw new Error("Publication bundle hash is not canonical.");
    if (
      publication.manifest.baseCommit !== publication.baseCommit ||
      !/^[a-f0-9]{40}$/u.test(publication.baseCommit) ||
      !/^[a-f0-9-]{36}$/u.test(publication.publicationUuid)
    )
      throw new Error("Publication identity or base commit is invalid.");
    await mkdir(path.dirname(this.config.cachePath), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(this.config.workRoot, { recursive: true, mode: 0o700 });
    if (!(await exists(this.config.cachePath)))
      await git([
        "clone",
        "--bare",
        this.config.remoteUrl,
        this.config.cachePath,
      ]);
    await git([
      `--git-dir=${this.config.cachePath}`,
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    await git([
      `--git-dir=${this.config.cachePath}`,
      "cat-file",
      "-e",
      `${publication.baseCommit}^{commit}`,
    ]);
    const worktree = this.worktreePath(publication.publicationUuid);
    if (!(await exists(worktree)))
      await git([
        `--git-dir=${this.config.cachePath}`,
        "worktree",
        "add",
        "--detach",
        worktree,
        publication.baseCommit,
      ]);
    const head = (
      await git(["rev-parse", "HEAD"], { cwd: worktree })
    ).stdout.trim();
    if (head !== publication.baseCommit) {
      const message = (
        await git(["log", "-1", "--format=%B"], { cwd: worktree })
      ).stdout;
      if (
        !message.includes(`Studio-Publication: ${publication.publicationUuid}`)
      )
        throw new Error(
          "Existing publication worktree has an unexpected head.",
        );
    }
    return worktree;
  }

  async apply(publication: RepositoryPublication) {
    const worktree = this.worktreePath(publication.publicationUuid);
    const bodies = artifactBodies(publication);
    const declaredPaths = new Set(
      publication.manifest.artifacts.map((item) => item.path),
    );
    if (
      publication.artifacts.some((item) => !declaredPaths.has(item.path)) ||
      publication.manifest.artifacts.some(
        (item) => item.changeKind !== "DELETE" && !bodies.has(item.path),
      )
    )
      throw new Error(
        "Stored artifact bodies do not match the approved manifest.",
      );

    for (const artifact of publication.manifest.artifacts) {
      const absolute = resolveApproved(worktree, artifact.path);
      await assertSafeParents(worktree, artifact.path);
      const present = await exists(absolute);
      const currentHash = present ? await regularFileHash(absolute) : null;
      if (artifact.changeKind === "ADD") {
        if (present && currentHash !== artifact.candidateHash)
          throw new Error(`Added artifact already exists: ${artifact.path}`);
      } else if (artifact.changeKind === "DELETE") {
        if (present && currentHash !== artifact.baseHash)
          throw new Error(
            `Deleted artifact base hash changed: ${artifact.path}`,
          );
        if (present) await unlink(absolute);
        continue;
      } else if (
        currentHash !== artifact.baseHash &&
        currentHash !== artifact.candidateHash
      )
        throw new Error(`Artifact base hash changed: ${artifact.path}`);

      if (artifact.changeKind === "NO_CHANGE") {
        if (currentHash !== artifact.candidateHash)
          throw new Error(`No-change artifact is not exact: ${artifact.path}`);
        continue;
      }
      const body = bodies.get(artifact.path)?.body;
      if (body === null || body === undefined)
        throw new Error(`Candidate body is missing: ${artifact.path}`);
      if (sha256(body) !== artifact.candidateHash)
        throw new Error(`Candidate body hash is invalid: ${artifact.path}`);
      await writeFile(absolute, body, { mode: 0o644 });
      await chmod(absolute, 0o644);
    }
  }

  async validate(publication: RepositoryPublication) {
    const worktree = this.worktreePath(publication.publicationUuid);
    const result = validateBundleFiles(worktree, publication.manifest);
    if (result.hash !== publication.bundleHash)
      throw new Error("Applied bundle no longer matches its canonical hash.");
    if (result.findings.length)
      throw new Error(
        `Trusted validation rejected the bundle: ${result.findings.map((item) => item.code).join(", ")}`,
      );
    for (const artifact of publication.manifest.artifacts.filter(
      (item) => item.changeKind === "DELETE",
    ))
      if (await exists(resolveApproved(worktree, artifact.path)))
        throw new Error(`Deleted artifact remains present: ${artifact.path}`);
    await this.runValidationCommands(worktree);
  }

  async commit(publication: RepositoryPublication) {
    const worktree = this.worktreePath(publication.publicationUuid);
    const head = (
      await git(["rev-parse", "HEAD"], { cwd: worktree })
    ).stdout.trim();
    if (head !== publication.baseCommit) {
      const [parent, message] = await Promise.all([
        git(["rev-parse", "HEAD^"], { cwd: worktree }),
        git(["log", "-1", "--format=%B"], { cwd: worktree }),
      ]);
      if (
        parent.stdout.trim() !== publication.baseCommit ||
        !message.stdout.includes(
          `Studio-Publication: ${publication.publicationUuid}`,
        ) ||
        !message.stdout.includes(`Studio-Bundle: ${publication.bundleHash}`)
      )
        throw new Error("Existing publication commit is not reusable.");
      return head;
    }

    const expected = publication.manifest.artifacts
      .filter((item) => item.changeKind !== "NO_CHANGE")
      .map((item) => item.path)
      .sort();
    const [tracked, untracked] = await Promise.all([
      git(
        ["diff", "--name-only", "--no-renames", "-z", publication.baseCommit],
        {
          cwd: worktree,
        },
      ),
      git(["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: worktree,
      }),
    ]);
    const actual = [
      ...tracked.stdout.split("\0"),
      ...untracked.stdout.split("\0"),
    ]
      .filter(Boolean)
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        "Worktree contains changes outside the approved artifact set.",
      );
    if (expected.length)
      await git(["add", "--", ...expected], { cwd: worktree });
    const message =
      `Publish Situation Studio bundle\n\n` +
      `Studio-Publication: ${publication.publicationUuid}\n` +
      `Studio-Bundle: ${publication.bundleHash}\n` +
      `Studio-Base: ${publication.baseCommit}\n` +
      "Studio-Version: 0.1.0\n";
    await git(["commit", "--file=-", "--no-gpg-sign"], {
      cwd: worktree,
      input: message,
      environment: {
        ...process.env,
        GIT_AUTHOR_NAME: "Situation Studio Publisher",
        GIT_AUTHOR_EMAIL: "publisher@situation-studio.invalid",
        GIT_COMMITTER_NAME: "Situation Studio Publisher",
        GIT_COMMITTER_EMAIL: "publisher@situation-studio.invalid",
      },
    });
    return (await git(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
  }

  async pushPreview(publication: RepositoryPublication, commitSha: string) {
    const ref = `refs/heads/studio/preview/${publication.publicationUuid}`;
    const existing = (
      await git([
        `--git-dir=${this.config.cachePath}`,
        "ls-remote",
        "origin",
        ref,
      ])
    ).stdout.trim();
    if (existing) {
      if (existing.split(/\s+/u)[0] !== commitSha)
        throw new Error("Immutable preview branch points at another commit.");
      return ref;
    }
    const remoteHead = (
      await git([
        `--git-dir=${this.config.cachePath}`,
        "ls-remote",
        "origin",
        "refs/heads/main",
      ])
    ).stdout
      .trim()
      .split(/\s+/u)[0];
    if (remoteHead !== publication.baseCommit)
      throw new Error("REMOTE_HEAD_ADVANCED");
    await git([
      `--git-dir=${this.config.cachePath}`,
      "push",
      "origin",
      `${commitSha}:${ref}`,
    ]);
    return ref;
  }

  async buildPreview(publication: RepositoryPublication, commitSha: string) {
    const releasePath = path.join(
      this.config.releaseRoot,
      "releases",
      `${publication.publicationUuid}-${commitSha.slice(0, 12)}`,
    );
    const markerPath = path.join(releasePath, ".studio-publication.json");
    if (!(await exists(markerPath))) {
      const buildingPath = `${releasePath}.building-${publication.publicationUuid}`;
      await rm(buildingPath, { recursive: true, force: true });
      await extractCommit(
        this.worktreePath(publication.publicationUuid),
        buildingPath,
      );
      const buildOutput = path.join(
        this.worktreePath(publication.publicationUuid),
        ".next",
      );
      if (await exists(buildOutput))
        await cp(buildOutput, path.join(buildingPath, ".next"), {
          recursive: true,
          force: false,
        });
      await attachRuntimeDependencies(
        this.worktreePath(publication.publicationUuid),
        buildingPath,
      );
      const marker: ReleaseMarker = {
        schemaVersion: "1",
        publicationUuid: publication.publicationUuid,
        bundleHash: publication.bundleHash,
        commitSha,
        releasePath,
      };
      await writeFile(
        path.join(buildingPath, ".studio-publication.json"),
        `${JSON.stringify(marker)}\n`,
        {
          mode: 0o444,
        },
      );
      if (await exists(releasePath))
        await rm(releasePath, { recursive: true, force: true });
      await rename(buildingPath, releasePath);
    }
    await this.verifyRelease(publication, commitSha, releasePath);
    await atomicSymlink(this.config.previewLink, releasePath);
    return releasePath;
  }

  async verifyRelease(
    publication: RepositoryPublication,
    commitSha: string,
    releasePath: string,
  ) {
    const marker = JSON.parse(
      await readFile(
        path.join(releasePath, ".studio-publication.json"),
        "utf8",
      ),
    ) as ReleaseMarker;
    if (
      marker.schemaVersion !== "1" ||
      marker.publicationUuid !== publication.publicationUuid ||
      marker.bundleHash !== publication.bundleHash ||
      marker.commitSha !== commitSha ||
      marker.releasePath !== releasePath
    )
      throw new Error("Release marker does not match the exact publication.");
    return marker;
  }

  async verifyPreview(
    publication: RepositoryPublication,
    commitSha: string,
    releasePath: string,
  ) {
    const linked = await readlink(this.config.previewLink);
    if (
      path.resolve(path.dirname(this.config.previewLink), linked) !==
      releasePath
    )
      throw new Error("Preview link does not point at the staged release.");
    return this.verifyRelease(publication, commitSha, releasePath);
  }

  async cutover(
    publication: RepositoryPublication,
    commitSha: string,
    releasePath: string,
  ) {
    await this.verifyPreview(publication, commitSha, releasePath);
    const remoteHead = (
      await git([
        `--git-dir=${this.config.cachePath}`,
        "ls-remote",
        "origin",
        "refs/heads/main",
      ])
    ).stdout
      .trim()
      .split(/\s+/u)[0];
    if (remoteHead === publication.baseCommit)
      await git([
        `--git-dir=${this.config.cachePath}`,
        "push",
        "origin",
        `${commitSha}:refs/heads/main`,
      ]);
    else if (remoteHead !== commitSha) throw new Error("REMOTE_HEAD_ADVANCED");
    await atomicSymlink(this.config.liveLink, releasePath);
  }

  async verifyLive(
    publication: RepositoryPublication,
    commitSha: string,
    releasePath: string,
  ) {
    const linked = await readlink(this.config.liveLink);
    if (
      path.resolve(path.dirname(this.config.liveLink), linked) !== releasePath
    )
      throw new Error("Live link does not point at the promoted release.");
    return this.verifyRelease(publication, commitSha, releasePath);
  }

  rollbackWorktreePath(rollbackUuid: string) {
    return path.join(this.config.workRoot, `rollback-${rollbackUuid}`);
  }

  async prepareRollback(rollback: RepositoryRollback) {
    if (
      !/^[a-f0-9-]{36}$/u.test(rollback.rollbackUuid) ||
      !/^[a-f0-9]{40}$/u.test(rollback.expectedHead) ||
      !/^[a-f0-9]{40}$/u.test(rollback.targetCommit) ||
      !/^[a-f0-9]{64}$/u.test(rollback.targetManifestHash)
    )
      throw new Error("Rollback identity is invalid.");
    if (!(await exists(this.config.cachePath)))
      throw new Error("Publisher repository cache is unavailable.");
    await git([
      `--git-dir=${this.config.cachePath}`,
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    await Promise.all(
      [rollback.expectedHead, rollback.targetCommit].map((commit) =>
        git([
          `--git-dir=${this.config.cachePath}`,
          "cat-file",
          "-e",
          `${commit}^{commit}`,
        ]),
      ),
    );
    const worktree = this.rollbackWorktreePath(rollback.rollbackUuid);
    if (!(await exists(worktree)))
      await git([
        `--git-dir=${this.config.cachePath}`,
        "worktree",
        "add",
        "--detach",
        worktree,
        rollback.expectedHead,
      ]);
    return worktree;
  }

  async applyRollback(rollback: RepositoryRollback) {
    const worktree = this.rollbackWorktreePath(rollback.rollbackUuid);
    const head = (
      await git(["rev-parse", "HEAD"], { cwd: worktree })
    ).stdout.trim();
    if (head !== rollback.expectedHead) {
      const message = (
        await git(["log", "-1", "--format=%B"], { cwd: worktree })
      ).stdout;
      if (!message.includes(`Studio-Rollback: ${rollback.rollbackUuid}`))
        throw new Error("Existing rollback worktree has an unexpected head.");
      return;
    }
    await git(
      ["read-tree", "--reset", "-u", `${rollback.targetCommit}^{tree}`],
      {
        cwd: worktree,
      },
    );
  }

  async validateRollback(rollback: RepositoryRollback) {
    await this.runValidationCommands(
      this.rollbackWorktreePath(rollback.rollbackUuid),
    );
  }

  async commitRollback(rollback: RepositoryRollback) {
    const worktree = this.rollbackWorktreePath(rollback.rollbackUuid);
    const head = (
      await git(["rev-parse", "HEAD"], { cwd: worktree })
    ).stdout.trim();
    if (head !== rollback.expectedHead) {
      const [parent, message] = await Promise.all([
        git(["rev-parse", "HEAD^"], { cwd: worktree }),
        git(["log", "-1", "--format=%B"], { cwd: worktree }),
      ]);
      if (
        parent.stdout.trim() !== rollback.expectedHead ||
        !message.stdout.includes(`Studio-Rollback: ${rollback.rollbackUuid}`) ||
        !message.stdout.includes(
          `Studio-Rollback-Target: ${rollback.targetCommit}`,
        )
      )
        throw new Error("Existing rollback commit is not reusable.");
      return head;
    }
    const changed = (
      await git(["status", "--porcelain=v1"], { cwd: worktree })
    ).stdout.trim();
    if (!changed)
      throw new Error("Rollback target has the same repository tree.");
    await git(["add", "--all"], { cwd: worktree });
    const message =
      "Rollback Situation Studio publication\n\n" +
      `Studio-Rollback: ${rollback.rollbackUuid}\n` +
      `Studio-Rollback-Target: ${rollback.targetCommit}\n` +
      `Studio-Base: ${rollback.expectedHead}\n` +
      "Studio-Version: 0.1.0\n";
    await git(["commit", "--file=-", "--no-gpg-sign"], {
      cwd: worktree,
      input: message,
      environment: {
        ...process.env,
        GIT_AUTHOR_NAME: "Situation Studio Publisher",
        GIT_AUTHOR_EMAIL: "publisher@situation-studio.invalid",
        GIT_COMMITTER_NAME: "Situation Studio Publisher",
        GIT_COMMITTER_EMAIL: "publisher@situation-studio.invalid",
      },
    });
    return (await git(["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim();
  }

  async pushRollbackPreview(rollback: RepositoryRollback, commitSha: string) {
    const ref = `refs/heads/studio/rollback/${rollback.rollbackUuid}`;
    const existing = (
      await git([
        `--git-dir=${this.config.cachePath}`,
        "ls-remote",
        "origin",
        ref,
      ])
    ).stdout.trim();
    if (existing) {
      if (existing.split(/\s+/u)[0] !== commitSha)
        throw new Error("Immutable rollback branch points at another commit.");
      return ref;
    }
    const remoteHead = (
      await git([
        `--git-dir=${this.config.cachePath}`,
        "ls-remote",
        "origin",
        "refs/heads/main",
      ])
    ).stdout
      .trim()
      .split(/\s+/u)[0];
    if (remoteHead !== rollback.expectedHead)
      throw new Error("REMOTE_HEAD_ADVANCED");
    await git([
      `--git-dir=${this.config.cachePath}`,
      "push",
      "origin",
      `${commitSha}:${ref}`,
    ]);
    return ref;
  }

  async buildRollback(rollback: RepositoryRollback, commitSha: string) {
    const releasePath = path.join(
      this.config.releaseRoot,
      "releases",
      `rollback-${rollback.rollbackUuid}-${commitSha.slice(0, 12)}`,
    );
    const markerPath = path.join(releasePath, ".studio-publication.json");
    if (!(await exists(markerPath))) {
      const buildingPath = `${releasePath}.building-${rollback.rollbackUuid}`;
      await rm(buildingPath, { recursive: true, force: true });
      const worktree = this.rollbackWorktreePath(rollback.rollbackUuid);
      await extractCommit(worktree, buildingPath);
      const buildOutput = path.join(worktree, ".next");
      if (await exists(buildOutput))
        await cp(buildOutput, path.join(buildingPath, ".next"), {
          recursive: true,
          force: false,
        });
      await attachRuntimeDependencies(worktree, buildingPath);
      const marker: ReleaseMarker = {
        schemaVersion: "1",
        publicationUuid: rollback.rollbackUuid,
        bundleHash: rollback.targetManifestHash,
        commitSha,
        releasePath,
      };
      await writeFile(
        path.join(buildingPath, ".studio-publication.json"),
        `${JSON.stringify(marker)}\n`,
        { mode: 0o444 },
      );
      if (await exists(releasePath))
        await rm(releasePath, { recursive: true, force: true });
      await rename(buildingPath, releasePath);
    }
    await this.verifyRollbackRelease(rollback, commitSha, releasePath);
    await atomicSymlink(this.config.previewLink, releasePath);
    return releasePath;
  }

  private async verifyRollbackRelease(
    rollback: RepositoryRollback,
    commitSha: string,
    releasePath: string,
  ) {
    const marker = JSON.parse(
      await readFile(
        path.join(releasePath, ".studio-publication.json"),
        "utf8",
      ),
    ) as ReleaseMarker;
    if (
      marker.publicationUuid !== rollback.rollbackUuid ||
      marker.bundleHash !== rollback.targetManifestHash ||
      marker.commitSha !== commitSha ||
      marker.releasePath !== releasePath
    )
      throw new Error("Rollback release marker is not exact.");
    return marker;
  }

  async verifyRollbackPreview(
    rollback: RepositoryRollback,
    commitSha: string,
    releasePath: string,
  ) {
    const linked = await readlink(this.config.previewLink);
    if (
      path.resolve(path.dirname(this.config.previewLink), linked) !==
      releasePath
    )
      throw new Error("Preview link does not point at the rollback release.");
    return this.verifyRollbackRelease(rollback, commitSha, releasePath);
  }

  async cutoverRollback(
    rollback: RepositoryRollback,
    commitSha: string,
    releasePath: string,
  ) {
    await this.verifyRollbackPreview(rollback, commitSha, releasePath);
    const remoteHead = (
      await git([
        `--git-dir=${this.config.cachePath}`,
        "ls-remote",
        "origin",
        "refs/heads/main",
      ])
    ).stdout
      .trim()
      .split(/\s+/u)[0];
    if (remoteHead === rollback.expectedHead)
      await git([
        `--git-dir=${this.config.cachePath}`,
        "push",
        "origin",
        `${commitSha}:refs/heads/main`,
      ]);
    else if (remoteHead !== commitSha) throw new Error("REMOTE_HEAD_ADVANCED");
    await atomicSymlink(this.config.liveLink, releasePath);
  }

  async verifyRollbackLive(
    rollback: RepositoryRollback,
    commitSha: string,
    releasePath: string,
  ) {
    const linked = await readlink(this.config.liveLink);
    if (
      path.resolve(path.dirname(this.config.liveLink), linked) !== releasePath
    )
      throw new Error("Live link does not point at the rollback release.");
    return this.verifyRollbackRelease(rollback, commitSha, releasePath);
  }
}
