import { describe, expect, it } from "vitest";
import {
  applyArtifactOverlay,
  canonicalArtifactBytes,
  canonicalJson,
  compileSafeMdx,
  buildCanonicalSnapshot,
  isApprovedArtifactPath,
  sha256,
  validateCanonicalSnapshot,
  validationPolicyHash,
  type SnapshotArtifact,
  type SnapshotManifest,
} from "../src/index";

const source = {
  releaseId: "fixture-release",
  historicalCommit: "a".repeat(40),
  frozenManifestHash: "b".repeat(64),
};

function authorArtifact(body: string): {
  artifact: SnapshotArtifact;
  bytes: Uint8Array;
} {
  const bytes = new TextEncoder().encode(body);
  return {
    bytes,
    artifact: {
      logicalId: "author:catalog",
      type: "AUTHOR",
      path: "content/authors/authors.json",
      contentHash: sha256(bytes),
      byteLength: bytes.byteLength,
      encoding: "UTF8",
      mediaType: "application/json; charset=utf-8",
    },
  };
}

describe("database content contracts", () => {
  it("canonicalizes text and rejects paths outside managed roots", () => {
    const normalized = canonicalArtifactBytes(
      "content/guides/example.mdx",
      new TextEncoder().encode("hello\r\n\r\n"),
    );
    expect(new TextDecoder().decode(normalized.bytes)).toBe("hello\n");
    expect(normalized.normalization).toBe("CANONICAL_NEWLINE");
    expect(isApprovedArtifactPath("content/tools/tools.json")).toBe(true);
    expect(
      isApprovedArtifactPath(
        "sourceMaterial/leadership-workshops-master/assets/logo.png",
      ),
    ).toBe(true);
    expect(isApprovedArtifactPath("../content/tools/tools.json")).toBe(false);
    expect(isApprovedArtifactPath("lib/tools.ts")).toBe(false);
  });

  it("validates exact canonical manifests and independently checks every hash", async () => {
    const fixture = authorArtifact(
      '[{"id":"fixture-reviewer","name":"Fixture","role":"Reviewer","bio":"A fixture reviewer."}]\n',
    );
    const manifest: SnapshotManifest = {
      schemaVersion: "content-snapshot-v1",
      validationPolicyHash,
      source,
      artifacts: [fixture.artifact],
      edges: [],
    };
    await expect(
      validateCanonicalSnapshot(
        canonicalJson(manifest),
        new Map([[fixture.artifact.contentHash, fixture.bytes]]),
      ),
    ).resolves.toMatchObject({ authors: [{ id: "fixture-reviewer" }] });
    await expect(
      buildCanonicalSnapshot(
        source,
        [fixture.artifact],
        new Map([[fixture.artifact.contentHash, fixture.bytes]]),
      ),
    ).resolves.toMatchObject({
      manifest: { artifacts: [fixture.artifact], edges: [] },
    });
    const corrupt = new TextEncoder().encode("corrupt\n");
    await expect(
      validateCanonicalSnapshot(
        canonicalJson(manifest),
        new Map([[fixture.artifact.contentHash, corrupt]]),
      ),
    ).rejects.toThrow(/byte length mismatch|content hash mismatch/u);
    await expect(
      validateCanonicalSnapshot(
        `${JSON.stringify(manifest, null, 2)}\n`,
        new Map([[fixture.artifact.contentHash, fixture.bytes]]),
      ),
    ).rejects.toThrow(/not exact canonical JSON/u);
  });

  it("rejects malformed JSON/frontmatter and an oversized complete snapshot", async () => {
    const invalidJson = authorArtifact("{not-json}\n");
    await expect(
      validateCanonicalSnapshot(
        canonicalJson({
          schemaVersion: "content-snapshot-v1",
          validationPolicyHash,
          source,
          artifacts: [invalidJson.artifact],
          edges: [],
        }),
        new Map([[invalidJson.artifact.contentHash, invalidJson.bytes]]),
      ),
    ).rejects.toThrow(/invalid JSON/u);

    const invalidFrontmatterBytes = new TextEncoder().encode(
      "---\nslug: incomplete-situation\ntitle: Incomplete\n---\n\n## Missing required contract\n",
    );
    const invalidFrontmatter: SnapshotArtifact = {
      logicalId: "situation:incomplete-situation",
      type: "SITUATION",
      path: "content/situations/incomplete-situation.mdx",
      contentHash: sha256(invalidFrontmatterBytes),
      byteLength: invalidFrontmatterBytes.byteLength,
      encoding: "UTF8",
      mediaType: "text/mdx; charset=utf-8",
    };
    await expect(
      validateCanonicalSnapshot(
        canonicalJson({
          schemaVersion: "content-snapshot-v1",
          validationPolicyHash,
          source,
          artifacts: [invalidFrontmatter],
          edges: [],
        }),
        new Map([[invalidFrontmatter.contentHash, invalidFrontmatterBytes]]),
      ),
    ).rejects.toThrow();

    const maximumArtifact = new Uint8Array(2 * 1024 * 1024);
    const maximumHash = sha256(maximumArtifact);
    const oversizedArtifacts: SnapshotArtifact[] = Array.from(
      { length: 17 },
      (_, index) => ({
        logicalId: `asset:oversized-${index}`,
        type: "ASSET",
        path: `sourceMaterial/oversized/asset-${index}.png`,
        contentHash: maximumHash,
        byteLength: maximumArtifact.byteLength,
        encoding: "BINARY",
        mediaType: "image/png",
      }),
    ).sort((left, right) => left.path.localeCompare(right.path));
    await expect(
      validateCanonicalSnapshot(
        canonicalJson({
          schemaVersion: "content-snapshot-v1",
          validationPolicyHash,
          source,
          artifacts: oversizedArtifacts,
          edges: [],
        }),
        new Map([[maximumHash, maximumArtifact]]),
      ),
    ).rejects.toThrow(/Snapshot exceeds/u);
  });

  it("materializes add, modify, no-change, and delete overlays deterministically", () => {
    const first = authorArtifact(
      '[{"id":"first-reviewer","name":"First","role":"Reviewer","bio":"First fixture."}]\n',
    ).artifact;
    const changed = { ...first, contentHash: "c".repeat(64), byteLength: 101 };
    const added: SnapshotArtifact = {
      ...first,
      logicalId: "source:catalog",
      type: "SOURCE",
      path: "content/bibliography/sources.json",
      contentHash: "d".repeat(64),
    };
    const result = applyArtifactOverlay(
      [first],
      [
        { logicalId: first.logicalId, changeKind: "MODIFY", artifact: changed },
        { logicalId: added.logicalId, changeKind: "ADD", artifact: added },
      ],
    );
    expect(result.map((artifact) => artifact.logicalId)).toEqual([
      "author:catalog",
      "source:catalog",
    ]);
    expect(
      applyArtifactOverlay(result, [
        {
          logicalId: first.logicalId,
          changeKind: "NO_CHANGE",
          artifact: changed,
        },
        { logicalId: added.logicalId, changeKind: "DELETE" },
      ]),
    ).toEqual([changed]);
    expect(sha256(canonicalJson(result))).toBe(
      sha256(
        canonicalJson(
          applyArtifactOverlay(
            [first],
            [
              {
                logicalId: added.logicalId,
                changeKind: "ADD",
                artifact: added,
              },
              {
                logicalId: first.logicalId,
                changeKind: "MODIFY",
                artifact: changed,
              },
            ],
          ),
        ),
      ),
    );
  });

  it("fails duplicate logical identities and path collisions closed", () => {
    const fixture = authorArtifact(
      '[{"id":"fixture-reviewer","name":"Fixture","role":"Reviewer","bio":"Fixture."}]\n',
    ).artifact;
    expect(() => applyArtifactOverlay([fixture, fixture], [])).toThrow(
      /Duplicate base logical IDs/u,
    );
    expect(() =>
      applyArtifactOverlay(
        [fixture],
        [
          {
            logicalId: "source:catalog",
            changeKind: "ADD",
            artifact: {
              ...fixture,
              logicalId: "source:catalog",
              type: "SOURCE",
            },
          },
        ],
      ),
    ).toThrow(/Duplicate result paths/u);
  });

  it("compiles the allowlisted MDX surface and rejects executable or unknown components", async () => {
    await expect(
      compileSafeMdx(
        "content/situations/example.mdx",
        '## Practice\n\n<PracticeEmbed practiceId="listen-first" variant="fixture" surface="situation" compact />\n',
      ),
    ).resolves.toMatchObject({ components: ["PracticeEmbed"] });
    await expect(
      compileSafeMdx(
        "content/situations/example.mdx",
        "import Danger from './danger'\n\n<Danger />\n",
      ),
    ).rejects.toThrow(/module syntax is forbidden/u);
    await expect(
      compileSafeMdx("content/situations/example.mdx", "<UnknownWidget />\n"),
    ).rejects.toThrow(/unknown MDX components/u);
  });
});
