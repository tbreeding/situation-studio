import { describe, expect, it } from "vitest";
import { bundleWriterOutputSchema } from "@situation-studio/ai-adapters";
import {
  canonicalJson,
  canonicalText,
  parseSituationSections,
  requiredSituationSections,
  serializeSituationSections,
  sha256,
  type SituationBundle,
  type SituationSections,
} from "@situation-studio/domain";
import { materializeCandidateRevision } from "../src/review";

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

describe("candidate section-target materialization", () => {
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

  it("rejects overlapping whole-section and nested patches", () => {
    const { body, bundle } = fixture();
    expect(() =>
      materializeCandidateRevision({
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
      }),
    ).toThrow(/overlaps another candidate target/u);
  });

  it("requires a named-block replacement to retain its label", () => {
    const { body, bundle } = fixture();
    expect(() =>
      materializeCandidateRevision({
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
      }),
    ).toThrow(/must retain its bold label/u);
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

  it("rejects an incomplete scoped practice before downstream audits", () => {
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

    expect(() =>
      materializeCandidateRevision({
        inputRevisionId: "fb078234-6ef7-43cb-8d7b-3a1dc6610467",
        inputBundleHash: "a".repeat(64),
        bundleManifest: bundle,
        body,
        changes: scoped,
      }),
    ).toThrow(/rounds/u);
  });
});
