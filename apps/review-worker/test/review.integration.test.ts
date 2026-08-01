import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@situation-studio/db";
import {
  canonicalJson,
  canonicalText,
  parseSituationSections,
  reviewStages,
  serializeSituationSections,
  sha256,
  situationBundleSchema,
} from "@situation-studio/domain";
import {
  leadershipCapabilitySchemaVersion,
  leadershipTypedParityPredicate,
  requiredContentContractIdentity,
  requiredLeadershipFeatures,
  requiredSituationContractIdentity,
} from "@situation-studio/leadership-bridge";
import {
  AdapterFailure,
  bundleWriterOutputSchema,
  normalizedOutputSchema,
  runDeterministic,
  type AdapterRequest,
  type AdapterResult,
} from "@situation-studio/ai-adapters";
import { REVIEW_POLICY_VERSION } from "@situation-studio/review-policy";
import {
  claimNextReview,
  processClaimedReview,
  REVIEW_PROVIDER_TIMEOUT_MS,
  type ReviewApplicationFailureEvent,
  type ReviewStageTimingEvent,
} from "../src/review";

const executeFile = promisify(execFile);
const studioRoot = path.resolve(import.meta.dirname, "../../..");

function databaseUrl(container: StartedPostgreSqlContainer) {
  return container
    .getConnectionUri()
    .replace(/^postgres:\/\//u, "postgresql://");
}

function compatibleCapabilitiesUrl() {
  const capabilitySet = {
    schemaVersion: leadershipCapabilitySchemaVersion,
    deployment: {
      commit: "d".repeat(40),
      releaseId: "review-integration-runtime",
      archiveSha256: "a".repeat(64),
    },
    contracts: {
      content: requiredContentContractIdentity,
      situation: requiredSituationContractIdentity,
    },
    database: { predicate: leadershipTypedParityPredicate },
    features: [...requiredLeadershipFeatures],
  };
  return `data:application/json,${encodeURIComponent(
    JSON.stringify({
      ...capabilitySet,
      capabilityDigest: sha256(canonicalJson(capabilitySet)),
    }),
  )}`;
}

const subscriptionConfiguration = {
  mode: "subscription-cli" as const,
  codex: {
    binary: "codex",
    model: "gpt-5.6-sol",
    wrapper: "/release/ops/run-codex-review.sh",
  },
  claude: {
    binary: "claude",
    model: "sonnet",
  },
};

async function successfulStage(
  request: Omit<AdapterRequest, "provider" | "model">,
): Promise<AdapterResult> {
  const result = await runDeterministic({
    ...request,
    provider: "deterministic",
    model: "deterministic-provider-v1",
  });
  return {
    ...result,
    requestedProvider: "codex",
    resolvedProvider: "codex",
    requestedModel: "gpt-5.6-sol",
    resolvedModel: "gpt-5.6-sol",
    providerAttempts: [
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        durationMs: 250,
        outcome: "SUCCEEDED",
        failureClass: null,
        retryable: null,
      },
    ],
  };
}

function doubleTimeoutFailure(retryable = true) {
  return new AdapterFailure(
    "TRANSIENT",
    "Both review providers timed out.",
    retryable,
    [
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        durationMs: 90_000,
        outcome: "TIMED_OUT",
        failureClass: "TRANSIENT",
        retryable: true,
      },
      {
        provider: "claude",
        model: "sonnet",
        durationMs: 90_000,
        outcome: "TIMED_OUT",
        failureClass: "TRANSIENT",
        retryable: true,
      },
    ],
  );
}

