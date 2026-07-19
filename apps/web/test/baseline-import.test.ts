import { describe, expect, test } from "vitest";
import { baselineImportDisposition } from "../src/server/setup/baseline";

describe("baseline import disposition", () => {
  test("imports only into a completely empty database", () => {
    expect(
      baselineImportDisposition({
        exactSnapshotId: null,
        latestSnapshotId: null,
        snapshots: 0,
        situations: 0,
        artifacts: 0,
      }),
    ).toEqual({ action: "IMPORT" });
  });

  test("is idempotent when the exact embedded snapshot already exists", () => {
    expect(
      baselineImportDisposition({
        exactSnapshotId: "snapshot-exact",
        latestSnapshotId: "snapshot-latest",
        snapshots: 2,
        situations: 15,
        artifacts: 37,
      }),
    ).toEqual({ action: "SKIP", snapshotId: "snapshot-exact" });
  });

  test("preserves an initialized production database when the embedded baseline advances", () => {
    expect(
      baselineImportDisposition({
        exactSnapshotId: null,
        latestSnapshotId: "snapshot-production",
        snapshots: 1,
        situations: 15,
        artifacts: 37,
      }),
    ).toEqual({ action: "SKIP", snapshotId: "snapshot-production" });
  });

  test.each([
    { snapshots: 1, situations: 0, artifacts: 0 },
    { snapshots: 0, situations: 15, artifacts: 0 },
    { snapshots: 0, situations: 0, artifacts: 37 },
    { snapshots: 1, situations: 15, artifacts: 0 },
    { snapshots: 1, situations: 0, artifacts: 37 },
    { snapshots: 0, situations: 15, artifacts: 37 },
  ])("rejects partially initialized inventory %#", (counts) => {
    expect(() =>
      baselineImportDisposition({
        exactSnapshotId: counts.snapshots ? "snapshot" : null,
        latestSnapshotId: counts.snapshots ? "snapshot" : null,
        ...counts,
      }),
    ).toThrow(
      "Baseline database is partially initialized; refusing an unsafe import",
    );
  });

  test("rejects an impossible initialized inventory without a snapshot identity", () => {
    expect(() =>
      baselineImportDisposition({
        exactSnapshotId: null,
        latestSnapshotId: null,
        snapshots: 1,
        situations: 15,
        artifacts: 37,
      }),
    ).toThrow("Initialized baseline is missing a repository snapshot");
  });
});
