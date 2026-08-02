import { describe, expect, it } from "vitest";
import { sha256 } from "@situation-studio/domain";
import { verifyExactScopedArtifactDescriptors } from "../src/publication-preflight";

const situationId = "11111111-1111-4111-8111-111111111111";
const body = '{"id":"practice-1"}\n';
const contentHash = sha256(body);
const logicalId = `practice:practice-1:situation:${situationId}:${contentHash.slice(0, 12)}`;
const mediaType = "application/json; charset=utf-8";
const descriptor = {
  logicalId,
  kind: "PRACTICE",
  contentHash,
  byteLength: new TextEncoder().encode(body).byteLength,
  visibility: "SITUATION_SCOPED",
  ownerSituationId: situationId,
  forkedFromLogicalId: "practice:practice-1",
  forkedFromContentHash: "a".repeat(64),
  path: `content/scoped/coach-through-conflict/practice/${logicalId.replace(/[^a-zA-Z0-9._-]+/gu, "-")}.json`,
  encoding: "UTF8" as const,
  mediaType,
};
const persisted = {
  logicalId,
  kind: "PRACTICE",
  visibility: "SITUATION_SCOPED",
  ownerSituationId: situationId,
  forkedFromLogicalId: "practice:practice-1",
  forkedFromContentHash: "a".repeat(64),
  contentHash,
  content: {
    hash: contentHash,
    encoding: "UTF8" as const,
    mediaType,
    byteLength: descriptor.byteLength,
    textBody: body,
    binaryBody: null,
  },
};

describe("publication preflight scoped evidence", () => {
  it("returns exact UTF-8 bodies only when every descriptor matches storage", () => {
    const result = verifyExactScopedArtifactDescriptors({
      situationId,
      situationSlug: "coach-through-conflict",
      descriptors: [descriptor],
      persisted: [persisted],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bodies.get(logicalId)).toBe(body);
  });

  it.each([
    [
      "descriptor hash",
      { descriptors: [{ ...descriptor, contentHash: "b".repeat(64) }] },
    ],
    [
      "stored body",
      {
        persisted: [
          {
            ...persisted,
            content: { ...persisted.content, textBody: `${body} ` },
          },
        ],
      },
    ],
    [
      "path",
      { descriptors: [{ ...descriptor, path: "content/scoped/wrong.json" }] },
    ],
    [
      "provenance",
      { persisted: [{ ...persisted, forkedFromLogicalId: "practice:other" }] },
    ],
  ])("rejects %s drift before a receipt can be created", (_label, override) => {
    const result = verifyExactScopedArtifactDescriptors({
      situationId,
      situationSlug: "coach-through-conflict",
      descriptors: override.descriptors ?? [descriptor],
      persisted: override.persisted ?? [persisted],
    });
    expect(result.ok).toBe(false);
  });
});
