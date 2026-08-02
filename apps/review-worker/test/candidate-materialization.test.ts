import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "@situation-studio/db";
import {
  bundleWriterOutputSchema,
  candidateBuilderOutputSchema,
} from "@situation-studio/ai-adapters";
import {
  canonicalJson,
  canonicalText,
  parseManagedSituationComponents,
  parseSituationSections,
  PUBLISHABLE_CONTRACT_VERSION,
  PUBLISHABLE_VALIDATION_POLICY_VERSION,
  publishableSituationBundleSchema,
  requiredSituationSections,
  serializeSituationSections,
  sha256,
  validateSituationBundle,
  type SituationBundle,
  type SituationSections,
} from "@situation-studio/domain";
import {
  assertSharedCandidateSnapshot,
  materializeCandidateRevision,
  validateCandidateAuditOutput,
  type CandidateStepRecord,
} from "../src/review";

function fixture() {
  const sections = Object.fromEntries(
    requiredSituationSections.map((section) => [section, `${section} body.`]),
  ) as SituationSections;
  sections["When this guidance fits"] = [
    "Use this for a recurring pattern.",
    "",
    "> **Stop and get support:** use the applicable formal process.",
  ].join("\n");
  sections["If they respond with…"] = [
    "### “Everything is fine.”",
    "",
    "Ask for variation, not a hidden problem.",
    "",
    "### “I don’t know what you want me to say.”",
    "",
    "Own the ambiguity.",
    "",
    "### “Can we skip these?”",
    "",
    "Ask what has made the meetings low-value.",
  ].join("\n");
  const body = serializeSituationSections(sections);
  const bundle: SituationBundle = {
    schemaVersion: "situation-bundle-v1",
    contractVersion: "test",
    validationPolicyVersion: "test",
    situationId: "d7682090-ae7f-442d-9e5e-7f9bd942104b",
    visibility: "PUBLIC",
    metadata: {
      slug: "nested-section-targets",
      title: "Nested section targets",
      description:
        "A practical fixture for safely applying granular candidate changes.",
      stakes: "The candidate must preserve unrelated guidance.",
      primarySkill: "coaching",
      preparationTime: "15 minutes",
      emotionalLoad: "medium",
      pattern: "repeated-pattern",
      scope: "individual",
      tags: ["coaching", "conversation"],
      audience: ["manager"],
      support: [],
      published: "2026-07-01",
      lastReviewed: "2026-07-28",
      author: "studio-editor",
      reviewer: "studio-editor",
      socialHook: "Apply only the intended nested change.",
      campaignCluster: "coaching",
    },
    bodyHash: sha256(canonicalText(body)),
    artifacts: [],
    relationships: [],
    promotion: {},
    contextHashes: [],
  };
  return { body, bundle };
}

function changes(
  overrides: Array<{
    targetKey: string;
    afterBody: string;
  }>,
) {
  return bundleWriterOutputSchema.parse({
    role: "bundle-writer",
    summary: "Apply granular retained changes.",
    findings: [],
    provenance: "candidate-materialization-test",
    candidateEdits: overrides.map((change, index) => ({
      id: [
        "201eb1cb-c6d6-476d-9462-aa560519596e",
        "43eb72bc-86b6-40a5-a18e-e53e5664984c",
        "5307be2d-a58f-4776-8f18-a8039a646584",
      ][index],
      targetKind: "SECTION",
      targetKey: change.targetKey,
      applicationMode: "AUTOMATIC",
      beforeHash: null,
      afterBody: change.afterBody,
      problem: "The retained guidance needs a precise repair.",
      explanation: "Changes only the selected structural target.",
      rationale: "Preserves unrelated content in the parent section.",
      upstreamFindingIds: ["adjudicator:retained-change"],
      writtenByRoleCode: "bundle-writer",
      evidenceRoleCodes: ["adjudicator"],
    })),
  }).candidateEdits;
}

