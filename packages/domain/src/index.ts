import { createHash } from "node:crypto";
import { z } from "zod";

export const permissions = [
  "situation.create",
  "draft.update",
  "ai.run",
  "proposal.review",
  "publication.approve",
  "publication.publish",
  "situation.archive",
  "user.manage",
  "system.admin",
] as const;

export type Permission = (typeof permissions)[number];
export type RoleCode = "ADMINISTRATOR" | "EDITOR" | "REVIEWER" | "PUBLISHER";

export const rolePermissions: Readonly<
  Record<RoleCode, readonly Permission[]>
> = {
  ADMINISTRATOR: permissions,
  EDITOR: ["situation.create", "draft.update", "ai.run"],
  REVIEWER: ["proposal.review", "publication.approve"],
  PUBLISHER: ["publication.publish", "situation.archive"],
};

export function effectivePermissions(
  roles: readonly RoleCode[],
  grants: readonly Permission[] = [],
): Set<Permission> {
  return new Set([
    ...roles.flatMap((role) => rolePermissions[role]),
    ...grants,
  ]);
}

export type SituationLifecycle = "UNPUBLISHED" | "ACTIVE" | "ARCHIVED";
export const situationLifecycleTransitions: Readonly<
  Record<SituationLifecycle, readonly SituationLifecycle[]>
> = {
  UNPUBLISHED: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["ARCHIVED"],
  ARCHIVED: ["UNPUBLISHED", "ACTIVE"],
};

export type DraftState =
  | "DISCOVERY"
  | "DRAFTING"
  | "READY_FOR_AI_REVIEW"
  | "AI_REVIEW_QUEUED"
  | "AI_REVIEW_RUNNING"
  | "PROPOSAL_READY"
  | "HUMAN_REVIEW"
  | "CHANGES_REQUESTED"
  | "APPROVED"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED";

export const draftTransitions: Readonly<
  Record<DraftState, readonly DraftState[]>
> = {
  DISCOVERY: ["DRAFTING", "READY_FOR_AI_REVIEW"],
  DRAFTING: ["READY_FOR_AI_REVIEW", "HUMAN_REVIEW"],
  READY_FOR_AI_REVIEW: ["AI_REVIEW_QUEUED", "DRAFTING"],
  AI_REVIEW_QUEUED: ["AI_REVIEW_RUNNING", "DRAFTING", "FAILED"],
  AI_REVIEW_RUNNING: ["PROPOSAL_READY", "FAILED", "DRAFTING"],
  PROPOSAL_READY: ["HUMAN_REVIEW", "CHANGES_REQUESTED", "DRAFTING"],
  HUMAN_REVIEW: ["APPROVED", "CHANGES_REQUESTED", "DRAFTING"],
  CHANGES_REQUESTED: ["DRAFTING", "READY_FOR_AI_REVIEW", "HUMAN_REVIEW"],
  APPROVED: ["PUBLISHING", "DRAFTING"],
  PUBLISHING: ["PUBLISHED", "FAILED", "APPROVED"],
  PUBLISHED: ["DRAFTING"],
  FAILED: ["DISCOVERY", "DRAFTING", "READY_FOR_AI_REVIEW", "APPROVED"],
};

