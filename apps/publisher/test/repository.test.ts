import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  canonicalBundleHash,
  sha256,
  type BundleManifest,
} from "@situation-studio/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  RepositoryPublisher,
  type RepositoryPublication,
  type RepositoryPublisherConfig,
} from "../src/repository";

const execute = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(
  publisherOverrides: Partial<RepositoryPublisherConfig> = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "studio-publisher-test-"));
  temporaryRoots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const artifactPath = "content/situations/synthetic-example.mdx";
  const baseBody =
    "---\nslug: synthetic-example\ntitle: Synthetic\n---\n\nBase.\n";
  const candidateBody = baseBody.replace("Base.", "Candidate.");
  await mkdir(path.join(source, path.dirname(artifactPath)), {
    recursive: true,
  });
  await writeFile(path.join(source, artifactPath), baseBody);
  await execute("git", ["init", "--initial-branch=main", source]);
  await execute("git", ["config", "user.name", "Fixture"], { cwd: source });
  await execute("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: source,
  });
  await execute("git", ["add", artifactPath], { cwd: source });
  await execute("git", ["commit", "-m", "Fixture baseline"], { cwd: source });
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], {
    cwd: source,
  });
  const baseCommit = stdout.trim();
  await execute("git", ["clone", "--bare", source, remote]);

  const manifest: BundleManifest = {
    schemaVersion: "1",
    situationId: "synthetic-situation",
    revision: 1,
    baseCommit,
    baseManifestHash: "a".repeat(64),
    briefHash: null,
    graphHash: "b".repeat(64),
    artifacts: [
      {
        logicalId: "situation:synthetic-example",
        type: "SITUATION",
        path: artifactPath,
        baseHash: sha256(baseBody),
        candidateHash: sha256(candidateBody),
        changeKind: "MODIFY",
        noChangeRationale: null,
      },
    ],
    relationshipChanges: [],
  };
  const publication: RepositoryPublication = {
    publicationUuid: "11111111-1111-4111-8111-111111111111",
    bundleHash: canonicalBundleHash(manifest),
    baseCommit,
    manifest,
    artifacts: [{ path: artifactPath, body: candidateBody }],
  };
  const publisher = new RepositoryPublisher({
    remoteUrl: remote,
    cachePath: path.join(root, "publisher", "cache.git"),
    workRoot: path.join(root, "publisher", "worktrees"),
    releaseRoot: path.join(root, "release-target"),
    previewLink: path.join(root, "release-target", "preview"),
    liveLink: path.join(root, "release-target", "current"),
    validationCommands: [
      {
        binary: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    ],
    ...publisherOverrides,
  });
  return {
    root,
    source,
    remote,
    artifactPath,
    baseBody,
    candidateBody,
    publication,
    publisher,
  };
}

async function commitCandidate(item: Awaited<ReturnType<typeof fixture>>) {
  await item.publisher.prepareWorktree(item.publication);
  await item.publisher.apply(item.publication);
  await item.publisher.validate(item.publication);
  return item.publisher.commit(item.publication);
}

async function buildCandidatePreview(
  item: Awaited<ReturnType<typeof fixture>>,
) {
  const commitSha = await commitCandidate(item);
  await item.publisher.pushPreview(item.publication, commitSha);
  const releasePath = await item.publisher.buildPreview(
    item.publication,
    commitSha,
  );
  return { commitSha, releasePath };
}

async function advanceRemote(item: Awaited<ReturnType<typeof fixture>>) {
  await writeFile(
    path.join(item.source, item.artifactPath),
    `${item.baseBody}\nRemote advanced.\n`,
  );
  await execute("git", ["add", item.artifactPath], { cwd: item.source });
  await execute("git", ["commit", "-m", "Advance fixture remote"], {
    cwd: item.source,
  });
  const { stdout } = await execute("git", ["rev-parse", "HEAD"], {
    cwd: item.source,
  });
  await execute("git", ["push", item.remote, "HEAD:main"], {
    cwd: item.source,
  });
  return stdout.trim();
}

