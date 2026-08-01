import { createHash } from "node:crypto";
import {
  AUTHORED_PRACTICE_ID_MAX_LENGTH,
  PHYSICAL_PRACTICE_ID_MAX_LENGTH,
  assertSafeManagedMdx,
  authoredPracticeIdSchema,
  isSafeManagedMdx,
  physicalPracticeId,
  practiceChoiceSchema as leadershipPracticeChoiceSchema,
  practiceRoundSchema as leadershipPracticeRoundSchema,
  practiceSchema as leadershipPracticeSchema,
} from "@leadership-field-guide/content-contracts";
import { CONTRACT_VERSION as LEADERSHIP_CONTRACT_VERSION } from "@leadership-field-guide/situation-contract";
import { z } from "zod";

export const CONTRACT_VERSION = LEADERSHIP_CONTRACT_VERSION;
export const VALIDATION_POLICY_VERSION = "situation-bundle-policy-v1";

export function canonicalText(value: string): string {
  return `${value.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "")}\n`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export const artifactKinds = [
  "SITUATION",
  "GUIDE",
  "PRACTICE",
  "SOURCE",
  "LESSON_PLAN",
  "PREPARATION_PROMPT",
  "PROMOTION",
] as const;

export const artifactVisibility = [
  "GLOBAL",
  "SITUATION_SCOPED",
  "INTERNAL",
] as const;

export {
  AUTHORED_PRACTICE_ID_MAX_LENGTH,
  PHYSICAL_PRACTICE_ID_MAX_LENGTH,
  assertSafeManagedMdx,
  authoredPracticeIdSchema,
  isSafeManagedMdx,
  physicalPracticeId,
};
export const scopedPracticeChoiceSchema = leadershipPracticeChoiceSchema;
export const scopedPracticeRoundSchema = leadershipPracticeRoundSchema;
export const scopedPracticeSchema = leadershipPracticeSchema;

export const scopedSourceSchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1),
  url: z.url(),
  publisher: z.string().min(1),
  note: z.string().min(1),
});

export function validateScopedArtifactBody(kind: string, body: string) {
  if (!body.trim())
    return {
      valid: false as const,
      errors: ["Scoped artifact content must not be empty."],
    };
  if (kind !== "PRACTICE" && kind !== "SOURCE")
    return { valid: true as const, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      valid: false as const,
      errors: [`Scoped ${kind.toLowerCase()} content must be valid JSON.`],
    };
  }
  const candidate =
    kind === "SOURCE" && Array.isArray(parsed) ? parsed[0] : parsed;
  const result =
    kind === "PRACTICE"
      ? scopedPracticeSchema.safeParse(candidate)
      : scopedSourceSchema.safeParse(candidate);
  if (result.success) return { valid: true as const, errors: [] };
  return {
    valid: false as const,
    errors: result.error.issues.map((issue) => {
      const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    }),
  };
}

export const relationshipSchema = z.object({
  kind: z.string().min(1).max(80),
  logicalId: z.string().min(1).max(240),
  position: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  visibility: z.enum(artifactVisibility),
});

export const bundleArtifactSchema = z.object({
  logicalId: z.string().min(1).max(240),
  kind: z.enum(artifactKinds),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  byteLength: z
    .number()
    .int()
    .nonnegative()
    .max(2 * 1024 * 1024),
  visibility: z.enum(artifactVisibility),
  ownerSituationId: z.uuid().nullable(),
  forkedFromLogicalId: z.string().min(1).max(240).nullable(),
  forkedFromContentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
});

