import { describe, expect, test } from "vitest";
import { buildLineDiff } from "../src/lib/line-diff";

describe("line diff", () => {
  test("pairs replacements and preserves aligned unchanged lines", () => {
    const diff = buildLineDiff("one\ntwo\nthree", "one\nchanged\nthree");

    expect(diff.addedCount).toBe(1);
    expect(diff.removedCount).toBe(1);
    expect(diff.rows).toEqual([
      {
        left: { kind: "unchanged", number: 1, text: "one" },
        right: { kind: "unchanged", number: 1, text: "one" },
      },
      {
        left: { kind: "removed", number: 2, text: "two" },
        right: { kind: "added", number: 2, text: "changed" },
      },
      {
        left: { kind: "unchanged", number: 3, text: "three" },
        right: { kind: "unchanged", number: 3, text: "three" },
      },
    ]);
  });

  test("inserts blank counterparts so later rows remain aligned", () => {
    const diff = buildLineDiff("one\nthree", "one\ntwo\nthree");

    expect(diff.rows[1]).toEqual({
      left: { kind: "empty", number: null, text: "" },
      right: { kind: "added", number: 2, text: "two" },
    });
    expect(diff.rows[2]?.left.number).toBe(2);
    expect(diff.rows[2]?.right.number).toBe(3);
  });

  test("preserves a final newline as an exact empty line", () => {
    const diff = buildLineDiff("one", "one\n");

    expect(diff.addedCount).toBe(1);
    expect(diff.rows.at(-1)).toEqual({
      left: { kind: "empty", number: null, text: "" },
      right: { kind: "added", number: 2, text: "" },
    });
  });
});
