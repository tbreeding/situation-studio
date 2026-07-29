import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PublisherVerificationError,
  runtimeRouteProofFromSituationPage,
  type RuntimeRouteExpectation,
} from "../src/index";

const expectation: RuntimeRouteExpectation = {
  releaseId: "a4d3a125-f0d8-41d3-8f2d-9f4f846c0d66",
  manifestHash: "a".repeat(64),
  situationSlug: "nothing-in-one-on-ones",
  situationBodyHash: "b".repeat(64),
  visibility: "PUBLIC",
  practice: {
    authoredId: "listen-first",
    resolvedLogicalId:
      "practice:listen-first:situation:a4d3a125-f0d8-41d3-8f2d-9f4f846c0d66:cafebabefeed",
    contentHash: "c".repeat(64),
  },
};

const renderProof = "509b4fe2-00cb-4a60-9bdb-5c3c97924e84";

function routeHtml(candidate = expectation, practiceProof = renderProof) {
  return `
    <article class="paperPage"
      data-leadership-release-id="${candidate.releaseId}"
      data-leadership-manifest-hash="${candidate.manifestHash}"
      data-leadership-situation-body-hash="${candidate.situationBodyHash}"
      data-leadership-render-proof="${renderProof}"
    >
      <section class="practiceEngine"
        data-leadership-practice-authored-id="${candidate.practice?.authoredId}"
        data-leadership-practice-logical-id="${candidate.practice?.resolvedLogicalId}"
        data-leadership-practice-content-hash="${candidate.practice?.contentHash}"
        data-leadership-render-proof="${practiceProof}"
      ></section>
    </article>
  `;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("affected Leadership route verification", () => {
  it("accepts exact route, release, body, and scoped-resolver markers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(routeHtml(), { status: 200 })),
    );
    await expect(
      runtimeRouteProofFromSituationPage(
        "http://127.0.0.1:3005/health/content",
        expectation,
      ),
    ).resolves.toEqual({
      code: "AFFECTED_ROUTE_VERIFIED",
      httpStatus: 200,
      observedReleaseId: expectation.releaseId,
      observedManifestHash: expectation.manifestHash,
      observedSituationBodyHash: expectation.situationBodyHash,
      observedPracticeLogicalId: expectation.practice?.resolvedLogicalId,
      observedPracticeContentHash: expectation.practice?.contentHash,
    });
  });

  it("rejects a global-practice fallback even when the route returns 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            routeHtml({
              ...expectation,
              practice: {
                authoredId: "listen-first",
                resolvedLogicalId: "practice:listen-first",
                contentHash: "d".repeat(64),
              },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      runtimeRouteProofFromSituationPage(
        "http://127.0.0.1:3005/health/content",
        expectation,
      ),
    ).rejects.toBeInstanceOf(PublisherVerificationError);
  });

  it("rejects proof attributes injected on raw candidate HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            routeHtml(expectation, "25f6e804-53af-41a9-a14e-2cd7f8e2a28d"),
            { status: 200 },
          ),
      ),
    );
    await expect(
      runtimeRouteProofFromSituationPage(
        "http://127.0.0.1:3005/health/content",
        expectation,
      ),
    ).rejects.toMatchObject({
      code: "AFFECTED_ROUTE_VERIFICATION_FAILED",
    });
  });

  it("requires the retired affected route to return 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    await expect(
      runtimeRouteProofFromSituationPage(
        "http://127.0.0.1:3005/health/content",
        { ...expectation, visibility: "RETIRED", practice: null },
      ),
    ).resolves.toMatchObject({
      code: "AFFECTED_ROUTE_RETIRED",
      httpStatus: 404,
    });
  });

  it("rejects a rendered route failure before a success receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("failed", { status: 500 })),
    );
    await expect(
      runtimeRouteProofFromSituationPage(
        "http://127.0.0.1:3005/health/content",
        expectation,
      ),
    ).rejects.toMatchObject({
      code: "AFFECTED_ROUTE_VERIFICATION_FAILED",
    });
  });
});