export const situationMetadataSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().min(20).max(300),
  description: z.string().min(50).max(400),
  stakes: z.string().min(30),
  primarySkill: z.string().min(2).max(80),
  preparationTime: z.enum(["5 minutes", "15 minutes", "30 minutes"]),
  emotionalLoad: z.enum(["low", "medium", "high"]),
  pattern: z.enum(["first-occurrence", "emerging-pattern", "repeated-pattern"]),
  scope: z.enum(["individual", "pair", "team"]),
  tags: z.array(z.string().min(1).max(120)).min(2),
  audience: z.array(z.enum(["manager", "technical-lead"])).min(1),
  support: z.array(
    z.enum(["hr", "legal", "safety", "security", "senior-leader"]),
  ),
  published: z.iso.date(),
  lastReviewed: z.iso.date(),
  author: z.string().regex(/^[a-z0-9][a-z0-9-]{1,99}$/u),
  reviewer: z.string().regex(/^[a-z0-9][a-z0-9-]{1,99}$/u),
  socialHook: z.string().min(20),
  campaignCluster: z.string().regex(/^[a-z0-9_]+$/u),
});

export const situationMetadataKeys = Object.freeze(
  Object.keys(situationMetadataSchema.shape),
) as readonly (keyof z.infer<typeof situationMetadataSchema>)[];

export const situationBundleSchema = z.object({
  schemaVersion: z.literal("situation-bundle-v1"),
  contractVersion: z.string().min(1).max(100),
  validationPolicyVersion: z.string().min(1).max(100),
  situationId: z.uuid(),
  visibility: z.enum(["PUBLIC", "RETIRED", "UNPUBLISHED"]),
  metadata: situationMetadataSchema,
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  artifacts: z.array(bundleArtifactSchema),
  relationships: z.array(relationshipSchema),
  promotion: z.record(z.string(), z.unknown()),
  contextHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
});

export type SituationBundle = z.infer<typeof situationBundleSchema>;
export type SituationMetadata = z.infer<typeof situationMetadataSchema>;
export type BundleArtifact = z.infer<typeof bundleArtifactSchema>;

function sortedBundle(bundle: SituationBundle): SituationBundle {
  return {
    ...bundle,
    artifacts: [...bundle.artifacts].sort((left, right) =>
      left.logicalId.localeCompare(right.logicalId),
    ),
    relationships: [...bundle.relationships].sort(
      (left, right) =>
        left.position - right.position ||
        left.kind.localeCompare(right.kind) ||
        left.logicalId.localeCompare(right.logicalId),
    ),
    contextHashes: [...bundle.contextHashes].sort(),
  };
}

export function bundleHash(candidate: SituationBundle): string {
  const bundle = situationBundleSchema.parse(candidate);
  const logicalIds = new Set<string>();
  for (const artifact of bundle.artifacts) {
    if (logicalIds.has(artifact.logicalId))
      throw new Error(`Duplicate bundle artifact ${artifact.logicalId}.`);
    logicalIds.add(artifact.logicalId);
    if (
      artifact.visibility !== "GLOBAL" &&
      (!artifact.ownerSituationId ||
        !artifact.forkedFromLogicalId ||
        !artifact.forkedFromContentHash)
    )
      throw new Error(
        `Scoped artifact ${artifact.logicalId} is missing provenance.`,
      );
    if (artifact.visibility === "GLOBAL" && artifact.ownerSituationId)
      throw new Error(
        `Only scoped artifacts may have an owner: ${artifact.logicalId}.`,
      );
  }
  return sha256(canonicalJson(sortedBundle(bundle)));
}

export const requiredSituationSections = [
  "The short answer",
  "When this guidance fits",
  "1 — See",
  "2 — Choose",
  "3 — Say",
  "If they respond with…",
  "4 — Sustain",
  "Two-minute practice",
  "I have my next move",
  "Field note",
  "Sources and next moves",
] as const;

export type SituationSectionName = (typeof requiredSituationSections)[number];
export type SituationSections = Record<SituationSectionName, string>;

export type SituationSectionTarget =
  | {
      kind: "SECTION";
      section: SituationSectionName;
    }
  | {
      kind: "SUBHEADING";
      section: SituationSectionName;
      subheading: string;
    }
  | {
      kind: "NAMED_BLOCK";
      section: SituationSectionName;
      anchor: string;
    };

const sectionAnchorPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function parseSituationSectionTargetKey(
  targetKey: string,
): SituationSectionTarget | null {
  for (const section of requiredSituationSections) {
    if (targetKey === section) return { kind: "SECTION", section };
    const subheadingPrefix = `${section}/`;
    if (targetKey.startsWith(subheadingPrefix)) {
      const subheading = targetKey.slice(subheadingPrefix.length);
      if (
        subheading.length > 0 &&
        subheading === subheading.trim() &&
        !/[/#\r\n]/u.test(subheading)
      )
        return { kind: "SUBHEADING", section, subheading };
      return null;
    }
    const anchorPrefix = `${section}#`;
    if (targetKey.startsWith(anchorPrefix)) {
      const anchor = targetKey.slice(anchorPrefix.length);
      return sectionAnchorPattern.test(anchor)
        ? { kind: "NAMED_BLOCK", section, anchor }
        : null;
    }
  }
  return null;
}

export type ScopedVariantTarget = {
  logicalId: string;
  variantId: string | null;
};

export function parseScopedVariantTargetKey(
  targetKey: string,
): ScopedVariantTarget | null {
  const separator = targetKey.indexOf("#");
  const logicalId =
    separator < 0 ? targetKey : targetKey.slice(0, separator).trim();
  const variantId =
    separator < 0 ? null : targetKey.slice(separator + 1).trim();
  if (!logicalId || /[\r\n]/u.test(logicalId)) return null;
  if (variantId !== null && !sectionAnchorPattern.test(variantId)) return null;
  return { logicalId, variantId };
}

type ResolvedSituationSectionTarget = {
  target: SituationSectionTarget;
  beforeBody: string;
  replacement: (afterBody: string) => string;
};

function normalizedStructuralLabel(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/^[ "'‘’“”]+|[ "'‘’“”]+$/gu, "")
    .replace(/[.:;!?…]+$/u, "")
    .trim()
    .toLocaleLowerCase("en");
}

function namedBlockAnchor(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/['’]/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function replaceSectionLines(
  lines: string[],
  start: number,
  end: number,
  afterBody: string,
) {
  const prefix = lines.slice(0, start).join("\n").trimEnd();
  const replacement = canonicalText(afterBody).trim();
  const suffix = lines.slice(end).join("\n").trimStart();
  return [prefix, replacement, suffix].filter(Boolean).join("\n\n");
}

function resolveSituationSectionTarget(
  sections: SituationSections,
  targetKey: string,
): ResolvedSituationSectionTarget {
  const target = parseSituationSectionTargetKey(targetKey);
  if (!target)
    throw new Error(`Candidate section target ${targetKey} is invalid.`);
  if (target.kind === "SECTION")
    return {
      target,
      beforeBody: sections[target.section],
      replacement: (afterBody) => canonicalText(afterBody).trim(),
    };

  const lines = canonicalText(sections[target.section]).trimEnd().split("\n");
  if (target.kind === "SUBHEADING") {
    const expected = normalizedStructuralLabel(target.subheading);
    const matches = lines.flatMap((line, index) => {
      const heading = line.match(/^(#{3,6})[ \t]+(.+?)[ \t]*$/u);
      return heading && normalizedStructuralLabel(heading[2] ?? "") === expected
        ? [{ index, depth: heading[1]?.length ?? 3 }]
        : [];
    });
    if (matches.length !== 1)
      throw new Error(
        matches.length === 0
          ? `Candidate subheading ${targetKey} does not exist.`
          : `Candidate subheading ${targetKey} is ambiguous.`,
      );
    const match = matches[0]!;
    const start = match.index + 1;
    let end = lines.length;
    for (let index = start; index < lines.length; index += 1) {
      const heading = lines[index]?.match(/^(#{1,6})[ \t]+/u);
      if (heading && (heading[1]?.length ?? 7) <= match.depth) {
        end = index;
        break;
      }
    }
    return {
      target,
      beforeBody: lines.slice(start, end).join("\n").trim(),
      replacement: (afterBody) =>
        replaceSectionLines(lines, start, end, afterBody),
    };
  }

  const matches = lines.flatMap((line, index) => {
    const label = line.match(/^>[ \t]*\*\*(.+?):\*\*/u)?.[1];
    return label && namedBlockAnchor(label) === target.anchor ? [index] : [];
  });
  if (matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? `Candidate named block ${targetKey} does not exist.`
        : `Candidate named block ${targetKey} is ambiguous.`,
    );
  const start = matches[0]!;
  let end = start + 1;
  while (end < lines.length && /^>/u.test(lines[end] ?? "")) end += 1;
  return {
    target,
    beforeBody: lines.slice(start, end).join("\n").trim(),
    replacement: (afterBody) => {
      const replacement = canonicalText(afterBody).trim();
      const label = replacement.match(/^>[ \t]*\*\*(.+?):\*\*/u)?.[1];
      if (!label || namedBlockAnchor(label) !== target.anchor)
        throw new Error(
          `Candidate named block ${targetKey} must retain its bold label.`,
        );
      return replaceSectionLines(lines, start, end, replacement);
    },
  };
}

export function situationSectionTargetBefore(
  sections: SituationSections,
  targetKey: string,
) {
  return resolveSituationSectionTarget(sections, targetKey).beforeBody;
}

export function applySituationSectionTarget(
  sections: SituationSections,
  targetKey: string,
  afterBody: string,
) {
  const resolved = resolveSituationSectionTarget(sections, targetKey);
  return {
    ...sections,
    [resolved.target.section]: resolved.replacement(afterBody),
  };
}

export function situationSectionTargetsOverlap(
  left: SituationSectionTarget,
  right: SituationSectionTarget,
) {
  if (left.section !== right.section) return false;
  if (left.kind === "SECTION" || right.kind === "SECTION") return true;
  if (left.kind !== right.kind) return false;
  if (left.kind === "SUBHEADING" && right.kind === "SUBHEADING")
    return (
      normalizedStructuralLabel(left.subheading) ===
      normalizedStructuralLabel(right.subheading)
    );
  return (
    left.kind === "NAMED_BLOCK" &&
    right.kind === "NAMED_BLOCK" &&
    left.anchor === right.anchor
  );
}

const headingPattern = /^##[ \t]+(.+?)[ \t]*$/gmu;

export function parseSituationSections(body: string): SituationSections {
  const canonical = canonicalText(body);
  const matches = [...canonical.matchAll(headingPattern)];
  const parsed = new Map<string, string>();
  for (const [index, match] of matches.entries()) {
    const heading = match[1]?.trim() ?? "";
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? canonical.length;
    parsed.set(heading, canonical.slice(contentStart, contentEnd).trim());
  }
  const missing = requiredSituationSections.filter(
    (section) => !parsed.has(section),
  );
  if (missing.length)
    throw new Error(`Missing required sections: ${missing.join(", ")}.`);
  return Object.fromEntries(
    requiredSituationSections.map((section) => [
      section,
      parsed.get(section) ?? "",
    ]),
  ) as SituationSections;
}

export function serializeSituationSections(
  sections: SituationSections,
): string {
  return canonicalText(
    requiredSituationSections
      .map((section) => `## ${section}\n\n${sections[section].trim()}`)
      .join("\n\n"),
  );
}

const unsafeMdx = [
  /^(?:import|export)\s/gmu,
  /<\/?(?:script|style|iframe|object|embed)\b/iu,
  /\bon[A-Z_a-z][\w-]*\s*=/u,
  /javascript\s*:/iu,
] as const;

export type ValidationResult = {
  valid: boolean;
  bundleHash: string | null;
  errors: string[];
};

export function validateSituationBundle(
  candidate: unknown,
  body: string,
): ValidationResult {
  const parsed = situationBundleSchema.safeParse(candidate);
  const errors = parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
  if (
    sha256(canonicalText(body)) !== (parsed.success ? parsed.data.bodyHash : "")
  )
    errors.push("The body hash does not match the canonical MDX bytes.");
  try {
    parseSituationSections(body);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const pattern of unsafeMdx)
    if (pattern.test(body))
      errors.push("The MDX body contains executable content.");
  if (!parsed.success || errors.length)
    return { valid: false, bundleHash: null, errors: [...new Set(errors)] };
  try {
    return { valid: true, bundleHash: bundleHash(parsed.data), errors: [] };
  } catch (error) {
    return {
      valid: false,
      bundleHash: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export type PrimaryStatus =
  "Available" | "Draft saved" | `Checked out by ${string}` | "Retired";

export type ActivityStatus =
  | "Review queued"
  | "Review running"
  | "Publishing"
  | "Publish failed — previous production restored"
  | "Needs refresh"
  | "Recovery required";

export const publicationFailureDetailSchema = z
  .object({
    schemaVersion: z.literal("publication-failure-detail-v1"),
    phase: z.literal("RUNTIME_IDENTITY"),
    source: z.literal("LEADERSHIP_CONTENT_HEALTH"),
    reason: z.enum([
      "HTTP_STATUS",
      "IDENTITY_MISMATCH",
      "UNAVAILABLE",
      "INVALID_RESPONSE",
    ]),
    attempts: z.number().int().min(1).max(100),
    elapsedMs: z.number().int().min(0).max(600_000),
    lastHttpStatus: z.number().int().min(100).max(599).nullable(),
    lastObservedReleaseId: z.uuid().nullable(),
    lastObservedManifestHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict();

export type PublicationFailureDetail = z.infer<
  typeof publicationFailureDetailSchema
>;

export function deriveSituationStatus(input: {
  visibility: "PUBLIC" | "RETIRED" | "UNPUBLISHED";
  checkoutOwner?: string | null;
  draftBundleHash?: string | null;
  productionBundleHash?: string | null;
  activity?: ActivityStatus | null;
}): { primary: PrimaryStatus; activity: ActivityStatus | null } {
  let primary: PrimaryStatus;
  if (input.visibility === "RETIRED") primary = "Retired";
  else if (input.checkoutOwner)
    primary = `Checked out by ${input.checkoutOwner}`;
  else if (
    input.draftBundleHash &&
    input.draftBundleHash !== input.productionBundleHash
  )
    primary = "Draft saved";
  else primary = "Available";
  return { primary, activity: input.activity ?? null };
}

export type PublicationDecision =
  | { kind: "PROCEED"; rebase: boolean }
  | { kind: "NEEDS_REFRESH"; reason: string };

export function publicationConflictDecision(input: {
  draftBaseBundleHash: string | null;
  observedTargetBundleHash: string | null;
  baseReleaseId: string | null;
  observedReleaseId: string;
}): PublicationDecision {
  if (input.draftBaseBundleHash !== input.observedTargetBundleHash)
    return {
      kind: "NEEDS_REFRESH",
      reason: "The target situation changed in production.",
    };
  return {
    kind: "PROCEED",
    rebase: input.baseReleaseId !== input.observedReleaseId,
  };
}

export function createScopedVariant(input: {
  situationId: string;
  kind: BundleArtifact["kind"];
  originalLogicalId: string;
  originalContentHash: string;
  changedBody: string;
}): { artifact: BundleArtifact; body: string } {
  const body = canonicalText(input.changedBody);
  const contentHash = sha256(body);
  const logicalId = `${input.originalLogicalId}:situation:${input.situationId}:${contentHash.slice(0, 12)}`;
  return {
    body,
    artifact: {
      logicalId,
      kind: input.kind,
      contentHash,
      byteLength: new TextEncoder().encode(body).byteLength,
      visibility:
        input.kind === "LESSON_PLAN" || input.kind === "PREPARATION_PROMPT"
          ? "INTERNAL"
          : "SITUATION_SCOPED",
      ownerSituationId: input.situationId,
      forkedFromLogicalId: input.originalLogicalId,
      forkedFromContentHash: input.originalContentHash,
    },
  };
}

export const reviewRoleCodes = [
  "surface-mapper",
  "critic-nvc",
  "critic-negotiation",
  "critic-coaching",
  "critic-team-health",
  "critic-radical-candor",
  "critic-change-systems",
  "critic-manager-tools",
  "issue-register",
  "rebuttal-nvc",
  "rebuttal-negotiation",
  "rebuttal-coaching",
  "rebuttal-team-health",
  "rebuttal-radical-candor",
  "rebuttal-change-systems",
  "rebuttal-manager-tools",
  "adjudicator",
  "teaching-designer",
  "bundle-writer",
  "audit-semantic",
  "audit-teaching-alignment",
  "audit-repository-integrity",
  "audit-page-language",
  "deterministic-validator",
] as const;

export type ReviewRoleCode = (typeof reviewRoleCodes)[number];

export const reviewFailureReasonCodes = [
  "PROVIDER_CAPACITY",
  "PROVIDER_TRANSIENT",
  "PROVIDER_AUTHENTICATION",
  "PROVIDER_OUTPUT_INVALID",
  "CANDIDATE_METADATA_JSON_INVALID",
  "CANDIDATE_OUTPUT_INVALID",
  "CANDIDATE_FINDING_REFERENCE_INVALID",
  "PROPOSAL_MATERIALIZATION_FAILED",
  "REVIEW_EVIDENCE_BUILD_FAILED",
  "REVIEW_INPUT_VALIDATION_FAILED",
  "REVIEW_APPLICATION_FAILED",
] as const;

export type ReviewFailureReasonCode = (typeof reviewFailureReasonCodes)[number];

export const reviewFailurePhases = [
  "RUN_STAGE",
  "BUILD_EVIDENCE",
  "VALIDATE_INPUT",
  "VALIDATE_CANDIDATE",
  "MATERIALIZE_PROPOSAL",
] as const;

export type ReviewFailurePhase = (typeof reviewFailurePhases)[number];

export type ReviewStage = {
  ordinal: number;
  role: ReviewRoleCode;
  dependencies: ReviewRoleCode[];
};

export const reviewStages: readonly ReviewStage[] = reviewRoleCodes.map(
  (role, index) => {
    if (index === 0) return { ordinal: 1, role, dependencies: [] };
    if (index <= 7)
      return {
        ordinal: index + 1,
        role,
        dependencies: ["surface-mapper"],
      };
    if (index === 8)
      return {
        ordinal: 9,
        role,
        dependencies: reviewRoleCodes.slice(1, 8) as ReviewRoleCode[],
      };
    if (index <= 15)
      return {
        ordinal: index + 1,
        role,
        dependencies: [
          "issue-register",
          reviewRoleCodes[index - 8] as ReviewRoleCode,
        ],
      };
    if (index === 16)
      return {
        ordinal: 17,
        role,
        dependencies: reviewRoleCodes.slice(1, 16) as ReviewRoleCode[],
      };
    if (index === 17)
      return { ordinal: 18, role, dependencies: ["adjudicator"] };
    if (index === 18)
      return { ordinal: 19, role, dependencies: ["teaching-designer"] };
    if (index <= 22)
      return {
        ordinal: index + 1,
        role,
        dependencies: ["bundle-writer", "adjudicator", "teaching-designer"],
      };
    return {
      ordinal: 24,
      role,
      dependencies: [
        "audit-semantic",
        "audit-teaching-alignment",
        "audit-repository-integrity",
        "audit-page-language",
      ],
    };
  },
);

export const proposalChangeSchema = z.object({
  id: z.uuid(),
  targetKind: z.enum(["SECTION", "METADATA", "SCOPED_VARIANT", "RELATIONSHIP"]),
  targetKey: z.string().min(1).max(240),
  beforeHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  afterBody: z.string(),
  rationale: z.string().min(1),
});

export type ProposalChange = z.infer<typeof proposalChangeSchema>;

export function applySectionProposal(
  sections: SituationSections,
  change: ProposalChange,
): SituationSections {
  if (
    change.targetKind !== "SECTION" ||
    !requiredSituationSections.includes(
      change.targetKey as SituationSectionName,
    )
  )
    throw new Error("Proposal change does not target a known section.");
  const section = change.targetKey as SituationSectionName;
  if (
    change.beforeHash &&
    sha256(canonicalText(sections[section])) !== change.beforeHash
  )
    throw new Error("Proposal change is stale for the selected section.");
  return { ...sections, [section]: change.afterBody };
}
