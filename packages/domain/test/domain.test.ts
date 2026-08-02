import { describe, expect, it } from "vitest";
import {
  applySectionProposal,
  applyDeterministicSituationChange,
  AUTHORED_PRACTICE_ID_MAX_LENGTH,
  assertSafeManagedMdx,
  bundleHash,
  canonicalText,
  createScopedVariant,
  deterministicSituationChangeTargetBefore,
  deriveSituationStatus,
  parseScopedVariantTargetKey,
  parseSituationSections,
  parseSituationSectionTargetKey,
  publicationConflictDecision,
  physicalPracticeId,
  PUBLISHABLE_CONTRACT_VERSION,
  PUBLISHABLE_VALIDATION_POLICY_VERSION,
  publishableBundleHash,
  publishableSituationBundleSchema,
  scopedPracticeSchema,
  requiredSituationSections,
  reviewStages,
  serializeSituationSections,
  sha256,
  validateScopedArtifactBody,
  validatePublishableSituationBundle,
  type SituationBundle,
  type SituationSections,
  type PublishableSituationBundle,
} from "../src/index";

function sections(): SituationSections {
  return Object.fromEntries(
    requiredSituationSections.map((section) => [section, `${section} body.`]),
  ) as SituationSections;
}

function bundle(): SituationBundle {
  const body = serializeSituationSections(sections());
  return {
    schemaVersion: "situation-bundle-v1",
    contractVersion: "test",
    validationPolicyVersion: "test",
    situationId: "d7682090-ae7f-442d-9e5e-7f9bd942104b",
    visibility: "PUBLIC",
    metadata: {
      slug: "repeatedly-misses-deadlines",
      title: "A teammate repeatedly misses important deadlines",
      description:
        "A careful field guide for addressing a recurring delivery pattern without losing clarity or trust.",
      stakes:
        "The pattern is affecting commitments, trust, and the rest of the team.",
      primarySkill: "feedback",
      preparationTime: "15 minutes",
      emotionalLoad: "high",
      pattern: "repeated-pattern",
      scope: "individual",
      tags: ["feedback", "delivery"],
      audience: ["manager"],
      support: [],
      published: "2026-07-01",
      lastReviewed: "2026-07-23",
      author: "tim-breeding",
      reviewer: "tim-breeding",
      socialHook: "Address the pattern early, clearly, and with room to learn.",
      campaignCluster: "delivery",
    },
    bodyHash: sha256(canonicalText(body)),
    artifacts: [],
    relationships: [],
    promotion: {},
    contextHashes: [],
  };
}

function publishableBundle(): {
  bundle: PublishableSituationBundle;
  body: string;
} {
  const authored = sections();
  authored["Two-minute practice"] =
    '<PracticeEmbed surface="situation" variant="emotion-without-diagnosis" practiceId="listen-first" compact />';
  authored["I have my next move"] =
    '<PreparedAction skill="feedback" scenario="tears-during-difficult-conversation" />';
  const body = serializeSituationSections(authored);
  const candidate = publishableSituationBundleSchema.parse({
    schemaVersion: "situation-bundle-v2",
    contractVersion: PUBLISHABLE_CONTRACT_VERSION,
    validationPolicyVersion: PUBLISHABLE_VALIDATION_POLICY_VERSION,
    situationId: "d7682090-ae7f-442d-9e5e-7f9bd942104b",
    visibility: "PUBLIC",
    metadata: {
      slug: "tears-during-difficult-conversation",
      title: "Someone tears up during a difficult conversation",
      description:
        "Respond to emotion without diagnosing it while keeping a difficult management conversation humane and clear.",
      stakes:
        "The response can either preserve dignity and clarity or make an already difficult conversation feel unsafe.",
      primarySkill: "feedback",
      preparationTime: "15 minutes",
      emotionalLoad: "high",
      pattern: "first-occurrence",
      scope: "individual",
      tags: ["feedback", "emotion"],
      audience: ["manager"],
      support: [],
      published: "2026-07-01",
      lastReviewed: "2026-08-02",
      author: "tim-breeding",
      reviewer: "tim-breeding",
      sourceReferences: ["nvc-observation-feeling-need-request"],
      relatedSituationIds: [
        "delivering-hard-feedback",
        "responding-to-defensiveness",
      ],
      practiceId: "listen-first",
      practiceVariant: "emotion-without-diagnosis",
      fieldNotePresent: true,
      safetyEscalationNotePresent: true,
      socialHook:
        "A pause can honor emotion without abandoning the conversation.",
      campaignCluster: "difficult_conversations",
      reviewStatus: "human-approved",
    },
    bodyHash: sha256(canonicalText(body)),
    managedComponents: {
      practiceEmbed: {
        compact: true,
        practiceId: "listen-first",
        surface: "situation",
        variant: "emotion-without-diagnosis",
      },
      preparedAction: {
        scenario: "tears-during-difficult-conversation",
        skill: "feedback",
      },
    },
    artifacts: [],
    relationships: [
      {
        kind: "PRACTICE",
        logicalId: "practice:listen-first",
        originalLogicalId: "practice:listen-first",
        position: 0,
        contentHash: "a".repeat(64),
        visibility: "GLOBAL",
      },
      {
        kind: "SOURCE",
        logicalId: "source:nvc-observation-feeling-need-request",
        originalLogicalId: "source:nvc-observation-feeling-need-request",
        position: 0,
        contentHash: "b".repeat(64),
        visibility: "GLOBAL",
      },
    ],
    promotion: {
      status: "human-review-required",
      canonical: "/situations/tears-during-difficult-conversation",
      socialDrafts: [
        "A pause can honor emotion without abandoning the conversation.",
      ],
      scenarioQuestion: "What would you do next?",
      pullQuoteIdea: "Make room without making an assumption.",
      utm: {
        campaign: "difficult_conversations",
        content: "tears_during_difficult_conversation",
      },
      ogPreview:
        "/situations/tears-during-difficult-conversation/opengraph-image",
    },
    contextHashes: ["a".repeat(64), "b".repeat(64)],
  });
  return { bundle: candidate, body };
}

