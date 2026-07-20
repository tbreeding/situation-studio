import { describe, expect, test } from "vitest";
import { exactBundleBaseMatchesOfficialSnapshot } from "../src/server/workflows/review-provenance";

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
  ] as const)("rejects a %s", (_label, artifact) => {
    expect(exactBundleBaseMatchesOfficialSnapshot([artifact], official)).toBe(
      false,
    );
  });
});
