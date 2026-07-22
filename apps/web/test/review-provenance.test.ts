import { describe, expect, test } from "vitest";
import {
  approvalPreparationPublicError,
  exactBundleBaseMatchesOfficialSnapshot,
} from "../src/server/workflows/review-provenance";

describe("failed database preview recovery", () => {
  const official = [
    { artifactId: "existing", contentHash: "base-existing" },
    { artifactId: "unrelated", contentHash: "unrelated-hash" },
  ];

  test("accepts exact affected bases while ignoring unrelated official artifacts", () => {
    expect(
      exactBundleBaseMatchesOfficialSnapshot(
        [
          {
            artifactId: "existing",
            baseHash: "base-existing",
            changeKind: "MODIFY",
          },
          { artifactId: "new", baseHash: null, changeKind: "ADD" },
        ],
        official,
      ),
    ).toBe(true);
  });

  test("allows a no-change dependency to rebind to its current official identity", () => {
    expect(
      exactBundleBaseMatchesOfficialSnapshot(
        [
          {
            artifactId: "existing",
            baseHash: "older-no-change-identity",
            changeKind: "NO_CHANGE",
          },
        ],
        official,
      ),
    ).toBe(true);
  });

  test("accepts an exact delete base", () => {
    expect(
      exactBundleBaseMatchesOfficialSnapshot(
        [
          {
            artifactId: "existing",
            baseHash: "base-existing",
            changeKind: "DELETE",
          },
        ],
        official,
      ),
    ).toBe(true);
  });

  test.each([
    [
      "changed affected base",
      {
        artifactId: "existing",
        baseHash: "older-base",
        changeKind: "MODIFY",
      },
    ],
    [
      "add collision",
      { artifactId: "existing", baseHash: null, changeKind: "ADD" },
    ],
    [
      "missing delete base",
      {
        artifactId: "missing",
        baseHash: "former-base",
        changeKind: "DELETE",
      },
    ],
    [
      "changed delete base",
      {
        artifactId: "existing",
        baseHash: "older-base",
        changeKind: "DELETE",
      },
    ],
    [
      "missing no-change dependency",
      {
        artifactId: "missing",
        baseHash: "former-base",
        changeKind: "NO_CHANGE",
      },
    ],
  ] as const)("rejects a %s", (_label, artifact) => {
    expect(exactBundleBaseMatchesOfficialSnapshot([artifact], official)).toBe(
      false,
    );
  });

  test.each([
    [
      "FAILED_PREVIEW_RECOVERY_OFFICIAL_BASE_CHANGED",
      "Official content changed in an affected artifact",
    ],
    [
      "FAILED_PREVIEW_RECOVERY_MATERIALIZATION_FAILED",
      "no longer validates against the current official snapshot",
    ],
    ["SOURCE_MANIFEST_MISMATCH", "approval preparation preconditions failed"],
  ])("returns a safe actionable error for %s", (reason, expected) => {
    expect(approvalPreparationPublicError(reason)).toContain(expected);
  });
});