function metadataChanges(
  overrides: Array<{
    targetKey: string;
    afterBody: string;
  }>,
) {
  return bundleWriterOutputSchema.parse({
    role: "bundle-writer",
    summary: "Apply safe metadata replacements.",
    findings: [],
    provenance: "candidate-materialization-test",
    candidateEdits: overrides.map((change, index) => ({
      id: [
        "201eb1cb-c6d6-476d-9462-aa560519596e",
        "43eb72bc-86b6-40a5-a18e-e53e5664984c",
      ][index],
      targetKind: "METADATA",
      targetKey: change.targetKey,
      applicationMode: "AUTOMATIC",
      beforeHash: null,
      afterBody: change.afterBody,
      problem: "The metadata needs a precise replacement.",
      explanation: "Changes only the selected metadata value.",
      rationale: "Preserves every unrelated metadata field.",
      upstreamFindingIds: ["adjudicator:retained-change"],
      writtenByRoleCode: "bundle-writer",
      evidenceRoleCodes: ["adjudicator"],
    })),
  }).candidateEdits;
}

function publishableFixture() {
  const legacy = fixture();
  const sections = parseSituationSections(legacy.body);
  sections["Two-minute practice"] =
    '<PracticeEmbed compact practiceId="listen-first" surface="situation" variant="default" />';
  sections["I have my next move"] =
    '<PreparedAction scenario="nested-section-targets" skill="coaching" />';
  const body = serializeSituationSections(sections);
  const metadata = {
    ...legacy.bundle.metadata,
    sourceReferences: ["source:nvc"],
    relatedSituationIds: ["related-situation", "another-related-situation"],
    practiceId: "listen-first",
    practiceVariant: "default",
    fieldNotePresent: true,
    safetyEscalationNotePresent: true,
    reviewStatus: "human-approved" as const,
  };
  const bundle = publishableSituationBundleSchema.parse({
    schemaVersion: "situation-bundle-v2",
    contractVersion: PUBLISHABLE_CONTRACT_VERSION,
    validationPolicyVersion: PUBLISHABLE_VALIDATION_POLICY_VERSION,
    situationId: legacy.bundle.situationId,
    visibility: "UNPUBLISHED",
    metadata,
    bodyHash: sha256(canonicalText(body)),
    managedComponents: parseManagedSituationComponents(
      "content/situations/nested-section-targets.mdx",
      body,
    ),
    artifacts: [],
    relationships: [
      {
        kind: "PRACTICE",
        logicalId: "practice:listen-first",
        originalLogicalId: "practice:listen-first",
        position: 0,
        contentHash: "b".repeat(64),
        visibility: "GLOBAL",
      },
      {
        kind: "SOURCE",
        logicalId: "source:nvc",
        originalLogicalId: "source:nvc",
        position: 0,
        contentHash: "c".repeat(64),
        visibility: "GLOBAL",
      },
    ],
    promotion: {
      status: "human-review-required",
      canonical: "/situations/nested-section-targets",
      socialDrafts: [metadata.socialHook],
      scenarioQuestion: "What would you do next?",
      pullQuoteIdea: metadata.socialHook,
      utm: { campaign: metadata.campaignCluster, content: "nested_targets" },
      ogPreview: "/situations/nested-section-targets/opengraph-image",
    },
    contextHashes: ["b".repeat(64), "c".repeat(64)],
  });
  return { body, bundle };
}