describe("trusted repository publisher", () => {
  it("creates one exact commit and promotes the previewed release idempotently", async () => {
    const item = await fixture();
    await item.publisher.prepareWorktree(item.publication);
    await item.publisher.apply(item.publication);
    await item.publisher.apply(item.publication);
    await item.publisher.validate(item.publication);
    const commitSha = await item.publisher.commit(item.publication);
    expect(await item.publisher.commit(item.publication)).toBe(commitSha);
    await item.publisher.pushPreview(item.publication, commitSha);
    await item.publisher.pushPreview(item.publication, commitSha);
    const releasePath = await item.publisher.buildPreview(
      item.publication,
      commitSha,
    );
    await item.publisher.verifyPreview(
      item.publication,
      commitSha,
      releasePath,
    );
    await item.publisher.cutover(item.publication, commitSha, releasePath);
    await item.publisher.cutover(item.publication, commitSha, releasePath);
    await item.publisher.verifyLive(item.publication, commitSha, releasePath);

    const rollback = {
      rollbackUuid: "22222222-2222-4222-8222-222222222222",
      expectedHead: commitSha,
      targetCommit: item.publication.baseCommit,
      targetManifestHash: "c".repeat(64),
    };
    await item.publisher.prepareRollback(rollback);
    await item.publisher.applyRollback(rollback);
    await item.publisher.validateRollback(rollback);
    const rollbackCommit = await item.publisher.commitRollback(rollback);
    expect(await item.publisher.commitRollback(rollback)).toBe(rollbackCommit);
    await item.publisher.pushRollbackPreview(rollback, rollbackCommit);
    const rollbackRelease = await item.publisher.buildRollback(
      rollback,
      rollbackCommit,
    );
    await item.publisher.verifyRollbackPreview(
      rollback,
      rollbackCommit,
      rollbackRelease,
    );
    await item.publisher.cutoverRollback(
      rollback,
      rollbackCommit,
      rollbackRelease,
    );
    await item.publisher.verifyRollbackLive(
      rollback,
      rollbackCommit,
      rollbackRelease,
    );

    const { stdout: remoteHead } = await execute("git", [
      `--git-dir=${item.remote}`,
      "rev-parse",
      "main",
    ]);
    expect(remoteHead.trim()).toBe(rollbackCommit);
    expect(
      await readFile(path.join(releasePath, item.artifactPath), "utf8"),
    ).toBe(item.candidateBody);
    const { stdout: commits } = await execute("git", [
      `--git-dir=${item.remote}`,
      "rev-list",
      "--count",
      "main",
    ]);
    expect(commits.trim()).toBe("3");
    const { stdout: rollbackTree } = await execute("git", [
      `--git-dir=${item.remote}`,
      "rev-parse",
      `${rollbackCommit}^{tree}`,
    ]);
    const { stdout: baseTree } = await execute("git", [
      `--git-dir=${item.remote}`,
      "rev-parse",
      `${item.publication.baseCommit}^{tree}`,
    ]);
    expect(rollbackTree.trim()).toBe(baseTree.trim());
  });

  it("fails closed when the repository base bytes changed", async () => {
    const item = await fixture();
    await item.publisher.prepareWorktree(item.publication);
    const worktree = item.publisher.worktreePath(
      item.publication.publicationUuid,
    );
    await writeFile(path.join(worktree, item.artifactPath), "Unexpected.\n");
    await expect(item.publisher.apply(item.publication)).rejects.toThrow(
      "base hash changed",
    );
  });

  it("activates and health-checks the exact preview and live release", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200).end("healthy");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture health server did not bind.");
      const item = await fixture({
        activationBinary: "/usr/bin/true",
        previewProcessName: "preview-fixture",
        liveProcessName: "live-fixture",
        previewHealthUrl: `http://127.0.0.1:${address.port}/preview`,
        liveHealthUrl: `http://127.0.0.1:${address.port}/live`,
      });
      await item.publisher.prepareWorktree(item.publication);
      await item.publisher.apply(item.publication);
      await item.publisher.validate(item.publication);
      const commitSha = await item.publisher.commit(item.publication);
      await item.publisher.pushPreview(item.publication, commitSha);
      const releasePath = await item.publisher.buildPreview(
        item.publication,
        commitSha,
      );
      await item.publisher.verifyPreview(
        item.publication,
        commitSha,
        releasePath,
      );
      await item.publisher.cutover(item.publication, commitSha, releasePath);
      await item.publisher.verifyLive(item.publication, commitSha, releasePath);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("stages and publishes through one candidate runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "studio-runtime-test-"));
    temporaryRoots.push(root);
    const candidateLink = path.join(root, "leadership", "current");
    const item = await fixture({
      previewLink: candidateLink,
      liveLink: candidateLink,
    });
    await item.publisher.prepareWorktree(item.publication);
    await item.publisher.apply(item.publication);
    await item.publisher.validate(item.publication);
    const commitSha = await item.publisher.commit(item.publication);
    await item.publisher.pushPreview(item.publication, commitSha);
    const releasePath = await item.publisher.buildPreview(
      item.publication,
      commitSha,
    );
    await item.publisher.verifyPreview(
      item.publication,
      commitSha,
      releasePath,
    );
    await item.publisher.cutover(item.publication, commitSha, releasePath);
    await item.publisher.verifyLive(item.publication, commitSha, releasePath);

    expect(
      path.resolve(path.dirname(candidateLink), await readlink(candidateLink)),
    ).toBe(releasePath);
    const { stdout: remoteHead } = await execute("git", [
      `--git-dir=${item.remote}`,
      "rev-parse",
      "main",
    ]);
    expect(remoteHead.trim()).toBe(commitSha);
  });

  it("rejects a bundle hash that is not the canonical manifest hash", async () => {
    const item = await fixture();
    item.publication.bundleHash = "0".repeat(64);
    await expect(
      item.publisher.prepareWorktree(item.publication),
    ).rejects.toThrow("Publication bundle hash is not canonical");
  });

  it.each([
    ["publicationUuid", "not-a-uuid"],
    ["baseCommit", "not-a-commit"],
  ] as const)("rejects an invalid %s", async (field, value) => {
    const item = await fixture();
    Object.assign(item.publication, { [field]: value });
    await expect(
      item.publisher.prepareWorktree(item.publication),
    ).rejects.toThrow("Publication identity or base commit is invalid");
  });

  it("rejects duplicate stored artifact bodies", async () => {
    const item = await fixture();
    await item.publisher.prepareWorktree(item.publication);
    item.publication.artifacts.push({ ...item.publication.artifacts[0]! });
    await expect(item.publisher.apply(item.publication)).rejects.toThrow(
      "Publication contains duplicate artifact bodies",
    );
  });

  it("rejects stored artifact bytes that are absent from the manifest", async () => {
    const item = await fixture();
    await item.publisher.prepareWorktree(item.publication);
    item.publication.artifacts.push({
      path: "content/situations/undeclared.mdx",
      body: "Undeclared.\n",
    });
    await expect(item.publisher.apply(item.publication)).rejects.toThrow(
      "Stored artifact bodies do not match the approved manifest",
    );
  });

  it("rejects a manifest artifact whose approved body is missing", async () => {
    const item = await fixture();
    await item.publisher.prepareWorktree(item.publication);
    item.publication.artifacts = [];
    await expect(item.publisher.apply(item.publication)).rejects.toThrow(
      "Stored artifact bodies do not match the approved manifest",
    );
  });

  it("rejects candidate bytes that do not match the approved hash", async () => {
    const item = await fixture();
    await item.publisher.prepareWorktree(item.publication);
    item.publication.artifacts[0]!.body = "Tampered candidate.\n";
    await expect(item.publisher.apply(item.publication)).rejects.toThrow(
      "Candidate body hash is invalid",
    );
  });

  it("rejects an executable artifact in the publication worktree", async () => {
    const item = await fixture();
    await item.publisher.prepareWorktree(item.publication);
    await chmod(
      path.join(
        item.publisher.worktreePath(item.publication.publicationUuid),
        item.artifactPath,
      ),
      0o755,
    );
    await expect(item.publisher.apply(item.publication)).rejects.toThrow(
      "Artifact is executable",
    );
  });

  it("rejects a symlinked artifact parent", async () => {
    const item = await fixture();
    await item.publisher.prepareWorktree(item.publication);
    const worktree = item.publisher.worktreePath(
      item.publication.publicationUuid,
    );
    const situations = path.join(worktree, "content", "situations");
    await rm(situations, { recursive: true });
    await symlink(item.root, situations);
    await expect(item.publisher.apply(item.publication)).rejects.toThrow(
      "Unsafe artifact parent",
    );
  });

  it("rejects a manifest path outside the approved repository surface", async () => {
    const item = await fixture();
    item.publication.manifest.artifacts[0]!.path = "../escape.mdx";
    expect(() => canonicalBundleHash(item.publication.manifest)).toThrow();
  });

  it("rejects unrelated worktree changes before creating a commit", async () => {
    const item = await fixture();
    await item.publisher.prepareWorktree(item.publication);
    await item.publisher.apply(item.publication);
    const worktree = item.publisher.worktreePath(
      item.publication.publicationUuid,
    );
    await writeFile(path.join(worktree, "unexpected.txt"), "Not approved.\n");
    await expect(item.publisher.commit(item.publication)).rejects.toThrow(
      "Worktree contains changes outside the approved artifact set",
    );
  });

  it("rejects preview publication when protected main has advanced", async () => {
    const item = await fixture();
    const commitSha = await commitCandidate(item);
    await advanceRemote(item);
    await expect(
      item.publisher.pushPreview(item.publication, commitSha),
    ).rejects.toThrow("REMOTE_HEAD_ADVANCED");
  });

  it("rejects reuse of an immutable preview ref for different bytes", async () => {
    const item = await fixture();
    const commitSha = await commitCandidate(item);
    await execute("git", [
      `--git-dir=${item.remote}`,
      "update-ref",
      `refs/heads/studio/preview/${item.publication.publicationUuid}`,
      item.publication.baseCommit,
    ]);
    await expect(
      item.publisher.pushPreview(item.publication, commitSha),
    ).rejects.toThrow("Immutable preview branch points at another commit");
  });

  it.each([
    ["schemaVersion", "2"],
    ["publicationUuid", "22222222-2222-4222-8222-222222222222"],
    ["bundleHash", "0".repeat(64)],
    ["commitSha", "0".repeat(40)],
    ["releasePath", "/not/the/release"],
  ] as const)(
    "rejects a release marker with the wrong %s",
    async (field, value) => {
      const item = await fixture();
      const { commitSha, releasePath } = await buildCandidatePreview(item);
      const markerPath = path.join(releasePath, ".studio-publication.json");
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
        string,
        string
      >;
      marker[field] = value;
      await chmod(markerPath, 0o644);
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`);
      await expect(
        item.publisher.verifyRelease(item.publication, commitSha, releasePath),
      ).rejects.toThrow("Release marker does not match the exact publication");
    },
  );

  it("rejects preview verification when the link moves to another release", async () => {
    const item = await fixture();
    const { commitSha, releasePath } = await buildCandidatePreview(item);
    const other = path.join(item.root, "other-preview");
    await mkdir(other);
    const previewLink = path.join(item.root, "release-target", "preview");
    await unlink(previewLink);
    await symlink(other, previewLink);
    await expect(
      item.publisher.verifyPreview(item.publication, commitSha, releasePath),
    ).rejects.toThrow("Preview link does not point at the staged release");
  });

  it("rejects cutover when protected main advances after preview verification", async () => {
    const item = await fixture();
    const { commitSha, releasePath } = await buildCandidatePreview(item);
    await advanceRemote(item);
    await expect(
      item.publisher.cutover(item.publication, commitSha, releasePath),
    ).rejects.toThrow("REMOTE_HEAD_ADVANCED");
  });

  it("rejects live verification when the link does not name the promoted release", async () => {
    const item = await fixture();
    const { commitSha, releasePath } = await buildCandidatePreview(item);
    await item.publisher.cutover(item.publication, commitSha, releasePath);
    const other = path.join(item.root, "other-live");
    await mkdir(other);
    const liveLink = path.join(item.root, "release-target", "current");
    await unlink(liveLink);
    await symlink(other, liveLink);
    await expect(
      item.publisher.verifyLive(item.publication, commitSha, releasePath),
    ).rejects.toThrow("Live link does not point at the promoted release");
  });

  it("rejects a partially configured release activation", async () => {
    const item = await fixture({ activationBinary: "/usr/bin/true" });
    const commitSha = await commitCandidate(item);
    await item.publisher.pushPreview(item.publication, commitSha);
    await expect(
      item.publisher.buildPreview(item.publication, commitSha),
    ).rejects.toThrow("Publisher release activation is only partly configured");
  });

  it.each([
    {
      rollbackUuid: "invalid",
      expectedHead: "a".repeat(40),
      targetCommit: "b".repeat(40),
      targetManifestHash: "c".repeat(64),
    },
    {
      rollbackUuid: "22222222-2222-4222-8222-222222222222",
      expectedHead: "invalid",
      targetCommit: "b".repeat(40),
      targetManifestHash: "c".repeat(64),
    },
    {
      rollbackUuid: "22222222-2222-4222-8222-222222222222",
      expectedHead: "a".repeat(40),
      targetCommit: "invalid",
      targetManifestHash: "c".repeat(64),
    },
    {
      rollbackUuid: "22222222-2222-4222-8222-222222222222",
      expectedHead: "a".repeat(40),
      targetCommit: "b".repeat(40),
      targetManifestHash: "invalid",
    },
  ])("rejects malformed rollback identity %#", async (rollback) => {
    const item = await fixture();
    await expect(item.publisher.prepareRollback(rollback)).rejects.toThrow(
      "Rollback identity is invalid",
    );
  });
});
