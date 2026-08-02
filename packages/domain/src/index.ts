import { createHash } from "node:crypto";
import {
  AUTHORED_PRACTICE_ID_MAX_LENGTH,
  CONTENT_CONTRACT_VERSION,
  PHYSICAL_PRACTICE_ID_MAX_LENGTH,
  PUBLICATION_COMPILER_DIGEST,
  PUBLICATION_COMPILER_IDENTITY,
  PUBLISHABLE_SITUATION_VALIDATOR_DIGEST,
  PUBLISHABLE_SITUATION_VALIDATOR_IDENTITY,
  assertSafeManagedMdx,
  authoredPracticeIdSchema,
  compilePublishableSituationSnapshot,
  isSafeManagedMdx,
  managedMdxComponentUses,
  parseManagedSituationComponents,
  physicalPracticeId,
  practiceChoiceSchema as leadershipPracticeChoiceSchema,
  practiceRoundSchema as leadershipPracticeRoundSchema,
  practiceSchema as leadershipPracticeSchema,
  publishableManagedComponentsSchema,
  publishablePromotionSchema,
  publishableSituationFrontmatterSchema,
  publishableSituationSnapshotSchema,
  validatePublishableSituationSnapshot,
  type AffectedRouteExpectation,
  type CompilePublishableSituationSnapshotInput,
  type CompilePublishableSituationSnapshotResult,
  type CompiledPublicationCandidate,
  type CompiledSituationTypedProjection,
  type PublicationDiagnostic,
  type PublicationIdentity,
  type PublishableManagedComponents,
  type PublishableSituationSnapshot,
  type ValidatePublishableSituationSnapshotResult,
} from "@leadership-field-guide/content-contracts";
import { CONTRACT_VERSION as LEADERSHIP_CONTRACT_VERSION } from "@leadership-field-guide/situation-contract";
import { z } from "zod";

export const CONTRACT_VERSION = LEADERSHIP_CONTRACT_VERSION;
export const VALIDATION_POLICY_VERSION = "situation-bundle-policy-v1";
export const PUBLISHABLE_CONTRACT_VERSION = CONTENT_CONTRACT_VERSION;
export const PUBLISHABLE_VALIDATION_POLICY_VERSION =
  "publishable-situation-bundle-policy-v2";

export {
  compilePublishableSituationSnapshot,
  managedMdxComponentUses,
  parseManagedSituationComponents,
  publishableSituationSnapshotSchema,
  PUBLICATION_COMPILER_DIGEST,
  PUBLICATION_COMPILER_IDENTITY,
  PUBLISHABLE_SITUATION_VALIDATOR_DIGEST,
  PUBLISHABLE_SITUATION_VALIDATOR_IDENTITY,
  validatePublishableSituationSnapshot,
};
export type {
  AffectedRouteExpectation,
  CompilePublishableSituationSnapshotInput,
  CompilePublishableSituationSnapshotResult,
  CompiledPublicationCandidate,
  CompiledSituationTypedProjection,
  PublicationDiagnostic,
  PublicationIdentity,
  PublishableManagedComponents,
  PublishableSituationSnapshot,
  ValidatePublishableSituationSnapshotResult,
};

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