describe("candidate section-target materialization", () => {
  it("fails closed before a retained v1 review candidate can materialize", async () => {
    const legacy = fixture();
    const validation = assertSharedCandidateSnapshot(
      {} as DatabaseClient,
      legacy,
    );
    await expect(validation).rejects.toMatchObject({
      failureClass: "APPLICATION",
      message: expect.stringMatching(
        /synchronized to a validated v2 revision/iu,
      ),
      retryable: false,
    });
  });

  it("uses the injected exact validator for incremental and final candidates", () => {
    const { body, bundle } = fixture();
    const validated: Array<{ body: string; bundle: unknown }> = [];
    const candidate = materializeCandidateRevision({
      inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
      inputBundleHash: "a".repeat(64),
      bundleManifest: bundle,
      body,
      changes: changes([
        {
          targetKey: "The short answer",
          afterBody: "Name the exact observable pattern before responding.",
        },
      ]),
      candidateValidator: (candidateBundle, candidateBody) => {
        validated.push({ body: candidateBody, bundle: candidateBundle });
        return validateSituationBundle(candidateBundle, candidateBody);
      },
    });

    expect(validated).toHaveLength(2);
    expect(validated.at(-1)).toEqual({
      body: candidate.body,
      bundle: candidate.bundle,
    });
  });

  it("derives stable server mechanics and preserves every v2 publishable field", () => {
    const { body, bundle } = publishableFixture();
    const nextTitle = "A deterministic publishable candidate revision";
    const changeIntents = candidateBuilderOutputSchema.parse({
      role: "candidate-builder",
      summary: "Request narrowly scoped candidate changes.",
      findings: [],
      provenance: "candidate-materialization-test",
      changeIntents: [
        {
          targetKind: "METADATA",
          targetKey: "title",
          afterBody: JSON.stringify(nextTitle),
          problem: "The current title is too broad.",
          explanation: "Names the deterministic candidate focus.",
          rationale: "The title remains valid publishable metadata.",
          upstreamFindingIds: ["critical-review:title"],
          evidenceRoleCodes: ["critical-review"],
        },
        {
          targetKind: "RELATIONSHIP",
          targetKey: "practice:unverified-global",
          afterBody: JSON.stringify({
            logicalId: "practice:unverified-global",
          }),
          problem: "A global relationship might be relevant.",
          explanation: "Leaves the relationship choice to an editor.",
          rationale:
            "Global relationship edits are not exactly publishable yet.",
          upstreamFindingIds: ["critical-review:relationship"],
          evidenceRoleCodes: ["critical-review"],
        },
        {
          targetKind: "SCOPED_VARIANT",
          targetKey: "practice:listen-first#candidate-variant",
          afterBody: "{}",
          problem: "The shared practice may need a scoped variant.",
          explanation: "Retains the idea as a manual suggestion.",
          rationale:
            "The v2 scoped artifact path is not automatically patched.",
          upstreamFindingIds: ["critical-review:scoped-variant"],
          evidenceRoleCodes: ["critical-review"],
        },
      ],
    }).changeIntents;
    const input = {
      inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
      inputBundleHash: "a".repeat(64),
      bundleManifest: bundle,
      body,
      changes: changeIntents,
    };
    const first = materializeCandidateRevision(input);
    const second = materializeCandidateRevision(input);

    expect(first.changes.map((change) => change.id)).toEqual(
      second.changes.map((change) => change.id),
    );
    expect(first.discardedIntents).toEqual([]);
    expect(first.changes).toEqual([
      expect.objectContaining({
        targetKind: "METADATA",
        applicationMode: "AUTOMATIC",
        writtenByRoleCode: "candidate-builder",
        actualBeforeHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
      expect.objectContaining({
        targetKind: "RELATIONSHIP",
        applicationMode: "MANUAL",
        actualBeforeHash: null,
      }),
      expect.objectContaining({
        targetKind: "SCOPED_VARIANT",
        applicationMode: "MANUAL",
      }),
    ]);
    expect(
      first.changes.every((change) => /^[0-9a-f-]{36}$/u.test(change.id)),
    ).toBe(true);
    expect(first.bundle.metadata).toMatchObject({
      title: nextTitle,
      sourceReferences: ["source:nvc"],
      relatedSituationIds: ["related-situation", "another-related-situation"],
      practiceId: "listen-first",
      practiceVariant: "default",
      fieldNotePresent: true,
      safetyEscalationNotePresent: true,
      reviewStatus: "human-approved",
    });
    expect(first.bundle.managedComponents).toEqual(bundle.managedComponents);
    expect(first.bundle.promotion).toEqual(bundle.promotion);
    expect(first.bundle.relationships).toEqual(bundle.relationships);
  });

  it("applies subheading and named-block patches without replacing their parents", () => {
    const { body, bundle } = fixture();
    const candidate = materializeCandidateRevision({
      inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
      inputBundleHash: "a".repeat(64),
      bundleManifest: bundle,
      body,
      changes: changes([
        {
          targetKey: "When this guidance fits#stop-and-get-support",
          afterBody:
            "> **Stop and get support:** explain the limits and follow the applicable process.",
        },
        {
          targetKey:
            "If they respond with…/I don’t know what you want me to say",
          afterBody:
            "Own the ambiguity and explain that no particular disclosure is required.",
        },
        {
          targetKey: "If they respond with…/Can we skip these?",
          afterBody:
            "Ask what has made the meetings low-value and offer legitimate alternatives.",
        },
      ]),
    });
    const parsed = parseSituationSections(candidate.body);
    expect(parsed["When this guidance fits"]).toContain(
      "explain the limits and follow the applicable process",
    );
    expect(parsed["When this guidance fits"]).toContain(
      "Use this for a recurring pattern.",
    );
    expect(parsed["If they respond with…"]).toContain(
      "### “Everything is fine.”",
    );
    expect(parsed["If they respond with…"]).toContain(
      "no particular disclosure is required",
    );
    expect(parsed["If they respond with…"]).toContain(
      "offer legitimate alternatives",
    );
    expect(candidate.changes.map((change) => change.beforeBody)).toEqual([
      "> **Stop and get support:** use the applicable formal process.",
      "Own the ambiguity.",
      "Ask what has made the meetings low-value.",
    ]);
  });

  it("isolates an overlapping patch without discarding the valid change", () => {
    const { body, bundle } = fixture();
    const candidate = materializeCandidateRevision({
      inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
      inputBundleHash: "a".repeat(64),
      bundleManifest: bundle,
      body,
      changes: changes([
        {
          targetKey: "If they respond with…",
          afterBody: "Replace the complete parent.",
        },
        {
          targetKey: "If they respond with…/Can we skip these?",
          afterBody: "Replace only one child.",
        },
      ]),
    });
    expect(candidate.changes).toHaveLength(1);
    expect(candidate.discardedIntents).toEqual([
      expect.objectContaining({
        sourcePosition: 1,
        reason: expect.stringMatching(/overlaps another candidate target/u),
      }),
    ]);
  });

  it("isolates a named-block replacement that drops its label", () => {
    const { body, bundle } = fixture();
    const candidate = materializeCandidateRevision({
      inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
      inputBundleHash: "a".repeat(64),
      bundleManifest: bundle,
      body,
      changes: changes([
        {
          targetKey: "When this guidance fits#stop-and-get-support",
          afterBody: "The label was accidentally removed.",
        },
      ]),
    });
    expect(candidate.changes).toHaveLength(0);
    expect(candidate.discardedIntents[0]?.reason).toMatch(
      /must retain its bold label/u,
    );
  });

  it("normalizes plain title and description replacements as JSON strings", () => {
    const { body, bundle } = fixture();
    const title = "A clearer candidate metadata title";
    const description =
      "A clearer candidate description that remains complete, specific, and safe to apply.";
    const candidate = materializeCandidateRevision({
      inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
      inputBundleHash: "a".repeat(64),
      bundleManifest: bundle,
      body,
      changes: metadataChanges([
        { targetKey: "title", afterBody: title },
        { targetKey: "description", afterBody: description },
      ]),
    });

    expect(candidate.bundle.metadata.title).toBe(title);
    expect(candidate.bundle.metadata.description).toBe(description);
    expect(
      candidate.changes.map(({ targetKey, afterBody }) => ({
        targetKey,
        afterBody,
      })),
    ).toEqual([
      { targetKey: "title", afterBody: canonicalJson(title) },
      { targetKey: "description", afterBody: canonicalJson(description) },
    ]);
  });

  it("rejects malformed JSON for non-string metadata", () => {
    const { body, bundle } = fixture();

    expect(() =>
      materializeCandidateRevision({
        inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
        inputBundleHash: "a".repeat(64),
        bundleManifest: bundle,
        body,
        changes: metadataChanges([
          { targetKey: "tags", afterBody: "coaching, conversation" },
        ]),
      }),
    ).toThrow(/metadata field tags is not valid JSON/u);
  });

  it("downgrades unsupported metadata concepts to manual suggestions", () => {
    const { body, bundle } = fixture();
    const unsupported = bundleWriterOutputSchema.parse({
      role: "bundle-writer",
      summary: "Retain an unsupported metadata suggestion for the editor.",
      findings: [],
      provenance: "candidate-materialization-test",
      candidateEdits: [
        {
          id: "201eb1cb-c6d6-476d-9462-aa560519596e",
          targetKind: "METADATA",
          targetKey: "sourceReferences",
          applicationMode: "AUTOMATIC",
          beforeHash: null,
          afterBody: "one-on-one-lesson",
          problem: "The source reference should be explicit.",
          explanation: "Situation Studio cannot apply this field directly.",
          rationale:
            "The suggestion must remain visible without being applied.",
          upstreamFindingIds: ["adjudicator:retained-change"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["adjudicator"],
        },
      ],
    }).candidateEdits;
    const candidate = materializeCandidateRevision({
      inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
      inputBundleHash: "a".repeat(64),
      bundleManifest: bundle,
      body,
      changes: unsupported,
    });
    expect(candidate.changes[0]).toMatchObject({
      targetKey: "sourceReferences",
      applicationMode: "MANUAL",
      beforeBody: null,
      actualBeforeHash: null,
      afterBody: "one-on-one-lesson",
    });
    expect(candidate.bundle.metadata).not.toHaveProperty("sourceReferences");
  });

  it("isolates an incomplete scoped practice before downstream audits", () => {
    const { body, bundle } = fixture();
    const contextHash = "b".repeat(64);
    bundle.relationships = [
      {
        kind: "PRACTICE",
        logicalId: "practice:listen-first",
        position: 0,
        contentHash: contextHash,
        visibility: "GLOBAL",
      },
    ];
    bundle.contextHashes = [contextHash];
    const scoped = bundleWriterOutputSchema.parse({
      role: "bundle-writer",
      summary: "Create a situation-specific practice.",
      findings: [],
      provenance: "candidate-materialization-test",
      candidateEdits: [
        {
          id: "201eb1cb-c6d6-476d-9462-aa560519596e",
          targetKind: "SCOPED_VARIANT",
          targetKey: "practice:listen-first#silence-in-one-on-one",
          applicationMode: "AUTOMATIC",
          beforeHash: null,
          afterBody: JSON.stringify({
            id: "silence-in-one-on-one",
            title: "Make room after nothing",
            description: "Practice responding without pressure.",
            estimatedTime: "2 minutes",
            rounds: [
              {
                id: "only-round",
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
          }),
          problem: "The shared practice is too broad.",
          explanation: "Scopes the practice to this situation.",
          rationale: "The practice should match the revised guidance.",
          upstreamFindingIds: ["adjudicator:retained-change"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["adjudicator"],
        },
      ],
    }).candidateEdits;

    const candidate = materializeCandidateRevision({
      inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
      inputBundleHash: "a".repeat(64),
      bundleManifest: bundle,
      body,
      changes: scoped,
    });
    expect(candidate.changes).toHaveLength(0);
    expect(candidate.discardedIntents[0]?.reason).toMatch(/rounds/u);
  });

  it("rejects PASS when an upstream blocker has no materialized automatic resolution", () => {
    const { body, bundle } = fixture();
    const candidate = materializeCandidateRevision({
      inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
      inputBundleHash: "a".repeat(64),
      bundleManifest: bundle,
      body,
      changes: [],
    });
    const steps: CandidateStepRecord[] = [
      {
        id: "critical-step",
        ordinal: 2,
        roleCode: "critical-review",
        state: "SUCCEEDED",
        runs: [
          {
            structuredOutput: {
              role: "critical-review",
              summary: "A blocker remains.",
              findings: [
                {
                  id: "unresolved-safety-boundary",
                  severity: "blocking",
                  targetKind: "SECTION",
                  targetKey: "When this guidance fits",
                  summary: "The safety boundary is absent.",
                  rationale: "The advice is unsafe without it.",
                  evidenceRoleCodes: ["critic-nvc"],
                },
              ],
              provenance: "candidate-audit-test",
            },
          },
        ],
      },
    ];
    expect(() =>
      validateCandidateAuditOutput(
        {
          role: "candidate-audit",
          summary: "Incorrectly claims the candidate passes.",
          findings: [],
          provenance: "candidate-audit-test",
          candidateHash: candidate.candidateHash,
          verdict: "PASS",
          blockingFindingIds: [],
        },
        candidate.candidateHash,
        steps,
        candidate,
      ),
    ).toThrow(/omitted unresolved upstream blocker/u);
  });
});