export function canTransition<T extends string>(
  table: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): boolean {
  return table[from].includes(to);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

export function canonicalText(value: string): string {
  return `${value.replace(/\r\n?/g, "\n").replace(/\n+$/u, "")}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export const artifactTypes = [
  "SITUATION",
  "GUIDE",
  "PRACTICE",
  "LESSON_PLAN",
  "PREPARATION_PROMPT",
  "TOOL",
  "SOURCE",
  "AUTHOR",
  "ROUTE",
  "VALIDATOR",
] as const;

export type ArtifactType = (typeof artifactTypes)[number];

const approvedRoots = [
  "content/situations/",
  "content/guides/",
  "content/practices/",
  "content/bibliography/",
  "content/authors/",
  "sourceMaterial/leadership-workshops-master/",
  "lib/tools.ts",
] as const;

export function isApprovedArtifactPath(candidate: string): boolean {
  if (
    !candidate ||
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    candidate.includes("\0")
  )
    return false;
  const segments = candidate.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    return false;
  if (!/\.(?:mdx|md|json|ts|csv)$/u.test(candidate)) return false;
  return approvedRoots.some(
    (root) => candidate === root || candidate.startsWith(root),
  );
}

export const bundleArtifactSchema = z.object({
  logicalId: z.string().min(1),
  type: z.enum(artifactTypes),
  path: z.string().refine(isApprovedArtifactPath),
  baseHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  candidateHash: z.string().regex(/^[a-f0-9]{64}$/u),
  changeKind: z.enum(["ADD", "MODIFY", "DELETE", "NO_CHANGE"]),
  noChangeRationale: z.string().min(1).nullable(),
});

export const bundleManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  situationId: z.string().min(1),
  revision: z.number().int().positive(),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  baseManifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  briefHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  graphHash: z.string().regex(/^[a-f0-9]{64}$/u),
  artifacts: z.array(bundleArtifactSchema).min(1),
  relationshipChanges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      type: z.string(),
      action: z.enum(["ADD", "REMOVE"]),
    }),
  ),
});

export type BundleManifest = z.infer<typeof bundleManifestSchema>;

export function canonicalBundleHash(manifest: BundleManifest): string {
  const parsed = bundleManifestSchema.parse(manifest);
  const logicalIds = new Set<string>();
  const paths = new Set<string>();
  for (const artifact of parsed.artifacts) {
    if (logicalIds.has(artifact.logicalId))
      throw new Error(`Duplicate logical artifact: ${artifact.logicalId}`);
    if (paths.has(artifact.path))
      throw new Error(`Duplicate artifact path: ${artifact.path}`);
    if (artifact.changeKind === "NO_CHANGE" && !artifact.noChangeRationale)
      throw new Error(`No-change rationale required: ${artifact.logicalId}`);
    logicalIds.add(artifact.logicalId);
    paths.add(artifact.path);
  }
  return sha256(
    canonicalJson({
      ...parsed,
      artifacts: [...parsed.artifacts].sort((a, b) =>
        a.logicalId.localeCompare(b.logicalId),
      ),
    }),
  );
}

export const briefFieldNames = [
  "observedProblem",
  "audience",
  "managerRole",
  "knownContext",
  "assumptions",
  "unknowns",
  "desiredOutcome",
  "safetyEscalation",
  "learningObjective",
  "sources",
  "shouldAdvise",
  "mustNotAdvise",
  "affectedSurfaces",
] as const;

export type BriefFieldName = (typeof briefFieldNames)[number];
export type BriefFieldState =
  | "CONFIRMED_FACT"
  | "USER_ACCEPTED_ASSUMPTION"
  | "DELIBERATE_UNKNOWN"
  | "UNRESOLVED_BLOCKER";
export type BriefValue = {
  value: string;
  state: BriefFieldState;
  impact?: string;
};
export type SharedUnderstandingBrief = Record<BriefFieldName, BriefValue>;

export function briefReadiness(brief: Partial<SharedUnderstandingBrief>): {
  ready: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  for (const field of briefFieldNames) {
    const item = brief[field];
    if (!item || !item.value.trim()) reasons.push(`${field}: required`);
    else if (item.state === "UNRESOLVED_BLOCKER")
      reasons.push(`${field}: unresolved blocker`);
    else if (item.state === "DELIBERATE_UNKNOWN" && !item.impact?.trim())
      reasons.push(`${field}: unknown requires impact`);
  }
  for (const requiredConfirmation of [
    "safetyEscalation",
    "mustNotAdvise",
  ] as const) {
    const item = brief[requiredConfirmation];
    if (
      item &&
      item.state !== "CONFIRMED_FACT" &&
      item.state !== "USER_ACCEPTED_ASSUMPTION"
    )
      reasons.push(`${requiredConfirmation}: explicit confirmation required`);
  }
  const objective = brief.learningObjective?.value ?? "";
  if (
    objective &&
    !/\b(?:will|can)\b.+\b(?:identify|choose|state|ask|write|demonstrate|practice|compare|respond|follow)\b/iu.test(
      objective,
    )
  ) {
    reasons.push("learningObjective: must describe observable behavior");
  }
  return { ready: reasons.length === 0, reasons };
}

export const workflowRoles = [
  "MAP_LEARNING_SURFACES",
  ...Array.from({ length: 7 }, (_, index) => `BLIND_CRITIC_${index + 1}`),
  ...Array.from({ length: 7 }, (_, index) => `REBUTTAL_${index + 1}`),
  "ADJUDICATOR",
  "TEACHING_DESIGNER",
  "BUNDLE_WRITER",
  "SEMANTIC_AUDITOR",
  "TEACHING_ALIGNMENT_AUDITOR",
  "REPOSITORY_INTEGRITY_AUDITOR",
  "REPOSITORY_VALIDATION",
] as const;

export type PublicationSagaState =
  | "REQUESTED"
  | "WORKTREE_READY"
  | "APPLIED"
  | "VALIDATED"
  | "COMMITTED"
  | "PUSHED"
  | "PREVIEW_BUILT"
  | "PREVIEW_VERIFIED"
  | "AWAITING_CONFIRMATION"
  | "CUTOVER"
  | "LIVE_VERIFIED"
  | "RECONCILED"
  | "FAILED_PREVIEW"
  | "AUTO_ROLLED_BACK"
  | "RECONCILIATION_REQUIRED";

export const publicationSagaTransitions: Readonly<
  Record<PublicationSagaState, readonly PublicationSagaState[]>
> = {
  REQUESTED: ["WORKTREE_READY", "RECONCILIATION_REQUIRED"],
  WORKTREE_READY: ["APPLIED", "RECONCILIATION_REQUIRED"],
  APPLIED: ["VALIDATED", "RECONCILIATION_REQUIRED"],
  VALIDATED: ["COMMITTED", "FAILED_PREVIEW", "RECONCILIATION_REQUIRED"],
  COMMITTED: ["PUSHED", "RECONCILIATION_REQUIRED"],
  PUSHED: ["PREVIEW_BUILT", "FAILED_PREVIEW", "RECONCILIATION_REQUIRED"],
  PREVIEW_BUILT: [
    "PREVIEW_VERIFIED",
    "FAILED_PREVIEW",
    "RECONCILIATION_REQUIRED",
  ],
  PREVIEW_VERIFIED: ["AWAITING_CONFIRMATION", "FAILED_PREVIEW"],
  AWAITING_CONFIRMATION: ["CUTOVER", "FAILED_PREVIEW"],
  CUTOVER: ["LIVE_VERIFIED", "AUTO_ROLLED_BACK", "RECONCILIATION_REQUIRED"],
  LIVE_VERIFIED: ["RECONCILED", "AUTO_ROLLED_BACK", "RECONCILIATION_REQUIRED"],
  RECONCILED: [],
  FAILED_PREVIEW: [],
  AUTO_ROLLED_BACK: ["RECONCILED", "RECONCILIATION_REQUIRED"],
  RECONCILIATION_REQUIRED: ["RECONCILED", "AUTO_ROLLED_BACK"],
};

const highConfidenceSensitivePatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:sk-proj|sk-ant-api03)-[A-Za-z0-9_-]{16,}\b/u,
  /\bpostgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/iu,
  /\b(?:password|passwd|secret|token)\s*[=:]\s*[^\s]{8,}/iu,
];

export function detectSensitiveText(value: string): {
  blocked: boolean;
  kinds: string[];
} {
  const kinds = highConfidenceSensitivePatterns.flatMap((pattern, index) =>
    pattern.test(value) ? [`pattern-${index + 1}`] : [],
  );
  return { blocked: kinds.length > 0, kinds };
}

export const MODEL_POLICY = Object.freeze({
  version: "2026-07-18-api-safe-v1",
  providers: {
    anthropic: { model: "opus", execution: "service-api-required" },
    openai: { model: "gpt-5.6-sol", execution: "responses-api-required" },
  },
  efforts: ["medium", "high", "xhigh"] as const,
});