describe("checkout fencing and the complete durable review DAG", () => {
  let container: StartedPostgreSqlContainer;
  let url: string;
  let database: DatabaseClient;
  let workflows: typeof import("@/server/workflows/situations");
  let editorOneId: string;
  let editorTwoId: string;
  let adminId: string;

  async function completeCandidateReview(
    jobId: string,
    input: {
      findings: Array<{
        id: string;
        severity: "note" | "consider" | "important" | "blocking";
        targetKind:
          | "SECTION"
          | "METADATA"
          | "SCOPED_VARIANT"
          | "RELATIONSHIP"
          | "EMBED"
          | "BUNDLE";
        targetKey: string;
        summary: string;
        rationale: string;
        evidenceRoleCodes: string[];
      }>;
      candidateEdits: ReturnType<
        typeof bundleWriterOutputSchema.parse
      >["candidateEdits"];
    },
  ) {
    const timingEvents: ReviewStageTimingEvent[] = [];
    const claim = await claimNextReview(database);
    expect(claim?.id).toBe(jobId);
    if (!claim?.claimToken)
      throw new Error("Candidate review did not receive a claim.");
    await processClaimedReview(
      database,
      jobId,
      subscriptionConfiguration,
      claim.claimToken,
      {
        runStage: async (request, _configuration, runtimeOptions) => {
          expect(request.system).toContain(REVIEW_POLICY_VERSION);
          if (request.role === "issue-register")
            expect(request.system).toContain("ISSUE: I-<number>");
          if (request.role === "audit-page-language")
            expect(request.system).toContain("FIRST_ACTION_IN_30_SECONDS");
          expect(runtimeOptions?.providerTimeoutMs).toBe(
            REVIEW_PROVIDER_TIMEOUT_MS,
          );
          const base = await successfulStage(request);
          const output =
            request.role === "critic-nvc"
              ? normalizedOutputSchema.parse({
                  role: request.role,
                  summary: "Structured candidate findings.",
                  findings: input.findings,
                  provenance: "candidate-integration",
                })
              : request.role === "bundle-writer"
                ? bundleWriterOutputSchema.parse({
                    role: request.role,
                    summary:
                      "A concise candidate revision grounded in retained findings.",
                    findings: [],
                    provenance: "candidate-integration",
                    candidateEdits: input.candidateEdits,
                  })
                : base.output;
          return {
            ...base,
            output,
            outputHash: sha256(JSON.stringify(output)),
          };
        },
        onStageTiming: (event) => timingEvents.push(event),
      },
    );
    expect(timingEvents).toHaveLength(reviewStages.length);
    expect(timingEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "review_stage_provider_timing",
          stageRole: "surface-mapper",
          stageOutcome: "SUCCEEDED",
          providerTimeoutMs: REVIEW_PROVIDER_TIMEOUT_MS,
          providerAttempts: [
            expect.objectContaining({
              provider: "codex",
              outcome: "SUCCEEDED",
              durationMs: 250,
            }),
          ],
        }),
        expect.objectContaining({
          event: "review_stage_provider_timing",
          stageRole: "audit-teaching-alignment",
          stageOutcome: "SUCCEEDED",
          providerTimeoutMs: REVIEW_PROVIDER_TIMEOUT_MS,
        }),
      ]),
    );
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.12-bookworm")
      .withDatabase("situation_studio")
      .withUsername("studio_test_owner")
      .withPassword("studio_test_password")
      .start();
    url = databaseUrl(container);
    await executeFile("pnpm", ["db:migrate:deploy"], {
      cwd: studioRoot,
      env: { ...process.env, STUDIO_DATABASE_URL: url },
    });
    process.env.STUDIO_DATABASE_URL = url;
    process.env.SESSION_SECRET = "s".repeat(32);
    process.env.CSRF_SECRET = "c".repeat(32);
    process.env.THROTTLE_SECRET = "t".repeat(32);
    process.env.SITUATION_STUDIO_ORIGIN = "http://localhost:3015";
    process.env.LEADERSHIP_RUNTIME_CAPABILITIES_URL =
      compatibleCapabilitiesUrl();
    database = createDatabaseClient(url, 6);
    const [editorOne, editorTwo, admin] = await Promise.all([
      database.user.create({
        data: {
          username: "editor-one",
          displayName: "Editor one",
          passwordHash: "not-used",
          roles: { create: { role: "EDITOR" } },
        },
      }),
      database.user.create({
        data: {
          username: "editor-two",
          displayName: "Editor two",
          passwordHash: "not-used",
          roles: { create: { role: "EDITOR" } },
        },
      }),
      database.user.create({
        data: {
          username: "admin",
          displayName: "Admin",
          passwordHash: "not-used",
          roles: { create: [{ role: "EDITOR" }, { role: "ADMIN" }] },
        },
      }),
    ]);
    editorOneId = editorOne.id;
    editorTwoId = editorTwo.id;
    adminId = admin.id;
    workflows = await import("@/server/workflows/situations");
  });

  afterAll(async () => {
    await database?.$disconnect();
    await container?.stop();
  });

  it("allows exactly one durable checkout and preserves the fenced draft", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-checkout-race",
      title: "A durable checkout integration race",
    });
    await workflows.checkInSituation({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });

    const attempts = await Promise.allSettled([
      workflows.checkoutSituation({
        situationId: created.situation.id,
        actorId: editorOneId,
      }),
      workflows.checkoutSituation({
        situationId: created.situation.id,
        actorId: editorTwoId,
      }),
    ]);
    const winners = attempts.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof workflows.checkoutSituation>>
      > => result.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    expect(
      await database.situationCheckout.count({
        where: { situationId: created.situation.id, releasedAt: null },
      }),
    ).toBe(1);

    const checkout = winners[0]!.value;
    await database.situationCheckout.update({
      where: { id: checkout.id },
      data: { acquiredAt: new Date(Date.now() - 31 * 60 * 1000) },
    });
    await expect(
      workflows.checkoutSituation({
        situationId: created.situation.id,
        actorId: checkout.holderId === editorOneId ? editorTwoId : editorOneId,
      }),
    ).rejects.toThrow(/checked out|completed checkout first/iu);

    const workspace = await workflows.workspaceForSlug(created.situation.slug);
    const revision = workspace?.drafts[0]?.revisions[0];
    const body = revision?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    )?.content.textBody;
    if (!revision || !body)
      throw new Error("Checkout fixture draft is missing.");
    const changedBody = canonicalText(
      body.replace(
        "Name what you are seeing",
        "Name the exact observable pattern you are seeing",
      ),
    );
    const saved = await workflows.saveDraft({
      actorId: checkout.holderId,
      checkoutId: checkout.id,
      fence: checkout.fence,
      body: changedBody,
      bundle: {
        ...situationBundleSchema.parse(revision.bundleManifest),
        bodyHash: sha256(changedBody),
      },
      namedCheckpoint: "Integration exact draft",
    });
    const checkedIn = await workflows.checkInSituation({
      actorId: checkout.holderId,
      checkoutId: checkout.id,
      fence: checkout.fence,
    });
    expect(checkedIn.resultingDraftHash).toBe(saved.bundleHash);

    const resumed = await workflows.checkoutSituation({
      situationId: created.situation.id,
      actorId: checkout.holderId === editorOneId ? editorTwoId : editorOneId,
    });
    expect(resumed.draftId).toBe(checkout.draftId);
    const queued = await workflows.queueReview({
      actorId: resumed.holderId,
      checkoutId: resumed.id,
      fence: resumed.fence,
    });
    const forced = await workflows.forceCheckInSituation({
      adminId,
      situationId: created.situation.id,
      reason: "Integration fencing verification",
    });
    expect(forced.resultingDraftHash).toBe(saved.bundleHash);
    const cancelled = await database.reviewJob.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect(cancelled).toMatchObject({ state: "CANCELLED", fence: 2n });
    await expect(
      workflows.saveDraft({
        actorId: resumed.holderId,
        checkoutId: resumed.id,
        fence: resumed.fence,
        body: changedBody,
        bundle: revision.bundleManifest,
      }),
    ).rejects.toThrow(/checkout changed/iu);
    expect(
      await database.auditEvent.count({
        where: {
          action: "SITUATION_FORCE_CHECKED_IN",
          actorId: adminId,
          subjectId: created.situation.id,
        },
      }),
    ).toBe(1);
  });

  it("runs every policy stage once, globally serializes jobs, and fences cancellation", async () => {
    const first = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-one",
      title: "A first complete deterministic review",
    });
    const firstJob = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: first.checkout.id,
      fence: first.checkout.fence,
    });
    expect(firstJob.policyVersion).toBe(REVIEW_POLICY_VERSION);
    expect(firstJob.steps).toHaveLength(reviewStages.length);
    expect(
      [...firstJob.steps]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((step) => step.roleCode),
    ).toEqual(reviewStages.map((stage) => stage.role));
    const pinnedRevisionCount = await database.draftRevision.count({
      where: { draftId: first.draft.id },
    });
    await expect(
      workflows.saveDraft({
        actorId: editorOneId,
        checkoutId: first.checkout.id,
        fence: first.checkout.fence,
        body: "blocked while queued",
        bundle: {},
      }),
    ).rejects.toThrow(/read-only/iu);

    const claimedFirst = await claimNextReview(database);
    expect(claimedFirst?.id).toBe(firstJob.id);
    const second = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-two",
      title: "A second serialized deterministic review",
    });
    const secondJob = await workflows.queueReview({
      actorId: editorTwoId,
      checkoutId: second.checkout.id,
      fence: second.checkout.fence,
    });
    expect(await claimNextReview(database)).toBeNull();

    await processClaimedReview(database, firstJob.id, {
      mode: "deterministic",
    });
    const completed = await database.reviewJob.findUniqueOrThrow({
      where: { id: firstJob.id },
      include: {
        steps: { orderBy: { ordinal: "asc" }, include: { runs: true } },
        proposal: {
          include: { candidate: true, findings: true, changes: true },
        },
      },
    });
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.steps).toHaveLength(reviewStages.length);
    expect(completed.steps.every((step) => step.state === "SUCCEEDED")).toBe(
      true,
    );
    expect(completed.steps.flatMap((step) => step.runs)).toHaveLength(
      reviewStages.length,
    );
    for (const run of completed.steps.flatMap((step) => step.runs)) {
      expect(run).toMatchObject({
        requestedProvider: "deterministic",
        resolvedProvider: "deterministic",
        requestedModel: "deterministic-provider-v1",
        resolvedModel: "deterministic-provider-v1",
        reasoningEffort: "high",
        inputTokens: 0,
        outputTokens: 0,
        usageEstimated: false,
      });
      expect(run.evidenceHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(run.outputHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(run.structuredOutput).toBeTruthy();
    }
    expect(completed.proposal?.inputRevisionId).toBe(firstJob.inputRevisionId);
    expect(completed.proposal?.candidate?.inputRevisionId).toBe(
      firstJob.inputRevisionId,
    );
    expect(completed.proposal?.changes).toHaveLength(0);
    expect(completed.proposal?.findings).toHaveLength(0);
    expect(completed.proposal?.candidate?.bodyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      await database.draftRevision.count({
        where: { draftId: first.draft.id },
      }),
    ).toBe(pinnedRevisionCount);
    await processClaimedReview(database, firstJob.id, {
      mode: "deterministic",
    });
    expect(
      await database.agentRun.count({
        where: { step: { jobId: firstJob.id } },
      }),
    ).toBe(reviewStages.length);

    const claimedSecond = await claimNextReview(database);
    expect(claimedSecond?.id).toBe(secondJob.id);
    await processClaimedReview(database, secondJob.id, {
      mode: "deterministic",
    });
    const proposals = await database.reviewProposal.findMany({
      where: { jobId: { in: [firstJob.id, secondJob.id] } },
    });
    expect(
      new Set(proposals.map((proposal) => proposal.proposalHash)).size,
    ).toBe(2);

    const third = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-cancel",
      title: "A cancellable deterministic review",
    });
    const thirdJob = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: third.checkout.id,
      fence: third.checkout.fence,
    });
    expect((await claimNextReview(database))?.id).toBe(thirdJob.id);
    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: thirdJob.id,
      reason: "Integration cancellation",
    });
    await processClaimedReview(database, thirdJob.id, {
      mode: "deterministic",
    });
    expect(
      await database.agentRun.count({
        where: { step: { jobId: thirdJob.id } },
      }),
    ).toBe(0);
    const cancelled = await database.reviewJob.findUniqueOrThrow({
      where: { id: thirdJob.id },
      include: { steps: true },
    });
    expect(cancelled.state).toBe("CANCELLED");
    expect(cancelled.steps.every((step) => step.state === "CANCELLED")).toBe(
      true,
    );
  });

  it("materializes an isolated candidate with truthful lineage and applies an editor-modified suggestion", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-agent-candidate",
      title: "An isolated agent candidate revision scenario",
    });
    const workspace = await workflows.workspaceForSlug(created.situation.slug);
    const inputRevision = workspace?.drafts[0]?.revisions[0];
    const inputBody = inputRevision?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    )?.content.textBody;
    if (!inputRevision || !inputBody)
      throw new Error("Candidate fixture input is unavailable.");
    const inputSections = parseSituationSections(inputBody);
    const automaticId = randomUUID();
    const manualId = randomUUID();
    const revisionCount = await database.draftRevision.count({
      where: { draftId: created.draft.id },
    });
    const job = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    await completeCandidateReview(job.id, {
      findings: [
        {
          id: "observable-opening",
          severity: "important",
          targetKind: "SECTION",
          targetKey: "The short answer",
          summary: "The opening should name an observable pattern.",
          rationale:
            "Separating observation from judgment reduces defensiveness.",
          evidenceRoleCodes: ["critic-manager-tools"],
        },
      ],
      candidateEdits: [
        {
          id: automaticId,
          targetKind: "SECTION",
          targetKey: "The short answer",
          applicationMode: "MANUAL",
          beforeHash: null,
          afterBody:
            "## The short answer\nName the directly observed pattern, ask for their view, and agree on one next move.",
          problem: "The opening relies on a broad interpretation.",
          explanation: "Makes the opening observable and specific.",
          rationale:
            "The replacement responds to the retained NVC finding while preserving the existing action sequence.",
          upstreamFindingIds: ["critic-nvc:observable-opening"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc", "critic-manager-tools"],
        },
        {
          id: manualId,
          targetKind: "EMBED",
          targetKey: "supporting-example",
          applicationMode: "MANUAL",
          beforeHash: null,
          afterBody: "Consider adding a context-specific supporting example.",
          problem: "The best example depends on editorial context.",
          explanation: "Leaves a visible manual suggestion.",
          rationale:
            "No safe generic embed can be generated from the pinned evidence.",
          upstreamFindingIds: ["critic-nvc:observable-opening"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
      ],
    });

    const completed = await database.reviewJob.findUniqueOrThrow({
      where: { id: job.id },
      include: {
        proposal: {
          include: {
            candidate: true,
            findings: true,
            changes: {
              orderBy: { position: "asc" },
              include: { findingLinks: { include: { finding: true } } },
            },
          },
        },
      },
    });
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.proposal?.candidate?.body).toContain(
      "Name the directly observed pattern",
    );
    expect(
      completed.proposal?.candidate?.body.match(/^## The short answer$/gmu),
    ).toHaveLength(1);
    expect(completed.proposal?.candidate?.inputBundleHash).toBe(
      inputRevision.bundleHash,
    );
    expect(completed.proposal?.findings[0]).toMatchObject({
      findingKey: "critic-nvc:observable-opening",
      sourceRoleCode: "critic-nvc",
      evidenceRoleCodes: ["critic-manager-tools"],
    });
    expect(completed.proposal?.changes[0]).toMatchObject({
      id: automaticId,
      beforeBody: inputSections["The short answer"],
      writtenByRoleCode: "bundle-writer",
      identifiedByRoleCodes: ["critic-nvc"],
      applicationMode: "AUTOMATIC",
    });
    expect(
      completed.proposal?.changes[0]?.findingLinks[0]?.finding.findingKey,
    ).toBe("critic-nvc:observable-opening");
    expect(
      await database.draftRevision.count({
        where: { draftId: created.draft.id },
      }),
    ).toBe(revisionCount);

    const editorReplacement =
      "Name one directly observed pattern, ask for their view, and agree on one dated next move.";
    await workflows.editProposalChange({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      changeId: automaticId,
      editedBody: editorReplacement,
    });
    await workflows.decideProposalChange({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      changeId: manualId,
      decision: "REJECT",
    });
    const accepted = await workflows.decideProposalChange({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      changeId: automaticId,
      decision: "ACCEPT",
    });
    const applied = await database.draftRevision.findUniqueOrThrow({
      where: { id: accepted.revisionId! },
      include: { artifacts: { include: { content: true } } },
    });
    expect(
      applied.artifacts.find((artifact) => artifact.kind === "SITUATION")
        ?.content.textBody,
    ).toContain(editorReplacement);
    expect(
      await database.proposalChange.findUniqueOrThrow({
        where: { id: automaticId },
      }),
    ).toMatchObject({
      state: "ACCEPTED",
      editorBody: editorReplacement,
      appliedRevisionId: accepted.revisionId,
    });
    expect(
      await database.auditEvent.findMany({
        where: {
          subjectId: { in: [automaticId, manualId] },
          action: {
            in: [
              "PROPOSAL_CHANGE_EDITED",
              "PROPOSAL_CHANGE_ACCEPTED",
              "PROPOSAL_CHANGE_REJECTED",
            ],
          },
        },
      }),
    ).toHaveLength(3);
  });

  it("materializes granular subheading and named-block candidate targets", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-nested-candidate-targets",
      title: "A granular candidate target scenario",
    });
    const workspace = await workflows.workspaceForSlug(created.situation.slug);
    const inputRevision = workspace?.drafts[0]?.revisions[0];
    const inputBody = inputRevision?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    )?.content.textBody;
    if (!inputRevision || !inputBody)
      throw new Error("Nested candidate fixture input is unavailable.");
    const inputSections = parseSituationSections(inputBody);
    const nestedBody = serializeSituationSections({
      ...inputSections,
      "When this guidance fits": [
        "Use this for a recurring pattern.",
        "",
        "> **Stop and get support:** use the applicable formal process.",
      ].join("\n"),
      "If they respond with…": [
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
      ].join("\n"),
    });
    await workflows.saveDraft({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      bundle: {
        ...situationBundleSchema.parse(inputRevision.bundleManifest),
        bodyHash: sha256(canonicalText(nestedBody)),
      },
      body: nestedBody,
      namedCheckpoint: "Nested candidate target fixture",
    });
    const job = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    const ids = [randomUUID(), randomUUID(), randomUUID()] as const;
    await completeCandidateReview(job.id, {
      findings: [
        {
          id: "granular-targets",
          severity: "important",
          targetKind: "SECTION",
          targetKey: "If they respond with…",
          summary: "Three granular passages need bounded repairs.",
          rationale: "Unrelated guidance in both parent sections must remain.",
          evidenceRoleCodes: ["critic-manager-tools"],
        },
      ],
      candidateEdits: [
        {
          id: ids[0],
          targetKind: "SECTION",
          targetKey: "When this guidance fits#stop-and-get-support",
          applicationMode: "AUTOMATIC",
          beforeHash: null,
          afterBody:
            "> **Stop and get support:** explain the limits and follow the applicable process.",
          problem: "The support boundary needs a more explicit action.",
          explanation: "Repairs only the named support block.",
          rationale: "The surrounding fit guidance remains unchanged.",
          upstreamFindingIds: ["critic-nvc:granular-targets"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
        {
          id: ids[1],
          targetKind: "SECTION",
          targetKey:
            "If they respond with…/I don’t know what you want me to say",
          applicationMode: "AUTOMATIC",
          beforeHash: null,
          afterBody:
            "Own the ambiguity and explain that no particular disclosure is required.",
          problem: "The reply should clarify choice.",
          explanation: "Repairs only the selected response.",
          rationale: "Other response paths remain unchanged.",
          upstreamFindingIds: ["critic-nvc:granular-targets"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
        {
          id: ids[2],
          targetKind: "SECTION",
          targetKey: "If they respond with…/Can we skip these?",
          applicationMode: "AUTOMATIC",
          beforeHash: null,
          afterBody:
            "Ask what has made the meetings low-value and offer legitimate alternatives.",
          problem: "The reply should name practical alternatives.",
          explanation: "Repairs only the selected response.",
          rationale: "The rest of the response section remains unchanged.",
          upstreamFindingIds: ["critic-nvc:granular-targets"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
      ],
    });
    const completed = await database.reviewJob.findUniqueOrThrow({
      where: { id: job.id },
      include: {
        proposal: {
          include: {
            candidate: true,
            changes: { orderBy: { position: "asc" } },
          },
        },
      },
    });
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.proposal?.candidate?.body).toContain(
      "no particular disclosure is required",
    );
    expect(completed.proposal?.candidate?.body).toContain(
      "offer legitimate alternatives",
    );
    expect(completed.proposal?.candidate?.body).toContain(
      "### “Everything is fine.”",
    );
    expect(
      completed.proposal?.changes.map((change) => change.beforeBody),
    ).toEqual([
      "> **Stop and get support:** use the applicable formal process.",
      "Own the ambiguity.",
      "Ask what has made the meetings low-value.",
    ]);
    const accepted = await workflows.acceptAllProposalChanges({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      proposalId: completed.proposal!.id,
    });
    const applied = await database.draftRevision.findUniqueOrThrow({
      where: { id: accepted.revisionId },
      include: { artifacts: { include: { content: true } } },
    });
    const appliedBody = applied.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    )?.content.textBody;
    expect(appliedBody).toContain("no particular disclosure is required");
    expect(appliedBody).toContain("### “Everything is fine.”");
  });

  it("accepts case-only role differences in bundle-writer finding links", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-uppercase-finding-link",
      title: "A case-normalized finding lineage scenario",
    });
    const job = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    await completeCandidateReview(job.id, {
      findings: [
        {
          id: "case-only-lineage",
          severity: "important",
          targetKind: "SECTION",
          targetKey: "The short answer",
          summary: "The opening needs one observable next move.",
          rationale: "The finding exists under the canonical lowercase role.",
          evidenceRoleCodes: ["critic-nvc"],
        },
      ],
      candidateEdits: [
        {
          id: "61e949ea-e41d-4337-92e2-761f0b2afe3c",
          targetKind: "SECTION",
          targetKey: "The short answer",
          applicationMode: "AUTOMATIC",
          beforeHash: null,
          afterBody: "Name the observed pattern, then ask for their view.",
          problem: "The first action needs to be concrete.",
          explanation: "Makes the first conversation move explicit.",
          rationale: "A case-only role prefix must not break valid lineage.",
          upstreamFindingIds: ["CRITIC-NVC:case-only-lineage"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
      ],
    });
    const completed = await database.reviewJob.findUniqueOrThrow({
      where: { id: job.id },
      include: {
        proposal: {
          include: {
            changes: { include: { findingLinks: true } },
          },
        },
      },
    });
    expect(completed).toMatchObject({ state: "SUCCEEDED", laneOwner: false });
    expect(completed.proposal?.changes[0]?.findingLinks).toHaveLength(1);
  });

  it("logs the safe proposal-materialization error instead of discarding it", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-materialization-error-log",
      title: "A logged proposal materialization failure",
    });
    const job = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    const claim = await claimNextReview(database);
    if (!claim?.claimToken)
      throw new Error("Materialization logging fixture was not claimable.");
    const events: ReviewApplicationFailureEvent[] = [];
    await processClaimedReview(
      database,
      job.id,
      subscriptionConfiguration,
      claim.claimToken,
      {
        onApplicationFailure: (event) => events.push(event),
        runStage: async (request) => {
          const base = await successfulStage(request);
          if (request.role !== "bundle-writer") return base;
          const output = bundleWriterOutputSchema.parse({
            role: request.role,
            summary: "A candidate with intentionally broken lineage.",
            findings: [],
            provenance: "materialization-error-log-test",
            candidateEdits: [
              {
                id: "201eb1cb-c6d6-476d-9462-aa560519596e",
                targetKind: "SECTION",
                targetKey: "The short answer",
                applicationMode: "AUTOMATIC",
                beforeHash: null,
                afterBody: "Name the observed pattern and ask for their view.",
                problem: "The opening needs a bounded repair.",
                explanation: "Proposes a concise replacement.",
                rationale: "The missing lineage is intentional in this test.",
                upstreamFindingIds: ["adjudicator:missing-finding"],
                writtenByRoleCode: "bundle-writer",
                evidenceRoleCodes: ["adjudicator"],
              },
            ],
          });
          return {
            ...base,
            output,
            outputHash: sha256(JSON.stringify(output)),
          };
        },
      },
    );
    expect(
      await database.reviewJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).toMatchObject({
      state: "FAILED",
      laneOwner: true,
      failureCode: "APPLICATION",
      failureReasonCode: "CANDIDATE_FINDING_REFERENCE_INVALID",
      failurePhase: "MATERIALIZE_PROPOSAL",
      failureStageOrdinal: 19,
      failureStageRole: "bundle-writer",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "review_application_failure",
        jobId: job.id,
        stageOrdinal: 19,
        stageRole: "bundle-writer",
        phase: "MATERIALIZE_PROPOSAL",
        failureClass: "APPLICATION",
        errorMessage: expect.stringContaining(
          "references missing finding adjudicator:missing-finding",
        ),
      }),
    );
    expect(
      await database.reviewStep.count({
        where: { jobId: job.id, ordinal: { gt: 19 }, state: "PENDING" },
      }),
    ).toBe(5);
    expect(
      await database.auditEvent.findFirst({
        where: {
          action: "REVIEW_STAGE_FAILED",
          subjectId: job.id,
        },
      }),
    ).toMatchObject({
      payload: expect.objectContaining({
        reasonCode: "CANDIDATE_FINDING_REFERENCE_INVALID",
        stageOrdinal: 19,
      }),
    });
    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: job.id,
      reason: "Integration cleanup after materialization failure",
    });
  });

  it("atomically rejects all pending suggestions without changing the draft", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-agent-reject-all",
      title: "An atomically rejected agent revision scenario",
    });
    const workspace = await workflows.workspaceForSlug(created.situation.slug);
    const inputRevision = workspace?.drafts[0]?.revisions[0];
    const inputBody = inputRevision?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    )?.content.textBody;
    if (!inputRevision || !inputBody)
      throw new Error("Reject-all fixture input is unavailable.");
    const revisionCount = await database.draftRevision.count({
      where: { draftId: created.draft.id },
    });
    const automaticId = randomUUID();
    const manualId = randomUUID();
    const job = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    await completeCandidateReview(job.id, {
      findings: [
        {
          id: "rejectable-change-set",
          severity: "important",
          targetKind: "SECTION",
          targetKey: "3 — Say",
          summary: "The proposed change set should remain optional.",
          rationale: "Editors retain final authority over every agent change.",
          evidenceRoleCodes: ["critic-manager-tools"],
        },
      ],
      candidateEdits: [
        {
          id: automaticId,
          targetKind: "SECTION",
          targetKey: "3 — Say",
          applicationMode: "AUTOMATIC",
          beforeHash: null,
          afterBody: "Name the observation, then ask what they see.",
          problem: "The opening needs a clearer sequence.",
          explanation: "Separates observation from inquiry.",
          rationale: "The sequence keeps the conversation specific.",
          upstreamFindingIds: ["critic-nvc:rejectable-change-set"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
        {
          id: manualId,
          targetKind: "EMBED",
          targetKey: "context-specific-example",
          applicationMode: "MANUAL",
          beforeHash: null,
          afterBody: "Choose an example grounded in the real situation.",
          problem: "A truthful example needs editor context.",
          explanation: "Keeps the contextual choice explicit.",
          rationale: "The evidence does not support inventing an example.",
          upstreamFindingIds: ["critic-nvc:rejectable-change-set"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
      ],
    });
    const proposal = await database.reviewProposal.findUniqueOrThrow({
      where: { jobId: job.id },
    });
    const rejected = await workflows.rejectAllProposalChanges({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      proposalId: proposal.id,
    });
    expect(rejected).toEqual({ state: "REJECTED", rejectedCount: 2 });
    expect(
      await database.proposalChange.count({
        where: { proposalId: proposal.id, state: "REJECTED" },
      }),
    ).toBe(2);
    expect(
      await database.draftRevision.count({
        where: { draftId: created.draft.id },
      }),
    ).toBe(revisionCount);
    expect(
      await database.auditEvent.findFirst({
        where: {
          action: "PROPOSAL_CHANGES_REJECTED_ALL",
          subjectId: proposal.id,
        },
      }),
    ).not.toBeNull();
  });

  it("atomically accepts typed bundle changes, retains manual items, and fences stale targets", async () => {
    const created = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-agent-atomic",
      title: "An atomic structured candidate revision scenario",
    });
    const initial = await workflows.workspaceForSlug(created.situation.slug);
    const initialRevision = initial?.drafts[0]?.revisions[0];
    const initialBody = initialRevision?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    )?.content.textBody;
    if (!initialRevision || !initialBody)
      throw new Error("Atomic fixture input is unavailable.");
    const oldContextBody = canonicalText('{"steps":["Listen first."]}');
    const newContextBody = canonicalText(
      '{"steps":["Name the pattern, then listen."]}',
    );
    const oldContextHash = sha256(oldContextBody);
    const newContextHash = sha256(newContextBody);
    await database.contentBlob.createMany({
      data: [
        {
          hash: oldContextHash,
          encoding: "UTF8",
          mediaType: "application/json; charset=utf-8",
          byteLength: new TextEncoder().encode(oldContextBody).byteLength,
          textBody: oldContextBody,
        },
        {
          hash: newContextHash,
          encoding: "UTF8",
          mediaType: "application/json; charset=utf-8",
          byteLength: new TextEncoder().encode(newContextBody).byteLength,
          textBody: newContextBody,
        },
      ],
      skipDuplicates: true,
    });
    const baseBundle = situationBundleSchema.parse(
      initialRevision.bundleManifest,
    );
    const relationship = {
      kind: "PRACTICE",
      logicalId: "practice:atomic-listen",
      position: 0,
      contentHash: oldContextHash,
      visibility: "GLOBAL" as const,
    };
    const saved = await workflows.saveDraft({
      actorId: editorTwoId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      bundle: {
        ...baseBundle,
        relationships: [relationship],
        contextHashes: [oldContextHash],
      },
      body: initialBody,
      namedCheckpoint: "Atomic candidate base",
    });
    const savedWorkspace = await workflows.workspaceForSlug(
      created.situation.slug,
    );
    const savedRevision = savedWorkspace?.drafts[0]?.revisions[0];
    const savedBody = savedRevision?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    )?.content.textBody;
    if (!savedRevision || !savedBody)
      throw new Error("Atomic saved revision is unavailable.");
    const sections = parseSituationSections(savedBody);
    const nextTitle = "An atomically accepted structured agent revision";
    const replacementRelationship = {
      ...relationship,
      contentHash: newContextHash,
    };
    const ids = {
      section: randomUUID(),
      metadata: randomUUID(),
      relationship: randomUUID(),
      scoped: randomUUID(),
      manual: randomUUID(),
    };
    const scopedPracticeBody = canonicalJson({
      id: "situation-follow-up",
      title: "Ask, reflect, and follow up",
      description: "Practice a two-step response to a recurring concern.",
      estimatedTime: "3 minutes",
      rounds: [
        {
          id: "ask",
          setup: "A direct report names a recurring obstacle.",
          prompt: "What is your first response?",
          choices: [
            {
              id: "learn",
              label: "Ask what changed most recently.",
              consequenceId: "specific-example",
              consequence: "The conversation moves to observable detail.",
              explanation: "A specific example slows premature diagnosis.",
              signal: "toward",
            },
            {
              id: "solve",
              label: "Offer a solution immediately.",
              consequenceId: "solution-first",
              consequence: "The concern is narrowed before it is understood.",
              explanation: "Learn the shape of the concern before solving it.",
              signal: "away",
            },
          ],
        },
        {
          id: "follow-up",
          setup: "You understand the example and agree on one next step.",
          prompt: "How do you close?",
          choices: [
            {
              id: "date",
              label: "Set a dated follow-up.",
              consequenceId: "follow-through-visible",
              consequence: "Both people know when the commitment is reviewed.",
              explanation: "A dated follow-up makes support observable.",
              signal: "toward",
            },
            {
              id: "vague",
              label: "Say you will keep an eye on it.",
              consequenceId: "ownership-unclear",
              consequence: "The next move and ownership stay ambiguous.",
              explanation: "Close with a concrete owner and review point.",
              signal: "away",
            },
          ],
        },
      ],
    });
    const job = await workflows.queueReview({
      actorId: editorTwoId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    await completeCandidateReview(job.id, {
      findings: [
        {
          id: "structured-bundle",
          severity: "blocking",
          targetKind: "BUNDLE",
          targetKey: "candidate",
          summary: "Several exact bundle updates should move together.",
          rationale:
            "The changes form one validated candidate and should be atomic.",
          evidenceRoleCodes: ["critic-manager-tools"],
        },
      ],
      candidateEdits: [
        {
          id: ids.section,
          targetKind: "SECTION",
          targetKey: "3 — Say",
          applicationMode: "MANUAL",
          beforeHash: sha256(canonicalText(sections["3 — Say"])),
          afterBody:
            "Say what you observed, explain the impact, and ask what they see.",
          problem: "The conversation opener needs a concrete sequence.",
          explanation: "Adds an observable conversation sequence.",
          rationale: "The sequence keeps facts, impact, and inquiry distinct.",
          upstreamFindingIds: ["critic-nvc:structured-bundle"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
        {
          id: ids.metadata,
          targetKind: "METADATA",
          targetKey: "title",
          applicationMode: "AUTOMATIC",
          beforeHash: sha256(canonicalJson(baseBundle.metadata.title)),
          afterBody: JSON.stringify(nextTitle),
          problem: "The title does not describe the revised focus.",
          explanation: "Aligns the title with the revised guidance.",
          rationale: "The typed metadata value remains contract-valid.",
          upstreamFindingIds: ["critic-nvc:structured-bundle"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-manager-tools"],
        },
        {
          id: ids.relationship,
          targetKind: "RELATIONSHIP",
          targetKey: relationship.logicalId,
          applicationMode: "AUTOMATIC",
          beforeHash: sha256(canonicalJson(relationship)),
          afterBody: canonicalJson(replacementRelationship),
          problem: "The linked practice does not match the revised sequence.",
          explanation: "Points to the retained matching practice bytes.",
          rationale:
            "The replacement content hash already exists in immutable content storage.",
          upstreamFindingIds: ["critic-nvc:structured-bundle"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-manager-tools"],
        },
        {
          id: ids.scoped,
          targetKind: "SCOPED_VARIANT",
          targetKey: `${relationship.logicalId}#situation-follow-up`,
          applicationMode: "AUTOMATIC",
          beforeHash: newContextHash,
          afterBody: scopedPracticeBody,
          problem: "The shared practice needs situation-specific wording.",
          explanation: "Creates a provenance-retaining scoped variant.",
          rationale:
            "The original logical ID and content hash remain attached to the fork.",
          upstreamFindingIds: ["critic-nvc:structured-bundle"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-manager-tools"],
        },
        {
          id: ids.manual,
          targetKind: "EMBED",
          targetKey: "contextual-example",
          applicationMode: "MANUAL",
          beforeHash: null,
          afterBody: "Choose an approved contextual example in the editor.",
          problem: "No safe generic embed is available.",
          explanation: "Keeps the unresolved embed visible.",
          rationale:
            "The candidate does not invent unsupported embedded content.",
          upstreamFindingIds: ["critic-nvc:structured-bundle"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
      ],
    });
    const beforeAtomicCount = await database.draftRevision.count({
      where: { draftId: created.draft.id },
    });
    const proposal = await database.reviewProposal.findUniqueOrThrow({
      where: { jobId: job.id },
    });
    const accepted = await workflows.acceptAllProposalChanges({
      actorId: editorTwoId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      proposalId: proposal.id,
    });
    expect(accepted).toMatchObject({
      appliedCount: 4,
      manualRemainingCount: 1,
    });
    expect(
      await database.draftRevision.count({
        where: { draftId: created.draft.id },
      }),
    ).toBe(beforeAtomicCount + 1);
    const applied = await database.draftRevision.findUniqueOrThrow({
      where: { id: accepted.revisionId },
      include: { artifacts: { include: { content: true } } },
    });
    const appliedBundle = situationBundleSchema.parse(applied.bundleManifest);
    expect(appliedBundle.metadata.title).toBe(nextTitle);
    expect(appliedBundle.relationships[0]).toMatchObject({
      visibility: "SITUATION_SCOPED",
      contentHash: sha256(canonicalText(scopedPracticeBody)),
    });
    expect(
      applied.artifacts.find((artifact) => artifact.kind === "SITUATION")
        ?.content.textBody,
    ).toContain("Say what you observed");
    expect(
      applied.artifacts
        .find((artifact) => artifact.kind === "SITUATION")
        ?.content.textBody.match(/^## 3 — Say$/gmu),
    ).toHaveLength(1);
    expect(
      await database.proposalChange.findUniqueOrThrow({
        where: { id: ids.manual },
      }),
    ).toMatchObject({ state: "PENDING", applicationMode: "MANUAL" });
    expect(
      await database.proposalChange.count({
        where: {
          id: {
            in: [ids.section, ids.metadata, ids.relationship, ids.scoped],
          },
          state: "ACCEPTED",
          appliedRevisionId: accepted.revisionId,
        },
      }),
    ).toBe(4);

    const staleJob = await workflows.queueReview({
      actorId: editorTwoId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    const currentWorkspace = await workflows.workspaceForSlug(
      created.situation.slug,
    );
    const currentRevision = currentWorkspace?.drafts[0]?.revisions[0];
    const currentBody = currentRevision?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    )?.content.textBody;
    if (!currentRevision || !currentBody)
      throw new Error("Stale candidate input is unavailable.");
    const currentSections = parseSituationSections(currentBody);
    const staleChangeId = randomUUID();
    await completeCandidateReview(staleJob.id, {
      findings: [
        {
          id: "stale-target",
          severity: "important",
          targetKind: "SECTION",
          targetKey: "The short answer",
          summary: "The opening could be more specific.",
          rationale: "The candidate pins the exact reviewed bytes.",
          evidenceRoleCodes: [],
        },
      ],
      candidateEdits: [
        {
          id: staleChangeId,
          targetKind: "SECTION",
          targetKey: "The short answer",
          applicationMode: "AUTOMATIC",
          beforeHash: sha256(
            canonicalText(currentSections["The short answer"]),
          ),
          afterBody: "Candidate replacement that should become stale.",
          problem: "The reviewed opening was broad.",
          explanation: "Proposes a more specific opening.",
          rationale: "This must not apply after the target changes.",
          upstreamFindingIds: ["critic-nvc:stale-target"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
      ],
    });
    const manuallyChangedBody = serializeSituationSections({
      ...currentSections,
      "The short answer":
        "The editor changed this exact target after the review.",
    });
    await workflows.saveDraft({
      actorId: editorTwoId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      bundle: {
        ...situationBundleSchema.parse(currentRevision.bundleManifest),
        bodyHash: sha256(canonicalText(manuallyChangedBody)),
      },
      body: manuallyChangedBody,
      namedCheckpoint: "Stale target proof",
    });
    await expect(
      workflows.decideProposalChange({
        actorId: editorTwoId,
        checkoutId: created.checkout.id,
        fence: created.checkout.fence,
        changeId: staleChangeId,
        decision: "ACCEPT",
      }),
    ).rejects.toMatchObject({ code: "STALE_SUGGESTION" });
    expect(
      await database.proposalChange.findUniqueOrThrow({
        where: { id: staleChangeId },
      }),
    ).toMatchObject({ state: "PENDING", appliedRevisionId: null });
    expect(saved.bundleHash).toBe(savedRevision.bundleHash);
  });

  it("durably backs off after a timeout, survives restart, and preserves immutable successful-stage history", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-timeout-recovery",
      title: "A retryable timeout recovery scenario",
    });
    const queued = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    let now = new Date(Date.now() + 60_000);
    const timing = {
      now: () => now,
      retryDelaysMs: [1_000, 2_000],
    };
    const timingEvents: ReviewStageTimingEvent[] = [];
    let criticAttempts = 0;
    const runStage = async (
      request: Omit<AdapterRequest, "provider" | "model">,
    ) => {
      if (request.role === "critic-nvc") {
        criticAttempts += 1;
        if (criticAttempts === 1) throw doubleTimeoutFailure();
      }
      return successfulStage(request);
    };

    const firstClaim = await claimNextReview(database, timing);
    expect(firstClaim?.id).toBe(queued.id);
    if (!firstClaim?.claimToken)
      throw new Error("Retry fixture did not receive its first claim.");
    await processClaimedReview(
      database,
      queued.id,
      subscriptionConfiguration,
      firstClaim.claimToken,
      {
        timing,
        runStage,
        onStageTiming: (event) => timingEvents.push(event),
      },
    );

    const backingOff = await database.reviewJob.findUniqueOrThrow({
      where: { id: queued.id },
      include: {
        steps: {
          orderBy: { ordinal: "asc" },
          include: { runs: { orderBy: { attempt: "asc" } } },
        },
      },
    });
    expect(backingOff).toMatchObject({
      state: "QUEUED",
      failureCode: "TRANSIENT",
      claimToken: null,
      leaseExpiresAt: null,
    });
    expect(backingOff.retryNotBefore).toEqual(new Date(now.getTime() + 1_000));
    expect(backingOff.steps[0]).toMatchObject({ state: "SUCCEEDED" });
    expect(backingOff.steps[1]).toMatchObject({ state: "READY" });
    const preservedRun = backingOff.steps[0]?.runs[0];
    const failedRun = backingOff.steps[1]?.runs[0];
    expect(preservedRun?.outputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(failedRun).toMatchObject({
      attempt: 1,
      failureClass: "PROVIDER_TRANSIENT",
      retryable: true,
    });
    expect(failedRun?.providerAttempts).toEqual([
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        durationMs: 90_000,
        outcome: "TIMED_OUT",
        failureClass: "TRANSIENT",
        retryable: true,
      },
      {
        provider: "claude",
        model: "sonnet",
        durationMs: 90_000,
        outcome: "TIMED_OUT",
        failureClass: "TRANSIENT",
        retryable: true,
      },
    ]);
    expect(timingEvents).toContainEqual(
      expect.objectContaining({
        event: "review_stage_provider_timing",
        stageRole: "critic-nvc",
        stageAttempt: 1,
        stageOutcome: "FAILED",
        providerTimeoutMs: REVIEW_PROVIDER_TIMEOUT_MS,
        providerAttempts: failedRun?.providerAttempts,
      }),
    );

    const waiting = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-waits-for-retry",
      title: "A review waiting behind focused retry work",
    });
    const waitingJob = await workflows.queueReview({
      actorId: editorTwoId,
      checkoutId: waiting.checkout.id,
      fence: waiting.checkout.fence,
    });

    expect(await claimNextReview(database, timing)).toBeNull();
    now = new Date(now.getTime() + 1_000);
    const restartedClaim = await claimNextReview(database, timing);
    expect(restartedClaim?.id).toBe(queued.id);
    expect(restartedClaim?.claimToken).not.toBe(firstClaim.claimToken);
    if (!restartedClaim?.claimToken)
      throw new Error("Retry fixture was not reclaimable after backoff.");
    await processClaimedReview(
      database,
      queued.id,
      subscriptionConfiguration,
      restartedClaim.claimToken,
      { timing, runStage },
    );

    const completed = await database.reviewJob.findUniqueOrThrow({
      where: { id: queued.id },
      include: {
        steps: {
          orderBy: { ordinal: "asc" },
          include: { runs: { orderBy: { attempt: "asc" } } },
        },
      },
    });
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.retryNotBefore).toBeNull();
    expect(completed.steps.every((step) => step.state === "SUCCEEDED")).toBe(
      true,
    );
    expect(completed.steps[0]?.runs[0]).toEqual(preservedRun);
    expect(completed.steps[1]?.runs).toHaveLength(2);
    expect(completed.steps[1]?.runs.map((run) => run.attempt)).toEqual([1, 2]);
    expect(completed.steps[1]?.runs[0]).toEqual(failedRun);
    expect(completed.steps[1]?.runs[1]?.outputHash).toMatch(/^[a-f0-9]{64}$/u);

    const retryAudit = await database.auditEvent.findMany({
      where: {
        action: "REVIEW_AUTOMATIC_RETRY_SCHEDULED",
        subjectId: queued.id,
      },
    });
    expect(retryAudit).toHaveLength(1);
    expect(retryAudit[0]).toMatchObject({
      actorId: null,
      subjectType: "REVIEW_JOB",
      payload: {
        systemActor: "review-worker",
        stageOrdinal: 2,
        stageRole: "critic-nvc",
        failureClass: "PROVIDER_TRANSIENT",
        attempt: 1,
        maximumAttempts: 3,
        scheduledRetryAt: backingOff.retryNotBefore?.toISOString(),
      },
    });
    const nextClaim = await claimNextReview(database, timing);
    expect(nextClaim?.id).toBe(waitingJob.id);
    await workflows.cancelReview({
      actorId: editorTwoId,
      jobId: waitingJob.id,
      reason: "Integration cleanup after focused retry proof",
    });
  });

  it("stops after three retryable attempts and retains the manual retry path", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-retry-exhaustion",
      title: "An exhausted automatic retry scenario",
    });
    const queued = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    let now = new Date(Date.now() + 120_000);
    const timing = {
      now: () => now,
      retryDelaysMs: [1_000, 2_000],
    };
    const runStage = async () => {
      throw doubleTimeoutFailure();
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await claimNextReview(database, timing);
      expect(claim?.id).toBe(queued.id);
      if (!claim?.claimToken)
        throw new Error(`Retry attempt ${attempt} was not claimable.`);
      await processClaimedReview(
        database,
        queued.id,
        subscriptionConfiguration,
        claim.claimToken,
        { timing, runStage },
      );
      const state = await database.reviewJob.findUniqueOrThrow({
        where: { id: queued.id },
      });
      if (attempt < 3) {
        expect(state.state).toBe("QUEUED");
        if (!state.retryNotBefore)
          throw new Error("Retry exhaustion fixture lost its schedule.");
        now = state.retryNotBefore;
      }
    }

    const exhausted = await database.reviewJob.findUniqueOrThrow({
      where: { id: queued.id },
      include: {
        steps: {
          where: { ordinal: 1 },
          include: { runs: { orderBy: { attempt: "asc" } } },
        },
      },
    });
    expect(exhausted).toMatchObject({
      state: "FAILED",
      failureCode: "TRANSIENT",
      retryNotBefore: null,
    });
    expect(exhausted.steps[0]?.state).toBe("FAILED");
    expect(exhausted.steps[0]?.runs.map((run) => run.attempt)).toEqual([
      1, 2, 3,
    ]);
    expect(
      await database.auditEvent.count({
        where: {
          action: "REVIEW_AUTOMATIC_RETRY_SCHEDULED",
          subjectId: queued.id,
        },
      }),
    ).toBe(2);

    const manuallyRetried = await workflows.retryReview({
      actorId: editorOneId,
      jobId: queued.id,
    });
    expect(manuallyRetried).toMatchObject({
      state: "QUEUED",
      retryNotBefore: null,
    });
    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: queued.id,
      reason: "Integration cleanup after manual retry proof",
    });
  });

  it("focuses a selected historical failed review ahead of older queued work without replacing its history", async () => {
    const waiting = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-selected-retry-waiting",
      title: "Older work waiting behind a selected retry",
    });
    const waitingJob = await workflows.queueReview({
      actorId: editorTwoId,
      checkoutId: waiting.checkout.id,
      fence: waiting.checkout.fence,
    });
    const selected = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-selected-retry",
      title: "A historical failed review selected for retry",
    });
    const selectedJob = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: selected.checkout.id,
      fence: selected.checkout.fence,
    });
    const failedStep = selectedJob.steps.find((step) => step.ordinal === 1);
    if (!failedStep)
      throw new Error("Selected retry fixture has no first step.");
    const failedAt = new Date();
    const waitingQueuedAt = new Date(failedAt.getTime() - 60_000);
    const selectedQueuedAt = new Date(failedAt.getTime() - 30_000);
    await database.reviewJob.update({
      where: { id: waitingJob.id },
      data: { queuedAt: waitingQueuedAt },
    });
    const retainedRun = await database.agentRun.create({
      data: {
        stepId: failedStep.id,
        attempt: 1,
        requestedProvider: "codex",
        resolvedProvider: "codex",
        requestedModel: "gpt-5.6-sol",
        resolvedModel: "gpt-5.6-sol",
        reasoningEffort: "high",
        evidenceHash: "b".repeat(64),
        failureClass: "PROVIDER_TRANSIENT",
        retryable: true,
        startedAt: new Date(failedAt.getTime() - 1_000),
        finishedAt: failedAt,
      },
    });
    await database.$transaction([
      database.reviewStep.update({
        where: { id: failedStep.id },
        data: {
          state: "FAILED",
          startedAt: new Date(failedAt.getTime() - 1_000),
          finishedAt: failedAt,
        },
      }),
      database.reviewJob.update({
        where: { id: selectedJob.id },
        data: {
          state: "FAILED",
          queuedAt: selectedQueuedAt,
          finishedAt: failedAt,
          failureCode: "TRANSIENT",
          laneOwner: false,
        },
      }),
    ]);
    const stepIdsBefore = [...selectedJob.steps]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((step) => step.id);
    const queuedAudit = await database.auditEvent.findFirstOrThrow({
      where: {
        action: "REVIEW_QUEUED",
        subjectId: selectedJob.id,
      },
    });

    const retried = await workflows.retryReview({
      actorId: editorOneId,
      jobId: selectedJob.id,
    });

    expect(retried).toMatchObject({
      id: selectedJob.id,
      state: "QUEUED",
      laneOwner: true,
      queuedAt: selectedQueuedAt,
      finishedAt: null,
      failureCode: null,
    });
    const preserved = await database.reviewJob.findUniqueOrThrow({
      where: { id: selectedJob.id },
      include: {
        steps: {
          orderBy: { ordinal: "asc" },
          include: { runs: { orderBy: { attempt: "asc" } } },
        },
      },
    });
    expect(preserved.steps.map((step) => step.id)).toEqual(stepIdsBefore);
    expect(preserved.steps[0]).toMatchObject({ state: "READY" });
    expect(
      preserved.steps.slice(1).every((step) => step.state === "PENDING"),
    ).toBe(true);
    expect(preserved.steps[0]?.runs).toEqual([retainedRun]);
    expect(
      await database.auditEvent.findUnique({ where: { id: queuedAudit.id } }),
    ).toEqual(queuedAudit);
    expect(
      await database.auditEvent.count({
        where: { action: "REVIEW_RETRIED", subjectId: selectedJob.id },
      }),
    ).toBe(1);

    const selectedClaim = await claimNextReview(database);
    expect(selectedClaim?.id).toBe(selectedJob.id);
    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: selectedJob.id,
      reason: "Integration cleanup after selected retry proof",
    });
    const waitingClaim = await claimNextReview(database);
    expect(waitingClaim?.id).toBe(waitingJob.id);
    await workflows.cancelReview({
      actorId: editorTwoId,
      jobId: waitingJob.id,
      reason: "Integration cleanup after waiting-order proof",
    });
  });

  it("rejects a selected retry when another review owns the lane without mutating either review", async () => {
    const focused = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-retry-lane-owner",
      title: "A review already holding the focus lane",
    });
    const focusedJob = await workflows.queueReview({
      actorId: editorTwoId,
      checkoutId: focused.checkout.id,
      fence: focused.checkout.fence,
    });
    await database.reviewJob.update({
      where: { id: focusedJob.id },
      data: { laneOwner: true },
    });
    const selected = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-retry-lane-conflict",
      title: "A failed review selected during another focus",
    });
    const selectedJob = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: selected.checkout.id,
      fence: selected.checkout.fence,
    });
    const failedStep = selectedJob.steps.find((step) => step.ordinal === 1);
    if (!failedStep)
      throw new Error("Lane-conflict fixture has no resumable first step.");
    const failedAt = new Date();
    await database.$transaction([
      database.reviewStep.update({
        where: { id: failedStep.id },
        data: { state: "FAILED", finishedAt: failedAt },
      }),
      database.reviewJob.update({
        where: { id: selectedJob.id },
        data: {
          state: "FAILED",
          finishedAt: failedAt,
          failureCode: "TRANSIENT",
          laneOwner: false,
        },
      }),
    ]);
    const [focusedBefore, selectedBefore, retriedAuditsBefore] =
      await Promise.all([
        database.reviewJob.findUniqueOrThrow({
          where: { id: focusedJob.id },
          include: { steps: { orderBy: { ordinal: "asc" } } },
        }),
        database.reviewJob.findUniqueOrThrow({
          where: { id: selectedJob.id },
          include: { steps: { orderBy: { ordinal: "asc" } } },
        }),
        database.auditEvent.count({
          where: { action: "REVIEW_RETRIED", subjectId: selectedJob.id },
        }),
      ]);

    await expect(
      workflows.retryReview({
        actorId: editorOneId,
        jobId: selectedJob.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "REVIEW_LANE_BUSY",
      message:
        "Another review owns the focused review lane. Finish or stop it before retrying this review.",
    });

    const [focusedAfter, selectedAfter, retriedAuditsAfter] = await Promise.all(
      [
        database.reviewJob.findUniqueOrThrow({
          where: { id: focusedJob.id },
          include: { steps: { orderBy: { ordinal: "asc" } } },
        }),
        database.reviewJob.findUniqueOrThrow({
          where: { id: selectedJob.id },
          include: { steps: { orderBy: { ordinal: "asc" } } },
        }),
        database.auditEvent.count({
          where: { action: "REVIEW_RETRIED", subjectId: selectedJob.id },
        }),
      ],
    );
    expect(focusedAfter).toEqual(focusedBefore);
    expect(selectedAfter).toEqual(selectedBefore);
    expect(retriedAuditsAfter).toBe(retriedAuditsBefore);

    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: selectedJob.id,
      reason: "Integration cleanup after retry lane conflict",
    });
    await workflows.cancelReview({
      actorId: editorTwoId,
      jobId: focusedJob.id,
      reason: "Integration cleanup after focused lane conflict",
    });
  });

  it("rejects a stale request behind the unresolved focused review without hiding or mutating it", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-stale-request-behind-focus",
      title: "A stale request behind the unresolved focused review",
    });
    const focusedJob = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    const firstStep = focusedJob.steps.find((step) => step.ordinal === 1);
    if (!firstStep)
      throw new Error("Stale-request fixture has no first review step.");
    const failedAt = new Date();
    await database.$transaction([
      database.reviewStep.update({
        where: { id: firstStep.id },
        data: { state: "FAILED", finishedAt: failedAt },
      }),
      database.reviewJob.update({
        where: { id: focusedJob.id },
        data: {
          state: "FAILED",
          laneOwner: true,
          finishedAt: failedAt,
          failureCode: "APPLICATION",
          failureReasonCode: "REVIEW_APPLICATION_FAILED",
          failurePhase: "RUN_STAGE",
          failureStageOrdinal: 1,
          failureStageRole: firstStep.roleCode,
        },
      }),
    ]);
    const [jobCountBefore, auditCountBefore, focusedBefore] = await Promise.all(
      [
        database.reviewJob.count({
          where: { checkoutId: created.checkout.id },
        }),
        database.auditEvent.count({
          where: { action: "REVIEW_QUEUED" },
        }),
        database.reviewJob.findUniqueOrThrow({
          where: { id: focusedJob.id },
          include: { steps: { orderBy: { ordinal: "asc" } } },
        }),
      ],
    );

    await expect(
      workflows.queueReview({
        actorId: editorOneId,
        checkoutId: created.checkout.id,
        fence: created.checkout.fence,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "REVIEW_FOCUSED_UNRESOLVED",
      message:
        "This checkout already has the focused review. Finish, retry, or stop it before starting another review.",
    });

    const [jobCountAfter, auditCountAfter, focusedAfter, workspace] =
      await Promise.all([
        database.reviewJob.count({
          where: { checkoutId: created.checkout.id },
        }),
        database.auditEvent.count({
          where: {
            action: "REVIEW_QUEUED",
            subjectType: "REVIEW_JOB",
          },
        }),
        database.reviewJob.findUniqueOrThrow({
          where: { id: focusedJob.id },
          include: { steps: { orderBy: { ordinal: "asc" } } },
        }),
        workflows.workspaceForSlug(
          "integration-review-stale-request-behind-focus",
        ),
      ]);
    expect(jobCountAfter).toBe(jobCountBefore);
    expect(focusedAfter).toEqual(focusedBefore);
    expect(workspace?.reviewJobs[0]?.id).toBe(focusedJob.id);
    expect(auditCountAfter).toBe(auditCountBefore);

    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: focusedJob.id,
      reason: "Integration cleanup after stale request proof",
    });
  });

  it("keeps an explicitly non-retryable provider failure terminal", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-nonretryable",
      title: "A non-retryable authentication failure scenario",
    });
    const queued = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    const now = new Date(Date.now() + 180_000);
    const timing = { now: () => now, retryDelaysMs: [1_000, 2_000] };
    const waiting = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-waits-for-terminal-resolution",
      title: "A review waiting behind a terminal failure",
    });
    const waitingJob = await workflows.queueReview({
      actorId: editorTwoId,
      checkoutId: waiting.checkout.id,
      fence: waiting.checkout.fence,
    });
    const runStage = async () => {
      throw new AdapterFailure(
        "AUTHENTICATION",
        "Provider authentication is unavailable.",
        false,
        [
          {
            provider: "codex",
            model: "gpt-5.6-sol",
            durationMs: 100,
            outcome: "FAILED",
            failureClass: "AUTHENTICATION",
            retryable: false,
          },
        ],
      );
    };
    const claim = await claimNextReview(database, timing);
    if (!claim?.claimToken)
      throw new Error("Non-retryable fixture was not claimable.");
    await processClaimedReview(
      database,
      queued.id,
      subscriptionConfiguration,
      claim.claimToken,
      { timing, runStage },
    );

    const failed = await database.reviewJob.findUniqueOrThrow({
      where: { id: queued.id },
      include: { steps: { where: { ordinal: 1 }, include: { runs: true } } },
    });
    expect(failed).toMatchObject({
      state: "FAILED",
      laneOwner: true,
      failureCode: "AUTHENTICATION",
      failureReasonCode: "PROVIDER_AUTHENTICATION",
      retryNotBefore: null,
    });
    expect(failed.steps[0]?.runs).toHaveLength(1);
    expect(failed.steps[0]?.runs[0]).toMatchObject({
      failureClass: "PROVIDER_AUTH",
      retryable: false,
    });
    expect(
      await database.auditEvent.count({
        where: {
          action: "REVIEW_AUTOMATIC_RETRY_SCHEDULED",
          subjectId: queued.id,
        },
      }),
    ).toBe(0);
    expect(await claimNextReview(database, timing)).toBeNull();
    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: queued.id,
      reason: "Stop failed review and release focused lane",
    });
    const waitingClaim = await claimNextReview(database, timing);
    expect(waitingClaim?.id).toBe(waitingJob.id);
    await workflows.cancelReview({
      actorId: editorTwoId,
      jobId: waitingJob.id,
      reason: "Integration cleanup after terminal lane proof",
    });
  });

  it("honors cancellation and checkout fencing while a retry is backing off", async () => {
    let now = new Date(Date.now() + 240_000);
    const timing = { now: () => now, retryDelaysMs: [1_000, 2_000] };
    const runStage = async () => {
      throw doubleTimeoutFailure();
    };

    const cancelledFixture = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-backoff-cancel",
      title: "A cancelled retry backoff scenario",
    });
    const cancelledJob = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: cancelledFixture.checkout.id,
      fence: cancelledFixture.checkout.fence,
    });
    const cancellationClaim = await claimNextReview(database, timing);
    if (!cancellationClaim?.claimToken)
      throw new Error("Cancellation fixture was not claimable.");
    await processClaimedReview(
      database,
      cancelledJob.id,
      subscriptionConfiguration,
      cancellationClaim.claimToken,
      { timing, runStage },
    );
    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: cancelledJob.id,
      reason: "Cancel during durable backoff",
    });
    now = new Date(now.getTime() + 5_000);
    expect(await claimNextReview(database, timing)).toBeNull();
    const cancelled = await database.reviewJob.findUniqueOrThrow({
      where: { id: cancelledJob.id },
      include: { steps: true },
    });
    expect(cancelled).toMatchObject({
      state: "CANCELLED",
      fence: 2n,
      retryNotBefore: null,
    });
    expect(cancelled.steps.every((step) => step.state === "CANCELLED")).toBe(
      true,
    );

    const fencedFixture = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-backoff-fence",
      title: "A fenced retry backoff scenario",
    });
    const fencedJob = await workflows.queueReview({
      actorId: editorTwoId,
      checkoutId: fencedFixture.checkout.id,
      fence: fencedFixture.checkout.fence,
    });
    const fencingClaim = await claimNextReview(database, timing);
    if (!fencingClaim?.claimToken)
      throw new Error("Fencing fixture was not claimable.");
    await processClaimedReview(
      database,
      fencedJob.id,
      subscriptionConfiguration,
      fencingClaim.claimToken,
      { timing, runStage },
    );
    await workflows.forceCheckInSituation({
      adminId,
      situationId: fencedFixture.situation.id,
      reason: "Fence retry during integration backoff",
    });
    now = new Date(now.getTime() + 5_000);
    expect(await claimNextReview(database, timing)).toBeNull();
    const fenced = await database.reviewJob.findUniqueOrThrow({
      where: { id: fencedJob.id },
      include: { steps: true },
    });
    expect(fenced).toMatchObject({
      state: "CANCELLED",
      fence: 2n,
      retryNotBefore: null,
    });
    expect(fenced.steps.every((step) => step.state === "CANCELLED")).toBe(true);
  });

  it("reclaims an expired stage lease and records the interrupted attempt", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-lease-reclaim",
      title: "A durable review lease reclamation scenario",
    });
    const queued = await workflows.queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    const firstClaim = await claimNextReview(database);
    expect(firstClaim?.id).toBe(queued.id);
    const firstStep = await database.reviewStep.findFirstOrThrow({
      where: { jobId: queued.id, ordinal: 1 },
    });
    await database.reviewStep.update({
      where: { id: firstStep.id },
      data: { state: "RUNNING", startedAt: new Date() },
    });
    await database.agentRun.create({
      data: {
        stepId: firstStep.id,
        attempt: 1,
        requestedProvider: "deterministic",
        requestedModel: "deterministic-provider-v1",
        reasoningEffort: "high",
        evidenceHash: "a".repeat(64),
      },
    });
    await database.reviewJob.update({
      where: { id: queued.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    const reclaimed = await claimNextReview(database);
    expect(reclaimed?.id).toBe(queued.id);
    expect(reclaimed?.claimToken).not.toBe(firstClaim?.claimToken);
    if (!reclaimed?.claimToken)
      throw new Error("Reclaimed review did not receive a lease token.");
    await processClaimedReview(
      database,
      queued.id,
      { mode: "deterministic" },
      reclaimed.claimToken,
    );
    const completed = await database.reviewJob.findUniqueOrThrow({
      where: { id: queued.id },
      include: {
        steps: {
          where: { ordinal: 1 },
          include: { runs: { orderBy: { attempt: "asc" } } },
        },
      },
    });
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.steps[0]?.runs).toHaveLength(2);
    expect(completed.steps[0]?.runs[0]).toMatchObject({
      failureClass: "APPLICATION",
      retryable: false,
    });
    expect(completed.steps[0]?.runs[1]?.outputHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