describe("domain invariants", () => {
  it("derives the small editorial status model", () => {
    expect(
      deriveSituationStatus({
        visibility: "PUBLIC",
        draftBundleHash: "a",
        productionBundleHash: "b",
      }),
    ).toEqual({ primary: "Draft saved", activity: null });
    expect(
      deriveSituationStatus({
        visibility: "PUBLIC",
        checkoutOwner: "Maya",
        activity: "Review queued",
      }),
    ).toEqual({
      primary: "Checked out by Maya",
      activity: "Review queued",
    });
    expect(deriveSituationStatus({ visibility: "RETIRED" }).primary).toBe(
      "Retired",
    );
  });

  it("canonicalizes bundle order before hashing", () => {
    const left = bundle();
    const right = { ...left, contextHashes: [...left.contextHashes].reverse() };
    expect(bundleHash(left)).toBe(bundleHash(right));
  });

  it("includes every authoritative frontmatter field in v2 revision identity", () => {
    const original = publishableBundle().bundle;
    const changed = publishableSituationBundleSchema.parse({
      ...original,
      metadata: {
        ...original.metadata,
        practiceVariant: "pause-and-name",
      },
    });
    expect(publishableBundleHash(changed)).not.toBe(
      publishableBundleHash(original),
    );
  });

  it.each([
    ["empty sources", { sourceReferences: [] }],
    [
      "duplicate sources",
      {
        sourceReferences: [
          "nvc-observation-feeling-need-request",
          "nvc-observation-feeling-need-request",
        ],
      },
    ],
    [
      "self relationship",
      {
        relatedSituationIds: [
          "tears-during-difficult-conversation",
          "responding-to-defensiveness",
        ],
      },
    ],
  ])(
    "uses Leadership's exact frontmatter policy for %s",
    (_label, metadata) => {
      const original = publishableBundle().bundle;
      expect(
        publishableSituationBundleSchema.safeParse({
          ...original,
          metadata: { ...original.metadata, ...metadata },
        }).success,
      ).toBe(false);
    },
  );

  it("applies a preview and an accepted automatic change through one exact applier", () => {
    const original = publishableBundle();
    const before = deterministicSituationChangeTargetBefore(
      original.bundle,
      original.body,
      { targetKind: "SECTION", targetKey: "The short answer" },
    );
    const change = {
      targetKind: "SECTION" as const,
      targetKey: "The short answer",
      beforeHash: before.beforeHash,
      afterBody: "Name the observation, pause, and ask one grounded question.",
    };
    const preview = applyDeterministicSituationChange({
      bundle: original.bundle,
      body: original.body,
      change,
    });
    const accepted = applyDeterministicSituationChange({
      bundle: original.bundle,
      body: original.body,
      change,
    });
    expect(accepted).toEqual(preview);
    expect(bundleHash(accepted.bundle)).toBe(bundleHash(preview.bundle));
  });

  it("rejects the tears PracticeEmbed mismatch before publication", () => {
    const original = publishableBundle();
    const mismatchedBody = original.body.replace(
      ' variant="emotion-without-diagnosis"',
      "",
    );
    const result = validatePublishableSituationBundle(
      {
        ...original.bundle,
        bodyHash: sha256(canonicalText(mismatchedBody)),
      },
      mismatchedBody,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /PracticeEmbed|managed component properties/u,
    );
  });

  it("rejects a practice identity change that leaves the context relationship behind", () => {
    const original = publishableBundle();
    const changedBody = original.body.replace(
      'practiceId="listen-first"',
      'practiceId="name-the-pattern"',
    );
    const result = validatePublishableSituationBundle(
      {
        ...original.bundle,
        metadata: {
          ...original.bundle.metadata,
          practiceId: "name-the-pattern",
        },
        managedComponents: {
          ...original.bundle.managedComponents,
          practiceEmbed: {
            ...original.bundle.managedComponents.practiceEmbed,
            practiceId: "name-the-pattern",
          },
        },
        bodyHash: sha256(canonicalText(changedBody)),
      },
      changedBody,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/practice relationship/u);
  });

  it("compares managed MDX properties semantically, independent of order", () => {
    const original = publishableBundle();
    expect(
      validatePublishableSituationBundle(original.bundle, original.body),
    ).toEqual({
      valid: true,
      bundleHash: publishableBundleHash(original.bundle),
      errors: [],
    });
  });

  it("round-trips all required editable sections", () => {
    const original = sections();
    const serialized = serializeSituationSections(original);
    expect(parseSituationSections(serialized)).toEqual(original);
  });

  it("executes Leadership's managed-MDX proof safety predicate", () => {
    expect(() =>
      assertSafeManagedMdx(
        '<PracticeEmbed practiceId="listen-first" variant="default" surface="situation" />',
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeManagedMdx(
        '<section {...{["data-" + "leadership-practice-authored-id"]: "forged"}} />',
      ),
    ).toThrow(/dynamic MDX JSX attributes/u);
    expect(() =>
      assertSafeManagedMdx(
        '<div dangerouslySetInnerHTML={{__html: "<section data-" + "leadership-practice-authored-id=forged>"}} />',
      ),
    ).toThrow(/dangerouslySetInnerHTML|dynamic MDX JSX attributes/u);
  });

  it("defines exact, subheading, and named-block section targets", () => {
    expect(parseSituationSectionTargetKey("3 — Say")).toEqual({
      kind: "SECTION",
      section: "3 — Say",
    });
    expect(
      parseSituationSectionTargetKey(
        "If they respond with…/I don’t know what you want me to say",
      ),
    ).toEqual({
      kind: "SUBHEADING",
      section: "If they respond with…",
      subheading: "I don’t know what you want me to say",
    });
    expect(
      parseSituationSectionTargetKey(
        "When this guidance fits#stop-and-get-support",
      ),
    ).toEqual({
      kind: "NAMED_BLOCK",
      section: "When this guidance fits",
      anchor: "stop-and-get-support",
    });
    expect(
      parseSituationSectionTargetKey("Unknown section/subheading"),
    ).toBeNull();
    expect(
      parseSituationSectionTargetKey("3 — Say#Not A Stable Anchor"),
    ).toBeNull();
  });

  it("defines exact and named scoped-variant targets", () => {
    expect(parseScopedVariantTargetKey("practice:listen-first")).toEqual({
      logicalId: "practice:listen-first",
      variantId: null,
    });
    expect(
      parseScopedVariantTargetKey(
        "practice:listen-first#silence-in-one-on-one",
      ),
    ).toEqual({
      logicalId: "practice:listen-first",
      variantId: "silence-in-one-on-one",
    });
    expect(
      parseScopedVariantTargetKey("practice:listen-first#Invalid Variant"),
    ).toBeNull();
  });

  it("applies exactly one proposal section", () => {
    const original = sections();
    const updated = applySectionProposal(original, {
      id: "82d81dd7-a6fb-4a80-9e40-a6e2877f895c",
      targetKind: "SECTION",
      targetKey: "The short answer",
      beforeHash: sha256(canonicalText(original["The short answer"])),
      afterBody: "Updated short answer.",
      rationale: "Clearer opening.",
    });
    expect(updated["The short answer"]).toBe("Updated short answer.");
    expect(updated["1 — See"]).toBe(original["1 — See"]);
  });

  it("forks shared content with owner and base provenance", () => {
    const variant = createScopedVariant({
      situationId: "d7682090-ae7f-442d-9e5e-7f9bd942104b",
      ownerSituationSlug: "scoped-variant-test",
      kind: "PRACTICE",
      originalLogicalId: "practice:listen-first",
      originalContentHash: "a".repeat(64),
      changedBody: "Changed for this situation.",
    });
    expect(variant.artifact.visibility).toBe("SITUATION_SCOPED");
    expect(variant.artifact.forkedFromContentHash).toBe("a".repeat(64));
    expect(variant.artifact).toMatchObject({
      encoding: "UTF8",
      mediaType: "application/json; charset=utf-8",
    });
    expect(variant.artifact.path).toMatch(
      /^content\/scoped\/scoped-variant-test\/practice\/.+\.json$/u,
    );
  });

  it("enforces Leadership's complete scoped-practice contract upstream", () => {
    const practice = {
      id: "silence-in-one-on-one",
      title: "Make room after nothing",
      description: "Practice responding without pressuring disclosure.",
      estimatedTime: "2 minutes",
      rounds: [
        {
          id: "first",
          setup: "The direct report says there is nothing to discuss.",
          prompt: "What do you do?",
          choices: [
            {
              id: "pause",
              label: "Leave room to think.",
              consequenceId: "room",
              consequence: "The person gets processing space.",
              explanation: "A pause reduces pressure.",
              signal: "toward",
            },
            {
              id: "press",
              label: "Demand a topic.",
              consequenceId: "pressure",
              consequence: "The meeting becomes a disclosure test.",
              explanation: "Pressure makes silence costly.",
              signal: "away",
            },
          ],
        },
      ],
    };
    expect(
      validateScopedArtifactBody("PRACTICE", JSON.stringify(practice)),
    ).toMatchObject({
      valid: false,
      errors: [expect.stringContaining("rounds")],
    });
    practice.rounds.push({
      id: "second",
      setup: "The pause ends and there is still no topic.",
      prompt: "What do you do next?",
      choices: practice.rounds[0]!.choices,
    });
    expect(
      validateScopedArtifactBody("PRACTICE", JSON.stringify(practice)),
    ).toEqual({ valid: true, errors: [] });
    for (const candidate of [
      { ...practice, unsupported: true },
      {
        ...practice,
        rounds: [
          { ...practice.rounds[0]!, unsupported: true },
          practice.rounds[1]!,
        ],
      },
      {
        ...practice,
        rounds: [
          {
            ...practice.rounds[0]!,
            choices: [
              { ...practice.rounds[0]!.choices[0]!, unsupported: true },
              practice.rounds[0]!.choices[1]!,
            ],
          },
          practice.rounds[1]!,
        ],
      },
    ])
      expect(
        validateScopedArtifactBody("PRACTICE", JSON.stringify(candidate)),
      ).toMatchObject({ valid: false });
  });

  it("uses Leadership's lossless authored-to-physical practice ID algebra", () => {
    const authored = `a${"b".repeat(AUTHORED_PRACTICE_ID_MAX_LENGTH - 1)}`;
    expect(scopedPracticeSchema.shape.id.safeParse(authored).success).toBe(
      true,
    );
    expect(
      scopedPracticeSchema.shape.id.safeParse(`${authored}c`).success,
    ).toBe(false);
    expect(physicalPracticeId(authored, "a".repeat(64))).toBe(
      `${authored}--${"a".repeat(12)}`,
    );
  });

  it("rebases unrelated releases and blocks target conflicts", () => {
    expect(
      publicationConflictDecision({
        draftBaseBundleHash: "same",
        observedTargetBundleHash: "same",
        baseReleaseId: "old",
        observedReleaseId: "new",
      }),
    ).toEqual({ kind: "PROCEED", rebase: true });
    expect(
      publicationConflictDecision({
        draftBaseBundleHash: "old",
        observedTargetBundleHash: "changed",
        baseReleaseId: "old-release",
        observedReleaseId: "new-release",
      }).kind,
    ).toBe("NEEDS_REFRESH");
  });

  it("defines the bounded four-phase review DAG", () => {
    expect(reviewStages).toEqual([
      { ordinal: 1, role: "context-mapper", dependencies: [] },
      {
        ordinal: 2,
        role: "critical-review",
        dependencies: ["context-mapper"],
      },
      {
        ordinal: 3,
        role: "candidate-builder",
        dependencies: ["critical-review"],
      },
      {
        ordinal: 4,
        role: "candidate-audit",
        dependencies: ["candidate-builder"],
      },
    ]);
  });
});
