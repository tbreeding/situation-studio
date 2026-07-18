import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
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
    remote,
    artifactPath,
    candidateBody,
    publication,
    publisher,
  };
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
});