export const legacySituationBundleSchema = z.object({
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

export type LegacySituationBundle = z.infer<typeof legacySituationBundleSchema>;
export type SituationMetadata = z.infer<typeof situationMetadataSchema>;
export type BundleArtifact = z.infer<typeof bundleArtifactSchema>;

export const publishableBundleRelationshipSchema = relationshipSchema
  .extend({
    kind: z.enum([
      "PRACTICE",
      "GUIDE",
      "SOURCE",
      "LESSON_PLAN",
      "PREPARATION_PROMPT",
    ]),
    originalLogicalId: z.string().min(1).max(240),
  })
  .strict();

export const publishableBundleArtifactSchema = bundleArtifactSchema
  .extend({
    kind: z.enum([
      "PRACTICE",
      "GUIDE",
      "SOURCE",
      "LESSON_PLAN",
      "PREPARATION_PROMPT",
    ]),
    path: z.string().min(1).max(1_000),
    encoding: z.enum(["UTF8", "BINARY"]),
    mediaType: z.string().min(1).max(120),
  })
  .strict();

export const publishableSituationBundleSchema = z
  .object({
    schemaVersion: z.literal("situation-bundle-v2"),
    contractVersion: z.literal(PUBLISHABLE_CONTRACT_VERSION),
    validationPolicyVersion: z.literal(PUBLISHABLE_VALIDATION_POLICY_VERSION),
    situationId: z.uuid(),
    visibility: z.enum(["PUBLIC", "RETIRED", "UNPUBLISHED"]),
    metadata: publishableSituationFrontmatterSchema,
    bodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
    managedComponents: publishableManagedComponentsSchema,
    artifacts: z.array(publishableBundleArtifactSchema),
    relationships: z.array(publishableBundleRelationshipSchema),
    promotion: publishablePromotionSchema.nullable(),
    contextHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
  })
  .strict();

export type PublishableSituationBundle = z.infer<
  typeof publishableSituationBundleSchema
>;
export type PublishableSituationMetadata =
  PublishableSituationBundle["metadata"];
export const publishableSituationMetadataKeys = Object.freeze(
  Object.keys(publishableSituationBundleSchema.shape.metadata.shape),
) as readonly (keyof PublishableSituationMetadata)[];

export const situationBundleSchema = z.union([
  legacySituationBundleSchema,
  publishableSituationBundleSchema,
]);
export type SituationBundle = z.infer<typeof situationBundleSchema>;

function sortedPublishableBundle(
  bundle: PublishableSituationBundle,
): PublishableSituationBundle {
  return {
    ...bundle,
    artifacts: [...bundle.artifacts].sort((left, right) =>
      left.logicalId.localeCompare(right.logicalId),
    ),
    relationships: [...bundle.relationships].sort(
      (left, right) =>
        left.position - right.position ||
        left.kind.localeCompare(right.kind) ||
        left.originalLogicalId.localeCompare(right.originalLogicalId) ||
        left.logicalId.localeCompare(right.logicalId),
    ),
    contextHashes: [...bundle.contextHashes].sort(),
  };
}

export function publishableBundleHash(
  candidate: PublishableSituationBundle,
): string {
  const bundle = publishableSituationBundleSchema.parse(candidate);
  return sha256(canonicalJson(sortedPublishableBundle(bundle)));
}

export function validatePublishableSituationBundle(
  candidate: unknown,
  body: string,
): {
  valid: boolean;
  bundleHash: string | null;
  errors: string[];
} {
  const parsed = publishableSituationBundleSchema.safeParse(candidate);
  const errors = parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      );
  const canonicalBody = canonicalText(body);
  if (sha256(canonicalBody) !== (parsed.success ? parsed.data.bodyHash : ""))
    errors.push(
      "bodyHash: The body hash does not match the canonical MDX bytes.",
    );
  if (parsed.success) {
    let derived: PublishableManagedComponents | undefined;
    try {
      derived = publishableManagedComponentsSchema.parse(
        parseManagedSituationComponents(
          `content/situations/${parsed.data.metadata.slug}.mdx`,
          canonicalBody,
        ),
      );
    } catch (error) {
      errors.push(
        `bodyMdx: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      derived &&
      canonicalJson(derived) !== canonicalJson(parsed.data.managedComponents)
    )
      errors.push(
        "managedComponents: The MDX component properties do not match the authoritative managed-component fields.",
      );
    if (
      parsed.data.metadata.practiceId !==
        parsed.data.managedComponents.practiceEmbed.practiceId ||
      parsed.data.metadata.practiceVariant !==
        parsed.data.managedComponents.practiceEmbed.variant
    )
      errors.push(
        "managedComponents.practiceEmbed: PracticeEmbed must match practiceId and practiceVariant.",
      );
    if (
      parsed.data.metadata.slug !==
        parsed.data.managedComponents.preparedAction.scenario ||
      parsed.data.metadata.primarySkill !==
        parsed.data.managedComponents.preparedAction.skill
    )
      errors.push(
        "managedComponents.preparedAction: PreparedAction must match slug and primarySkill.",
      );
    const contextHashes = parsed.data.relationships.map(
      (relationship) => relationship.contentHash,
    );
    if (
      canonicalJson([...contextHashes].sort()) !==
      canonicalJson([...parsed.data.contextHashes].sort())
    )
      errors.push(
        "contextHashes: Context hashes must exactly match relationship content hashes.",
      );
    const relationshipIdentities = new Set<string>();
    const relationshipPositions = new Set<string>();
    const resolvedLogicalIds = new Set<string>();
    for (const [index, relationship] of parsed.data.relationships.entries()) {
      const identity = `${relationship.kind}\0${relationship.originalLogicalId}`;
      const position = `${relationship.kind}\0${relationship.position}`;
      if (relationshipIdentities.has(identity))
        errors.push(
          `relationships.${index}: Relationship original identity must be unique within its kind.`,
        );
      if (relationshipPositions.has(position))
        errors.push(
          `relationships.${index}.position: Relationship positions must be unique within their kind.`,
        );
      relationshipIdentities.add(identity);
      relationshipPositions.add(position);
      resolvedLogicalIds.add(relationship.logicalId);
      if (
        relationship.visibility === "GLOBAL" &&
        relationship.logicalId !== relationship.originalLogicalId
      )
        errors.push(
          `relationships.${index}.logicalId: A global relationship must resolve to its original logical ID.`,
        );
      if (relationship.visibility !== "GLOBAL") {
        const artifact = parsed.data.artifacts.find(
          (candidate) => candidate.logicalId === relationship.logicalId,
        );
        if (!artifact)
          errors.push(
            `relationships.${index}.logicalId: A scoped relationship requires its exact artifact descriptor.`,
          );
        else if (
          artifact.kind !== relationship.kind ||
          artifact.contentHash !== relationship.contentHash ||
          artifact.visibility !== relationship.visibility ||
          artifact.ownerSituationId !== parsed.data.situationId ||
          artifact.forkedFromLogicalId !== relationship.originalLogicalId
        )
          errors.push(
            `relationships.${index}: The scoped relationship and artifact descriptor do not match.`,
          );
      }
    }
    const practiceRelationships = parsed.data.relationships.filter(
      (relationship) => relationship.kind === "PRACTICE",
    );
    if (practiceRelationships.length !== 1)
      errors.push(
        `relationships: A publishable draft requires exactly one practice relationship; found ${practiceRelationships.length}.`,
      );
    if (
      practiceRelationships[0] &&
      practiceRelationships[0].originalLogicalId !==
        `practice:${parsed.data.metadata.practiceId}`
    )
      errors.push(
        "relationships: The practice relationship must match metadata.practiceId.",
      );
    if (
      !parsed.data.relationships.some(
        (relationship) => relationship.kind === "SOURCE",
      )
    )
      errors.push(
        "relationships: A publishable draft requires at least one source relationship.",
      );
    for (const [index, artifact] of parsed.data.artifacts.entries()) {
      if (
        artifact.visibility === "GLOBAL" ||
        artifact.ownerSituationId !== parsed.data.situationId ||
        !artifact.forkedFromLogicalId ||
        !artifact.forkedFromContentHash
      )
        errors.push(
          `artifacts.${index}: A publishable bundle artifact must be situation-owned with complete provenance.`,
        );
      if (!resolvedLogicalIds.has(artifact.logicalId))
        errors.push(
          `artifacts.${index}.logicalId: Every scoped artifact must be selected by a relationship.`,
        );
    }
    if (parsed.data.visibility === "PUBLIC" && !parsed.data.promotion)
      errors.push("promotion: A public situation requires a promotion packet.");
    if (parsed.data.visibility === "RETIRED" && parsed.data.promotion)
      errors.push(
        "promotion: A retired situation must omit its promotion packet.",
      );
  }
  if (!parsed.success || errors.length)
    return { valid: false, bundleHash: null, errors: [...new Set(errors)] };
  try {
    return {
      valid: true,
      bundleHash: bundleHash(parsed.data),
      errors: [],
    };
  } catch (error) {
    return {
      valid: false,
      bundleHash: null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function toPublishableSituationSnapshot(input: {
  bundle: PublishableSituationBundle;
  body: string;
  scopedArtifactBodies: ReadonlyMap<string, string>;
}): PublishableSituationSnapshot {
  const bundle = publishableSituationBundleSchema.parse(input.bundle);
  const validation = validatePublishableSituationBundle(bundle, input.body);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  if (bundle.visibility === "UNPUBLISHED")
    throw new Error(
      "An unpublished draft needs an explicit PUBLIC or RETIRED publication intent.",
    );
  return publishableSituationSnapshotSchema.parse({
    schemaVersion: "publishable-situation-snapshot-v1",
    situationId: bundle.situationId,
    visibility: bundle.visibility,
    frontmatter: bundle.metadata,
    bodyMdx: canonicalText(input.body),
    managedComponents: bundle.managedComponents,
    relationships: bundle.relationships.map((relationship) => ({
      kind: relationship.kind,
      originalLogicalId: relationship.originalLogicalId,
      resolvedLogicalId: relationship.logicalId,
      position: relationship.position,
      contentHash: relationship.contentHash,
      visibility: relationship.visibility,
    })),
    scopedArtifacts: bundle.artifacts.map((artifact) => {
      const scopedBody = input.scopedArtifactBodies.get(artifact.logicalId);
      if (scopedBody === undefined)
        throw new Error(
          `Scoped artifact ${artifact.logicalId} is missing its exact body.`,
        );
      return {
        logicalId: artifact.logicalId,
        type: artifact.kind,
        path: artifact.path,
        body: scopedBody,
        visibility: artifact.visibility,
        ownerSituationSlug: bundle.metadata.slug,
        forkedFromLogicalId: artifact.forkedFromLogicalId,
        forkedFromContentHash: artifact.forkedFromContentHash,
      };
    }),
    promotion: bundle.promotion,
  });
}

export type ScopedArtifactDescriptorEvidence = {
  logicalId: string;
  kind: string;
  contentHash: string;
  byteLength: number;
  visibility: string;
  ownerSituationId: string | null;
  forkedFromLogicalId: string | null;
  forkedFromContentHash: string | null;
  path: string;
  encoding: "UTF8" | "BINARY";
  mediaType: string;
};

export type PersistedScopedArtifactEvidence = {
  logicalId: string;
  kind: string;
  visibility: string;
  ownerSituationId: string;
  forkedFromLogicalId: string;
  forkedFromContentHash: string;
  contentHash: string;
  content: {
    hash: string;
    encoding: "UTF8" | "BINARY";
    mediaType: string;
    byteLength: number;
    textBody: string | null;
    binaryBody?: Uint8Array | null;
  };
};

function publishableScopedArtifactPath(input: {
  slug: string;
  kind: string;
  logicalId: string;
  mediaType: string;
}) {
  const identity = input.logicalId
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const extension = input.mediaType.startsWith("application/json")
    ? "json"
    : "mdx";
  return `content/scoped/${input.slug}/${input.kind.toLowerCase()}/${identity}.${extension}`;
}

export function verifyExactScopedArtifactDescriptors(input: {
  situationId: string;
  situationSlug: string;
  descriptors: readonly ScopedArtifactDescriptorEvidence[];
  persisted: readonly PersistedScopedArtifactEvidence[];
}):
  | { ok: true; bodies: ReadonlyMap<string, string> }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const persistedByLogicalId = new Map(
    input.persisted.map((artifact) => [artifact.logicalId, artifact]),
  );
  const bodies = new Map<string, string>();

  if (input.persisted.length !== input.descriptors.length)
    errors.push(
      `Expected ${input.descriptors.length} retained scoped artifacts; found ${input.persisted.length}.`,
    );

  for (const descriptor of input.descriptors) {
    const artifact = persistedByLogicalId.get(descriptor.logicalId);
    if (!artifact) {
      errors.push(
        `${descriptor.logicalId}: retained scoped artifact is missing.`,
      );
      continue;
    }
    const body = artifact.content.textBody;
    const actualByteLength =
      body === null ? null : new TextEncoder().encode(body).byteLength;
    const actualHash = body === null ? null : sha256(body);
    const expectedPath = publishableScopedArtifactPath({
      slug: input.situationSlug,
      kind: descriptor.kind,
      logicalId: descriptor.logicalId,
      mediaType: descriptor.mediaType,
    });
    const mismatches = [
      artifact.ownerSituationId !== input.situationId ||
      descriptor.ownerSituationId !== input.situationId
        ? "ownerSituationId"
        : null,
      artifact.kind !== descriptor.kind ? "kind" : null,
      artifact.visibility !== descriptor.visibility ? "visibility" : null,
      artifact.forkedFromLogicalId !== descriptor.forkedFromLogicalId
        ? "forkedFromLogicalId"
        : null,
      artifact.forkedFromContentHash !== descriptor.forkedFromContentHash
        ? "forkedFromContentHash"
        : null,
      artifact.contentHash !== descriptor.contentHash ||
      artifact.content.hash !== descriptor.contentHash ||
      actualHash !== descriptor.contentHash
        ? "contentHash"
        : null,
      artifact.content.encoding !== descriptor.encoding ||
      descriptor.encoding !== "UTF8"
        ? "encoding"
        : null,
      artifact.content.mediaType !== descriptor.mediaType ? "mediaType" : null,
      artifact.content.byteLength !== descriptor.byteLength ||
      actualByteLength !== descriptor.byteLength
        ? "byteLength"
        : null,
      descriptor.path !== expectedPath ? "path" : null,
      body === null || artifact.content.binaryBody != null ? "body" : null,
    ].filter((field): field is string => field !== null);
    if (mismatches.length)
      errors.push(
        `${descriptor.logicalId}: persisted scoped artifact differs in ${mismatches.join(", ")}.`,
      );
    else if (body !== null) bodies.set(descriptor.logicalId, body);
  }

  return errors.length ? { ok: false, errors } : { ok: true, bodies };
}

function sortedBundle(bundle: SituationBundle): SituationBundle {
  if (bundle.schemaVersion === "situation-bundle-v2")
    return sortedPublishableBundle(bundle);
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
  if (
    candidate &&
    typeof candidate === "object" &&
    (candidate as { schemaVersion?: unknown }).schemaVersion ===
      "situation-bundle-v2"
  )
    return validatePublishableSituationBundle(candidate, body);
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
  ownerSituationSlug: string;
  kind: PublishableSituationBundle["artifacts"][number]["kind"];
  originalLogicalId: string;
  originalContentHash: string;
  changedBody: string;
}): {
  artifact: PublishableSituationBundle["artifacts"][number];
  body: string;
} {
  const body = canonicalText(input.changedBody);
  const contentHash = sha256(body);
  const logicalId = `${input.originalLogicalId}:situation:${input.situationId}:${contentHash.slice(0, 12)}`;
  const identity = logicalId
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const json = input.kind === "PRACTICE" || input.kind === "SOURCE";
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
      path: `content/scoped/${input.ownerSituationSlug}/${input.kind.toLowerCase()}/${identity}.${json ? "json" : "mdx"}`,
      encoding: "UTF8",
      mediaType: json
        ? "application/json; charset=utf-8"
        : "text/mdx; charset=utf-8",
    },
  };
}

export type DeterministicSituationChange = {
  targetKind: "SECTION" | "METADATA" | "SCOPED_VARIANT";
  targetKey: string;
  beforeHash: string | null;
  afterBody: string;
};

export class DeterministicChangeApplicationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "STALE_SUGGESTION"
      | "INVALID_SUGGESTION"
      | "UNSUPPORTED_SUGGESTION" = "INVALID_SUGGESTION",
  ) {
    super(message);
  }
}

export function normalizeSituationSectionReplacement(
  targetKey: string,
  replacement: string,
) {
  const normalized = canonicalText(replacement);
  const lines = normalized.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const heading = firstLine.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim();
  if (heading !== targetKey) return normalized;
  return canonicalText(lines.slice(1).join("\n").trimStart());
}

export function deterministicSituationChangeTargetBefore(
  bundleInput: SituationBundle,
  body: string,
  change: Pick<DeterministicSituationChange, "targetKind" | "targetKey">,
) {
  const bundle = situationBundleSchema.parse(bundleInput);
  if (change.targetKind === "SECTION") {
    const beforeBody = situationSectionTargetBefore(
      parseSituationSections(body),
      change.targetKey,
    );
    return {
      beforeBody,
      beforeHash: sha256(canonicalText(beforeBody)),
    };
  }
  if (change.targetKind === "METADATA") {
    if (!(change.targetKey in bundle.metadata))
      return { beforeBody: null, beforeHash: null };
    const beforeBody = canonicalJson(
      bundle.metadata[change.targetKey as keyof typeof bundle.metadata],
    );
    return { beforeBody, beforeHash: sha256(beforeBody) };
  }
  const target = parseScopedVariantTargetKey(change.targetKey);
  const relationship = target
    ? bundle.relationships.find(
        (candidate) => candidate.logicalId === target.logicalId,
      )
    : undefined;
  if (!target || !relationship) return { beforeBody: null, beforeHash: null };
  return {
    beforeBody: canonicalJson(relationship),
    beforeHash: relationship.contentHash,
  };
}

export function proposalPreservesManagedMdxComponents(
  before: string,
  after: string,
) {
  try {
    return (
      canonicalJson(managedMdxComponentUses("proposal before", before)) ===
      canonicalJson(managedMdxComponentUses("proposal after", after))
    );
  } catch {
    return false;
  }
}

export function applyDeterministicSituationChange(input: {
  bundle: SituationBundle;
  body: string;
  change: DeterministicSituationChange;
}): {
  bundle: SituationBundle;
  body: string;
  scopedVariant: ReturnType<typeof createScopedVariant> | null;
} {
  let bundle = situationBundleSchema.parse(input.bundle);
  let body = canonicalText(input.body);
  const before = deterministicSituationChangeTargetBefore(
    bundle,
    body,
    input.change,
  );
  if (
    before.beforeHash === null ||
    before.beforeHash !== input.change.beforeHash
  )
    throw new DeterministicChangeApplicationError(
      `${input.change.targetKey} changed after this review.`,
      "STALE_SUGGESTION",
    );

  if (input.change.targetKind === "SECTION") {
    const replacement = normalizeSituationSectionReplacement(
      input.change.targetKey,
      input.change.afterBody,
    );
    if (
      before.beforeBody === null ||
      !proposalPreservesManagedMdxComponents(before.beforeBody, replacement)
    )
      throw new DeterministicChangeApplicationError(
        `Managed MDX components cannot change through section suggestion ${input.change.targetKey}.`,
      );
    body = serializeSituationSections(
      applySituationSectionTarget(
        parseSituationSections(body),
        input.change.targetKey,
        replacement,
      ),
    );
    bundle = situationBundleSchema.parse({
      ...bundle,
      bodyHash: sha256(canonicalText(body)),
    });
    return { bundle, body, scopedVariant: null };
  }

  if (input.change.targetKind === "METADATA") {
    let replacement: unknown;
    try {
      replacement = JSON.parse(input.change.afterBody);
    } catch {
      throw new DeterministicChangeApplicationError(
        `Metadata suggestion ${input.change.targetKey} is not valid JSON.`,
      );
    }
    const metadata =
      bundle.schemaVersion === "situation-bundle-v2"
        ? publishableSituationBundleSchema.shape.metadata.parse({
            ...bundle.metadata,
            [input.change.targetKey]: replacement,
          })
        : situationMetadataSchema.parse({
            ...bundle.metadata,
            [input.change.targetKey]: replacement,
          });
    bundle = situationBundleSchema.parse({ ...bundle, metadata });
    return { bundle, body, scopedVariant: null };
  }

  const target = parseScopedVariantTargetKey(input.change.targetKey);
  const relationship = target
    ? bundle.relationships.find(
        (candidate) => candidate.logicalId === target.logicalId,
      )
    : undefined;
  if (
    !target ||
    !relationship ||
    ![
      "GUIDE",
      "PRACTICE",
      "SOURCE",
      "LESSON_PLAN",
      "PREPARATION_PROMPT",
    ].includes(relationship.kind)
  )
    throw new DeterministicChangeApplicationError(
      `Scoped suggestion ${input.change.targetKey} cannot be safely applied.`,
    );
  if (target.variantId) {
    let replacement: unknown;
    try {
      replacement = JSON.parse(input.change.afterBody);
    } catch {
      throw new DeterministicChangeApplicationError(
        `Scoped suggestion ${input.change.targetKey} is not valid JSON.`,
      );
    }
    if (
      !replacement ||
      typeof replacement !== "object" ||
      (replacement as { id?: unknown }).id !== target.variantId
    )
      throw new DeterministicChangeApplicationError(
        `Scoped suggestion ${input.change.targetKey} must retain its artifact ID.`,
      );
  }
  const scopedValidation = validateScopedArtifactBody(
    relationship.kind,
    input.change.afterBody,
  );
  if (!scopedValidation.valid)
    throw new DeterministicChangeApplicationError(
      `Scoped suggestion ${input.change.targetKey} is invalid: ${scopedValidation.errors.join(" ")}`,
    );
  const scopedVariant = createScopedVariant({
    situationId: bundle.situationId,
    ownerSituationSlug: bundle.metadata.slug,
    kind: relationship.kind as
      "GUIDE" | "PRACTICE" | "SOURCE" | "LESSON_PLAN" | "PREPARATION_PROMPT",
    originalLogicalId: relationship.logicalId,
    originalContentHash: relationship.contentHash,
    changedBody: input.change.afterBody,
  });
  const relationships = bundle.relationships.map((candidate) =>
    candidate.logicalId === relationship.logicalId
      ? {
          ...candidate,
          logicalId: scopedVariant.artifact.logicalId,
          contentHash: scopedVariant.artifact.contentHash,
          visibility: scopedVariant.artifact.visibility,
        }
      : candidate,
  );
  bundle = situationBundleSchema.parse({
    ...bundle,
    artifacts: [
      ...bundle.artifacts.filter(
        (artifact) => artifact.logicalId !== relationship.logicalId,
      ),
      scopedVariant.artifact,
    ],
    relationships,
    contextHashes: relationships.map((candidate) => candidate.contentHash),
  });
  return { bundle, body, scopedVariant };
}

export const reviewRoleCodes = [
  "context-mapper",
  "critical-review",
  "candidate-builder",
  "candidate-audit",
] as const;

/**
 * Role codes retained only so an already-created review can finish after a
 * rolling worker upgrade. New jobs must use `reviewRoleCodes`.
 */
export const legacyReviewRoleCodes = [
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
export type LegacyReviewRoleCode = (typeof legacyReviewRoleCodes)[number];

export const reviewFailureReasonCodes = [
  "PROVIDER_CAPACITY",
  "PROVIDER_TRANSIENT",
  "PROVIDER_AUTHENTICATION",
  "PROVIDER_OUTPUT_INVALID",
  "CANDIDATE_METADATA_JSON_INVALID",
  "CANDIDATE_OUTPUT_INVALID",
  "CANDIDATE_FINDING_REFERENCE_INVALID",
  "CANDIDATE_AUDIT_REVISE",
  "PROPOSAL_MATERIALIZATION_FAILED",
  "REVIEW_EVIDENCE_BUILD_FAILED",
  "REVIEW_INPUT_VALIDATION_FAILED",
  "REVIEW_JOB_DEADLINE_EXCEEDED",
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

export const reviewStages: readonly ReviewStage[] = [
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
];

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
