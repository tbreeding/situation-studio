import { describe, expect, it } from "vitest";
import {
  renderedComparisonLines,
  synchronizedScrollTop,
} from "@/components/rendered-comparison";

function lineNumbers(lines: ReadonlySet<number>) {
  return [...lines].sort((left, right) => left - right);
}

describe("rendered comparison line mapping", () => {
  it("marks replaced source lines on their respective rendered sides", () => {
    const result = renderedComparisonLines(
      "## The short answer\n\nOld guidance.\n\n## Next\n\nSame.\n",
      "## The short answer\n\nNew guidance.\n\n## Next\n\nSame.\n",
    );

    expect(lineNumbers(result.production)).toEqual([2]);
    expect(lineNumbers(result.draft)).toEqual([2]);
  });

  it("keeps added lines aligned with their draft source positions", () => {
    const result = renderedComparisonLines(
      "## First\r\n\r\nSame.\r\n\r\n## Second\r\n\r\nSame.\r\n",
      "## First\n\nSame.\n\n- Added point.\n\n## Second\n\nSame.\n",
    );

    expect(lineNumbers(result.production)).toEqual([]);
    expect(lineNumbers(result.draft)).toEqual([4, 5]);
  });

  it("does not annotate byte-identical rendered source", () => {
    const body = "## The short answer\n\nSame guidance.\n";
    const result = renderedComparisonLines(body, body);

    expect(lineNumbers(result.production)).toEqual([]);
    expect(lineNumbers(result.draft)).toEqual([]);
  });
});

describe("rendered comparison scrolling", () => {
  it("keeps panes at the same proportional reading position", () => {
    expect(synchronizedScrollTop(432, 684, 704)).toBeCloseTo(444.63, 2);
    expect(synchronizedScrollTop(684, 684, 704)).toBe(704);
  });

  it("clamps positions and handles a pane with no scroll range", () => {
    expect(synchronizedScrollTop(-10, 100, 200)).toBe(0);
    expect(synchronizedScrollTop(120, 100, 200)).toBe(200);
    expect(synchronizedScrollTop(20, 0, 200)).toBe(0);
  });
});
