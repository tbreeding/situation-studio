import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, type BundleManifest } from "@situation-studio/domain";
import { inspectCandidateText, validateBundleFiles } from "../src/index";

function fixture(body: string): { root: string; manifest: BundleManifest } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-validator-"));
  const relative = "content/situations/synthetic.mdx";
  fs.mkdirSync(path.join(root, "content/situations"), { recursive: true });
  fs.writeFileSync(path.join(root, relative), body);
  return {
    root,
    manifest: {
      schemaVersion: "1",
      situationId: "synthetic",
      revision: 1,
      baseCommit: "a".repeat(40),
      baseManifestHash: "b".repeat(64),
      briefHash: null,
      graphHash: "c".repeat(64),
      artifacts: [
        {
          logicalId: "situation:synthetic",
          type: "SITUATION",
          path: relative,
          baseHash: null,
          candidateHash: sha256(body),
          changeKind: "ADD",
          noChangeRationale: null,
        },
      ],
      relationshipChanges: [],
    },
  };
}

describe("trusted validator boundary", () => {
  it("accepts exact safe bytes", () => {
    const { root, manifest } = fixture(
      '# Synthetic\n\n<PreparedAction scenario="synthetic" skill="feedback" />\n',
    );
    expect(validateBundleFiles(root, manifest).findings).toEqual([]);
  });

  it("rejects path traversal and unsafe MDX", () => {
    expect(
      inspectCandidateText(
        "x.mdx",
        'import x from "private"\n<Unknown />\n[j](javascript:alert(1))',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MDX_MODULE" }),
        expect.objectContaining({ code: "UNKNOWN_COMPONENT" }),
        expect.objectContaining({ code: "UNSAFE_URL" }),
      ]),
    );
  });

  it("detects bytes changed after approval", () => {
    const { root, manifest } = fixture("# Original");
    fs.writeFileSync(path.join(root, manifest.artifacts[0]!.path), "# Changed");
    expect(validateBundleFiles(root, manifest).findings).toContainEqual(
      expect.objectContaining({ code: "HASH_MISMATCH" }),
    );
  });
});
