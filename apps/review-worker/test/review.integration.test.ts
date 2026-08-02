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
  bundleHash,
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
  requiredPublicationCompilerIdentity,
  requiredSituationContractIdentity,
} from "@situation-studio/leadership-bridge";
import {
  AdapterFailure,
  bundleWriterOutputSchema,
  candidateAuditOutputSchema,
  candidateBuilderOutputSchema,
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
  REVIEW_TOTAL_DEADLINE_MS,
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
      publicationCompiler: requiredPublicationCompilerIdentity,
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

  async function queueReview(input: {
    actorId: string;
    checkoutId: string;
    fence: bigint;
  }) {
    const checkout = await database.situationCheckout.findUniqueOrThrow({
      where: { id: input.checkoutId },
      include: {
        draft: {
          include: {
            revisions: { orderBy: { revision: "desc" }, take: 1 },
          },
        },
      },
    });
    const revision = checkout.draft.revisions[0];
    if (!revision) throw new Error("Review fixture has no current revision.");
    return workflows.queueReview({
      ...input,
      revisionId: revision.id,
      bundleHash: revision.bundleHash,
    });
  }

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
          if (request.role === "critical-review")
            expect(request.system).toContain("Nonviolent Communication");
          if (request.role === "candidate-audit")
            expect(request.system).toContain("FIRST_ACTION_IN_30_SECONDS");
          expect(runtimeOptions?.providerTimeoutMs).toBe(
            REVIEW_PROVIDER_TIMEOUT_MS,
          );
          const base = await successfulStage(request);
          const output =
            request.role === "critical-review"
              ? normalizedOutputSchema.parse({
                  role: request.role,
                  summary: "Structured candidate findings.",
                  findings: input.findings,
                  provenance: "candidate-integration",
                })
              : request.role === "candidate-builder"
                ? candidateBuilderOutputSchema.parse({
                    role: request.role,
                    summary:
                      "A concise candidate revision grounded in retained findings.",
                    findings: [],
                    provenance: "candidate-integration",
                    changeIntents: input.candidateEdits.map(
                      ({
                        id: _id,
                        applicationMode: _applicationMode,
                        beforeHash: _beforeHash,
                        writtenByRoleCode: _writtenByRoleCode,
                        ...intent
                      }) => intent,
                    ),
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
          stageRole: "context-mapper",
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
          stageRole: "candidate-audit",
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
    const observation = await database.leadershipReleaseObservation.create({
      data: {
        releaseId: randomUUID(),
        manifestHash: "d".repeat(64),
        pointerGeneration: 1n,
        state: "CURRENT",
        sourceKind: "BOOTSTRAP_IMPORT",
        manifest: {},
        publishedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    const defaultPractice = {
      kind: "PRACTICE" as const,
      logicalId: "practice:listen-first",
      position: 0,
      contentHash: "a".repeat(64),
      visibility: "GLOBAL" as const,
    };
    const defaultSource = {
      kind: "SOURCE" as const,
      logicalId: "source:fixture-source",
      position: 0,
      contentHash: "b".repeat(64),
      visibility: "GLOBAL" as const,
    };
    for (const [slug, title] of [
      ["review-context-alpha", "Review context alpha situation"],
      ["review-context-beta", "Review context beta situation"],
    ] as const) {
      const situation = await database.situation.create({
        data: { slug, title, visibility: "PUBLIC" },
      });
      const template = workflows.newSituationTemplate({
        situationId: situation.id,
        slug,
        title,
        today: "2026-08-01",
        defaultPractice,
        defaultSource,
        defaultSourceReference: "fixture-source",
        defaultRelatedSituationIds: [
          "related-context-one",
          "related-context-two",
        ],
      });
      const hash = bundleHash(template.bundle);
      await database.situation.update({
        where: { id: situation.id },
        data: {
          productionBundleHash: hash,
          productionReleaseId: observation.releaseId,
          productionAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      });
      await database.productionSituationVersion.create({
        data: {
          situationId: situation.id,
          observationId: observation.id,
          bundleHash: hash,
          bundleManifest: template.bundle,
          contractVersion: template.bundle.contractVersion,
          validationPolicy: template.bundle.validationPolicyVersion,
          sourceKind: "CREATE",
          productionAt: new Date("2026-08-01T00:00:00.000Z"),
          changeSummary: "Review integration context fixture",
        },
      });
    }
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
    const competingBody = canonicalText(
      body.replace(
        "Name what you are seeing",
        "Name a competing exact observation before responding",
      ),
    );
    const overlappingSaves = await Promise.allSettled([
      workflows.saveDraft({
        actorId: checkout.holderId,
        checkoutId: checkout.id,
        fence: checkout.fence,
        expectedParentRevisionId: revision.id,
        expectedParentBundleHash: revision.bundleHash,
        body: changedBody,
        bundle: {
          ...situationBundleSchema.parse(revision.bundleManifest),
          bodyHash: sha256(changedBody),
        },
        namedCheckpoint: "Integration exact draft",
      }),
      workflows.saveDraft({
        actorId: checkout.holderId,
        checkoutId: checkout.id,
        fence: checkout.fence,
        expectedParentRevisionId: revision.id,
        expectedParentBundleHash: revision.bundleHash,
        body: competingBody,
        bundle: {
          ...situationBundleSchema.parse(revision.bundleManifest),
          bodyHash: sha256(competingBody),
        },
        namedCheckpoint: "Competing integration draft",
      }),
    ]);
    const successfulSaves = overlappingSaves.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof workflows.saveDraft>>
      > => result.status === "fulfilled",
    );
    const rejectedSaves = overlappingSaves.filter(
      (result) => result.status === "rejected",
    );
    expect(successfulSaves).toHaveLength(1);
    expect(rejectedSaves).toHaveLength(1);
    expect(rejectedSaves[0]).toMatchObject({
      reason: expect.objectContaining({ code: "STALE_REVISION" }),
    });
    const saved = successfulSaves[0]!.value;
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
    const queued = await queueReview({
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
        expectedParentRevisionId: saved.id,
        expectedParentBundleHash: saved.bundleHash,
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

  it("migrates a retained v2 UNPUBLISHED draft through an explicit fenced forward revision", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-public-intent-forward",
      title: "An explicit publication intent migration",
    });
    const workspace = await workflows.workspaceForSlug(created.situation.slug);
    const current = workspace?.drafts[0]?.revisions[0];
    const body = current?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    )?.content.textBody;
    if (!current || !body)
      throw new Error("Publication-intent fixture is unavailable.");
    const currentBundle = situationBundleSchema.parse(current.bundleManifest);
    if (currentBundle.schemaVersion !== "situation-bundle-v2")
      throw new Error("Publication-intent fixture is not v2.");
    const retainedBundle = situationBundleSchema.parse({
      ...currentBundle,
      visibility: "UNPUBLISHED",
    });
    const retainedHash = bundleHash(retainedBundle);

    // Reproduce an immutable row written by the prior v2 release. The local
    // replication role suppresses user triggers only inside this fixture
    // transaction; the workflow must migrate it by appending, never rewriting.
    await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        "SET LOCAL session_replication_role = replica",
      );
      await transaction.$executeRaw`
        UPDATE draft_revisions
           SET bundle_manifest = ${JSON.stringify(retainedBundle)}::jsonb,
               bundle_hash = ${retainedHash}
         WHERE id = ${current.id}::uuid
      `;
      await transaction.$executeRaw`
        UPDATE drafts
           SET current_bundle_hash = ${retainedHash}
         WHERE id = ${created.draft.id}::uuid
      `;
    });

    const advanced = await workflows.saveDraft({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      expectedParentRevisionId: current.id,
      expectedParentBundleHash: retainedHash,
      body,
      bundle: {
        ...retainedBundle,
        visibility: "PUBLIC",
      },
      namedCheckpoint: "Set explicit public intent",
    });
    expect(advanced.id).not.toBe(current.id);
    expect(advanced.parentId).toBe(current.id);
    expect(
      situationBundleSchema.parse(advanced.bundleManifest).visibility,
    ).toBe("PUBLIC");
    await expect(
      database.auditEvent.count({
        where: {
          action: "PUBLICATION_INTENT_SET",
          actorId: editorOneId,
          subjectId: advanced.id,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      database.draftRevision.findUniqueOrThrow({
        where: { id: current.id },
        select: { bundleManifest: true },
      }),
    ).resolves.toMatchObject({
      bundleManifest: expect.objectContaining({ visibility: "UNPUBLISHED" }),
    });
  });

  it("runs every policy stage once, globally serializes jobs, and fences cancellation", async () => {
    const first = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-one",
      title: "A first complete deterministic review",
    });
    const firstJob = await queueReview({
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
    const pinnedRevision = await database.draftRevision.findFirstOrThrow({
      where: { draftId: first.draft.id },
      orderBy: { revision: "desc" },
      include: {
        artifacts: {
          where: { kind: "SITUATION" },
          include: { content: true },
        },
      },
    });
    const pinnedBody = pinnedRevision.artifacts[0]?.content.textBody;
    if (!pinnedBody) throw new Error("Pinned review body is missing.");
    const laterBody = canonicalText(
      pinnedBody.replace(
        "Name what you are seeing",
        "Name the specific pattern you are seeing",
      ),
    );
    const laterRevision = await workflows.saveDraft({
      actorId: editorOneId,
      checkoutId: first.checkout.id,
      fence: first.checkout.fence,
      expectedParentRevisionId: pinnedRevision.id,
      expectedParentBundleHash: pinnedRevision.bundleHash,
      body: laterBody,
      bundle: {
        ...situationBundleSchema.parse(pinnedRevision.bundleManifest),
        bodyHash: sha256(laterBody),
      },
    });
    expect(laterRevision.id).not.toBe(firstJob.inputRevisionId);
    expect(firstJob.inputRevisionId).toBe(pinnedRevision.id);
    await expect(
      workflows.queueReview({
        actorId: editorOneId,
        checkoutId: first.checkout.id,
        fence: first.checkout.fence,
        revisionId: pinnedRevision.id,
        bundleHash: pinnedRevision.bundleHash,
      }),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });

    const claimedFirst = await claimNextReview(database);
    expect(claimedFirst?.id).toBe(firstJob.id);
    const second = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-two",
      title: "A second serialized deterministic review",
    });
    const secondJob = await queueReview({
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
    expect(completed.proposal).toMatchObject({
      currentRevisionId: firstJob.inputRevisionId,
      currentBundleHash: firstJob.inputBundleHash,
      supersededByRevisionId: laterRevision.id,
    });
    expect(completed.proposal?.supersededAt).not.toBeNull();
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
    ).toBe(pinnedRevisionCount + 1);
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
    const thirdJob = await queueReview({
      actorId: editorOneId,
      checkoutId: third.checkout.id,
      fence: third.checkout.fence,
    });
    expect((await claimNextReview(database))?.id).toBe(thirdJob.id);
    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: thirdJob.id,
      revisionId: thirdJob.inputRevisionId,
      bundleHash: thirdJob.inputBundleHash,
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
    const job = await queueReview({
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
          upstreamFindingIds: ["critical-review:observable-opening"],
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
          upstreamFindingIds: ["critical-review:observable-opening"],
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
      findingKey: "critical-review:observable-opening",
      sourceRoleCode: "critical-review",
      evidenceRoleCodes: ["critic-manager-tools"],
    });
    const automaticChange = completed.proposal?.changes.find(
      (change) => change.targetKind === "SECTION",
    );
    const manualChange = completed.proposal?.changes.find(
      (change) => change.targetKind === "EMBED",
    );
    if (!automaticChange || !manualChange || !completed.proposal)
      throw new Error("Server-materialized proposal changes are missing.");
    expect(automaticChange).toMatchObject({
      beforeBody: inputSections["The short answer"],
      writtenByRoleCode: "candidate-builder",
      identifiedByRoleCodes: ["critical-review"],
      applicationMode: "AUTOMATIC",
    });
    expect(automaticChange.id).not.toBe(automaticId);
    expect(manualChange.id).not.toBe(manualId);
    expect(automaticChange.findingLinks[0]?.finding.findingKey).toBe(
      "critical-review:observable-opening",
    );
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
      changeId: automaticChange.id,
      editedBody: editorReplacement,
      revisionId: completed.proposal.currentRevisionId,
      bundleHash: completed.proposal.currentBundleHash,
    });
    await workflows.decideProposalChange({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      changeId: manualChange.id,
      decision: "REJECT",
      revisionId: completed.proposal.currentRevisionId,
      bundleHash: completed.proposal.currentBundleHash,
    });
    const accepted = await workflows.decideProposalChange({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      changeId: automaticChange.id,
      decision: "ACCEPT",
      revisionId: completed.proposal.currentRevisionId,
      bundleHash: completed.proposal.currentBundleHash,
    });
    const applied = await database.draftRevision.findUniqueOrThrow({
      where: { id: accepted.authoritativeRevision.revisionId },
      include: { artifacts: { include: { content: true } } },
    });
    expect(
      applied.artifacts.find((artifact) => artifact.kind === "SITUATION")
        ?.content.textBody,
    ).toContain(editorReplacement);
    expect(
      await database.proposalChange.findUniqueOrThrow({
        where: { id: automaticChange.id },
      }),
    ).toMatchObject({
      state: "ACCEPTED",
      editorBody: editorReplacement,
      appliedRevisionId: accepted.authoritativeRevision.revisionId,
    });
    expect(
      await database.auditEvent.findMany({
        where: {
          subjectId: { in: [automaticChange.id, manualChange.id] },
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
      expectedParentRevisionId: inputRevision.id,
      expectedParentBundleHash: inputRevision.bundleHash,
      bundle: {
        ...situationBundleSchema.parse(inputRevision.bundleManifest),
        bodyHash: sha256(canonicalText(nestedBody)),
      },
      body: nestedBody,
      namedCheckpoint: "Nested candidate target fixture",
    });
    const job = await queueReview({
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
          upstreamFindingIds: ["critical-review:granular-targets"],
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
          upstreamFindingIds: ["critical-review:granular-targets"],
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
          upstreamFindingIds: ["critical-review:granular-targets"],
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
      revisionId: completed.proposal!.currentRevisionId,
      bundleHash: completed.proposal!.currentBundleHash,
    });
    const applied = await database.draftRevision.findUniqueOrThrow({
      where: { id: accepted.authoritativeRevision.revisionId },
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
    const job = await queueReview({
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
          upstreamFindingIds: ["CRITICAL-REVIEW:case-only-lineage"],
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

  it("isolates a suggestion with broken finding lineage as non-actionable", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-materialization-error-log",
      title: "A logged proposal materialization failure",
    });
    const job = await queueReview({
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
          if (request.role !== "candidate-builder") return base;
          const output = candidateBuilderOutputSchema.parse({
            role: request.role,
            summary: "A candidate with intentionally broken lineage.",
            findings: [],
            provenance: "materialization-error-log-test",
            changeIntents: [
              {
                targetKind: "SECTION",
                targetKey: "The short answer",
                afterBody: "Name the observed pattern and ask for their view.",
                problem: "The opening needs a bounded repair.",
                explanation: "Proposes a concise replacement.",
                rationale: "The missing lineage is intentional in this test.",
                upstreamFindingIds: ["critical-review:missing-finding"],
                evidenceRoleCodes: ["critical-review"],
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
    const completed = await database.reviewJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { proposal: { include: { changes: true, findings: true } } },
    });
    expect(completed).toMatchObject({ state: "SUCCEEDED", laneOwner: false });
    expect(completed.proposal?.changes).toHaveLength(0);
    expect(completed.proposal?.findings).toEqual([
      expect.objectContaining({
        findingKey: "candidate-builder:discarded-intent-1",
        severity: "IMPORTANT",
        summary: "A candidate suggestion was kept non-actionable.",
      }),
    ]);
    expect(events).toHaveLength(0);
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
    const job = await queueReview({
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
          upstreamFindingIds: ["critical-review:rejectable-change-set"],
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
          upstreamFindingIds: ["critical-review:rejectable-change-set"],
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
      revisionId: proposal.currentRevisionId,
      bundleHash: proposal.currentBundleHash,
    });
    expect(rejected).toMatchObject({ state: "REJECTED", rejectedCount: 2 });
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
    const baseBundle = situationBundleSchema.parse(
      initialRevision.bundleManifest,
    );
    const sections = parseSituationSections(initialBody);
    const nextTitle = "An atomically accepted structured agent revision";
    const ids = {
      section: randomUUID(),
      metadata: randomUUID(),
      relationship: randomUUID(),
      manual: randomUUID(),
    };
    const job = await queueReview({
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
          upstreamFindingIds: ["critical-review:structured-bundle"],
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
          upstreamFindingIds: ["critical-review:structured-bundle"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-manager-tools"],
        },
        {
          id: ids.relationship,
          targetKind: "RELATIONSHIP",
          targetKey: "practice:unsupported-global",
          applicationMode: "AUTOMATIC",
          beforeHash: null,
          afterBody: canonicalJson({
            kind: "PRACTICE",
            logicalId: "practice:unsupported-global",
            originalLogicalId: "practice:unsupported-global",
            position: 0,
            contentHash: "a".repeat(64),
            visibility: "GLOBAL",
          }),
          problem: "The linked practice does not match the revised sequence.",
          explanation: "Requests an unsupported global relationship change.",
          rationale:
            "Relationship mutations require an editor to verify the linked content.",
          upstreamFindingIds: ["critical-review:structured-bundle"],
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
          upstreamFindingIds: ["critical-review:structured-bundle"],
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
      include: { changes: true },
    });
    const sectionChange = proposal.changes.find(
      (change) => change.targetKind === "SECTION",
    );
    const metadataChange = proposal.changes.find(
      (change) => change.targetKind === "METADATA",
    );
    const relationshipChange = proposal.changes.find(
      (change) => change.targetKind === "RELATIONSHIP",
    );
    const manualChange = proposal.changes.find(
      (change) => change.targetKind === "EMBED",
    );
    if (
      !sectionChange ||
      !metadataChange ||
      !relationshipChange ||
      !manualChange
    )
      throw new Error("Atomic proposal changes are incomplete.");
    expect(sectionChange).toMatchObject({ applicationMode: "AUTOMATIC" });
    expect(metadataChange).toMatchObject({ applicationMode: "AUTOMATIC" });
    expect(relationshipChange).toMatchObject({ applicationMode: "MANUAL" });
    expect(manualChange).toMatchObject({ applicationMode: "MANUAL" });
    expect(sectionChange.id).not.toBe(ids.section);
    expect(metadataChange.id).not.toBe(ids.metadata);
    expect(relationshipChange.id).not.toBe(ids.relationship);
    expect(manualChange.id).not.toBe(ids.manual);
    const accepted = await workflows.acceptAllProposalChanges({
      actorId: editorTwoId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      proposalId: proposal.id,
      revisionId: proposal.currentRevisionId,
      bundleHash: proposal.currentBundleHash,
    });
    expect(accepted).toMatchObject({
      appliedCount: 2,
      manualRemainingCount: 2,
    });
    expect(
      await database.draftRevision.count({
        where: { draftId: created.draft.id },
      }),
    ).toBe(beforeAtomicCount + 1);
    const applied = await database.draftRevision.findUniqueOrThrow({
      where: { id: accepted.authoritativeRevision.revisionId },
      include: { artifacts: { include: { content: true } } },
    });
    const appliedBundle = situationBundleSchema.parse(applied.bundleManifest);
    expect(appliedBundle.metadata.title).toBe(nextTitle);
    expect(
      appliedBundle.relationships.some(
        (relationship) =>
          relationship.logicalId === "practice:unsupported-global",
      ),
    ).toBe(false);
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
        where: { id: manualChange.id },
      }),
    ).toMatchObject({ state: "PENDING", applicationMode: "MANUAL" });
    expect(
      await database.proposalChange.count({
        where: {
          id: {
            in: [sectionChange.id, metadataChange.id],
          },
          state: "ACCEPTED",
          appliedRevisionId: accepted.authoritativeRevision.revisionId,
        },
      }),
    ).toBe(2);
    expect(
      await database.proposalChange.count({
        where: {
          id: { in: [relationshipChange.id, manualChange.id] },
          state: "PENDING",
          applicationMode: "MANUAL",
        },
      }),
    ).toBe(2);

    const staleJob = await queueReview({
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
    const modelStaleChangeId = randomUUID();
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
          id: modelStaleChangeId,
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
          upstreamFindingIds: ["critical-review:stale-target"],
          writtenByRoleCode: "bundle-writer",
          evidenceRoleCodes: ["critic-nvc"],
        },
      ],
    });
    const staleProposal = await database.reviewProposal.findUniqueOrThrow({
      where: { jobId: staleJob.id },
      include: { changes: true },
    });
    const staleChange = staleProposal.changes.find(
      (change) => change.targetKind === "SECTION",
    );
    if (!staleChange) throw new Error("Stale proposal change is missing.");
    expect(staleChange.id).not.toBe(modelStaleChangeId);
    const manuallyChangedBody = serializeSituationSections({
      ...currentSections,
      "The short answer":
        "The editor changed this exact target after the review.",
    });
    const saved = await workflows.saveDraft({
      actorId: editorTwoId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
      expectedParentRevisionId: currentRevision.id,
      expectedParentBundleHash: currentRevision.bundleHash,
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
        changeId: staleChange.id,
        decision: "ACCEPT",
        revisionId: saved.id,
        bundleHash: saved.bundleHash,
      }),
    ).rejects.toMatchObject({ code: "SUPERSEDED_PROPOSAL" });
    expect(
      await database.proposalChange.findUniqueOrThrow({
        where: { id: staleChange.id },
      }),
    ).toMatchObject({ state: "PENDING", appliedRevisionId: null });
    expect(saved.bundleHash).not.toBe(currentRevision.bundleHash);
  });

  it("permits one bounded candidate repair before a passing audit", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-one-repair",
      title: "A review that needs one bounded candidate repair",
    });
    const job = await queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    const claim = await claimNextReview(database);
    expect(claim?.id).toBe(job.id);
    if (!claim?.claimToken)
      throw new Error("Repair review did not receive a claim.");
    let auditAttempts = 0;
    let builderAttempts = 0;
    let repairEvidenceIncludedAudit = false;
    await processClaimedReview(
      database,
      job.id,
      subscriptionConfiguration,
      claim.claimToken,
      {
        runStage: async (request) => {
          const base = await successfulStage(request);
          if (request.role === "candidate-builder") {
            builderAttempts += 1;
            if (builderAttempts === 2)
              repairEvidenceIncludedAudit = request.evidence.includes(
                '"role":"candidate-audit"',
              );
          }
          if (request.role !== "candidate-audit") return base;
          auditAttempts += 1;
          const evidence = JSON.parse(request.evidence) as {
            materializedCandidate?: { candidateHash?: unknown };
          };
          const candidateHash = evidence.materializedCandidate?.candidateHash;
          if (typeof candidateHash !== "string")
            throw new Error(
              "Repair audit evidence omitted the candidate hash.",
            );
          const output = candidateAuditOutputSchema.parse(
            auditAttempts === 1
              ? {
                  role: "candidate-audit",
                  summary: "The first candidate retains one blocker.",
                  findings: [
                    {
                      id: "repair-required",
                      severity: "blocking",
                      targetKind: "BUNDLE",
                      targetKey: "candidate",
                      summary: "The candidate needs one bounded repair.",
                      rationale:
                        "The repair pass must see and resolve this exact blocker.",
                      evidenceRoleCodes: ["candidate-audit"],
                    },
                  ],
                  provenance: "candidate-repair-integration",
                  candidateHash,
                  verdict: "REVISE",
                  blockingFindingIds: ["candidate-audit:repair-required"],
                }
              : {
                  role: "candidate-audit",
                  summary: "The repaired candidate passes the exact audit.",
                  findings: [],
                  provenance: "candidate-repair-integration",
                  candidateHash,
                  verdict: "PASS",
                  blockingFindingIds: [],
                },
          );
          return {
            ...base,
            output,
            outputHash: sha256(JSON.stringify(output)),
          };
        },
      },
    );

    const completed = await database.reviewJob.findUniqueOrThrow({
      where: { id: job.id },
      include: {
        proposal: true,
        steps: {
          include: { runs: { orderBy: { attempt: "asc" } } },
          orderBy: { ordinal: "asc" },
        },
      },
    });
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.proposal).not.toBeNull();
    expect(builderAttempts).toBe(2);
    expect(auditAttempts).toBe(2);
    expect(repairEvidenceIncludedAudit).toBe(true);
    expect(
      completed.steps.find((step) => step.roleCode === "candidate-builder")
        ?.runs,
    ).toHaveLength(2);
    expect(
      completed.steps.find((step) => step.roleCode === "candidate-audit")?.runs,
    ).toHaveLength(2);
    expect(
      await database.auditEvent.count({
        where: {
          action: "REVIEW_CANDIDATE_REPAIR_SCHEDULED",
          subjectId: job.id,
        },
      }),
    ).toBe(1);
  });

  it("fails after a second blocking audit and releases the global lane", async () => {
    const blocked = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-blocking-audit",
      title: "A candidate that retains a blocking audit finding",
    });
    const blockedJob = await queueReview({
      actorId: editorOneId,
      checkoutId: blocked.checkout.id,
      fence: blocked.checkout.fence,
    });
    const claim = await claimNextReview(database);
    expect(claim?.id).toBe(blockedJob.id);
    if (!claim?.claimToken)
      throw new Error("Blocking review did not receive a claim.");
    let auditAttempts = 0;
    await processClaimedReview(
      database,
      blockedJob.id,
      subscriptionConfiguration,
      claim.claimToken,
      {
        runStage: async (request) => {
          const base = await successfulStage(request);
          if (request.role !== "candidate-audit") return base;
          auditAttempts += 1;
          const evidence = JSON.parse(request.evidence) as {
            materializedCandidate?: { candidateHash?: unknown };
          };
          const candidateHash = evidence.materializedCandidate?.candidateHash;
          if (typeof candidateHash !== "string")
            throw new Error(
              "Blocking audit evidence omitted the candidate hash.",
            );
          const output = candidateAuditOutputSchema.parse({
            role: "candidate-audit",
            summary: "The exact candidate retains a blocking finding.",
            findings: [
              {
                id: "still-blocked",
                severity: "blocking",
                targetKind: "BUNDLE",
                targetKey: "candidate",
                summary: "The candidate remains unsafe after repair.",
                rationale:
                  "A second blocking verdict must prevent proposal creation.",
                evidenceRoleCodes: ["candidate-audit"],
              },
            ],
            provenance: "candidate-blocking-integration",
            candidateHash,
            verdict: "REVISE",
            blockingFindingIds: ["candidate-audit:still-blocked"],
          });
          return {
            ...base,
            output,
            outputHash: sha256(JSON.stringify(output)),
          };
        },
      },
    );

    const failed = await database.reviewJob.findUniqueOrThrow({
      where: { id: blockedJob.id },
      include: { proposal: true },
    });
    expect(auditAttempts).toBe(2);
    expect(failed).toMatchObject({
      state: "FAILED",
      failureReasonCode: "CANDIDATE_AUDIT_REVISE",
      failurePhase: "VALIDATE_CANDIDATE",
      failureStageRole: "candidate-audit",
      laneOwner: false,
      claimToken: null,
    });
    expect(failed.proposal).toBeNull();

    const unrelated = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-after-blocking-audit",
      title: "An unrelated review after a blocking audit",
    });
    const unrelatedJob = await queueReview({
      actorId: editorTwoId,
      checkoutId: unrelated.checkout.id,
      fence: unrelated.checkout.fence,
    });
    expect((await claimNextReview(database))?.id).toBe(unrelatedJob.id);
    await workflows.cancelReview({
      actorId: editorTwoId,
      jobId: unrelatedJob.id,
      revisionId: unrelatedJob.inputRevisionId,
      bundleHash: unrelatedJob.inputBundleHash,
      reason: "Blocking audit lane release verified",
    });
  });

  it("enforces the total job deadline before starting another model stage", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-total-deadline",
      title: "A review that exceeds its total bounded deadline",
    });
    const job = await queueReview({
      actorId: editorOneId,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    const claim = await claimNextReview(database);
    expect(claim?.id).toBe(job.id);
    if (!claim?.claimToken)
      throw new Error("Deadline review did not receive a claim.");
    await database.reviewJob.update({
      where: { id: job.id },
      data: {
        startedAt: new Date(Date.now() - REVIEW_TOTAL_DEADLINE_MS - 1_000),
      },
    });
    let stageCalls = 0;
    await processClaimedReview(
      database,
      job.id,
      subscriptionConfiguration,
      claim.claimToken,
      {
        runStage: async (request) => {
          stageCalls += 1;
          return successfulStage(request);
        },
      },
    );
    const failed = await database.reviewJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { proposal: true, steps: { include: { runs: true } } },
    });
    expect(stageCalls).toBe(0);
    expect(failed).toMatchObject({
      state: "FAILED",
      failureReasonCode: "REVIEW_JOB_DEADLINE_EXCEEDED",
      failurePhase: "RUN_STAGE",
      laneOwner: false,
      claimToken: null,
    });
    expect(failed.proposal).toBeNull();
    expect(failed.steps.flatMap((step) => step.runs)).toHaveLength(0);
  });

  it("durably backs off after a timeout, survives restart, and preserves immutable successful-stage history", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-timeout-recovery",
      title: "A retryable timeout recovery scenario",
    });
    const queued = await queueReview({
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
      if (request.role === "critical-review") {
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
        stageRole: "critical-review",
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
    const waitingJob = await queueReview({
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
        stageRole: "critical-review",
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
      revisionId: waitingJob.inputRevisionId,
      bundleHash: waitingJob.inputBundleHash,
      reason: "Integration cleanup after focused retry proof",
    });
  });

  it("stops after three retryable attempts and retains the manual retry path", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-retry-exhaustion",
      title: "An exhausted automatic retry scenario",
    });
    const queued = await queueReview({
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

    await expect(
      workflows.retryReview({
        actorId: editorOneId,
        jobId: queued.id,
        revisionId: queued.inputRevisionId,
        bundleHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "STALE_REVIEW", status: 409 });
    const manuallyRetried = await workflows.retryReview({
      actorId: editorOneId,
      jobId: queued.id,
      revisionId: queued.inputRevisionId,
      bundleHash: queued.inputBundleHash,
    });
    expect(manuallyRetried).toMatchObject({
      state: "QUEUED",
      retryNotBefore: null,
    });
    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: queued.id,
      revisionId: queued.inputRevisionId,
      bundleHash: queued.inputBundleHash,
      reason: "Integration cleanup after manual retry proof",
    });
  });

  it("focuses a selected historical failed review ahead of older queued work without replacing its history", async () => {
    const waiting = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-selected-retry-waiting",
      title: "Older work waiting behind a selected retry",
    });
    const waitingJob = await queueReview({
      actorId: editorTwoId,
      checkoutId: waiting.checkout.id,
      fence: waiting.checkout.fence,
    });
    const selected = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-selected-retry",
      title: "A historical failed review selected for retry",
    });
    const selectedJob = await queueReview({
      actorId: editorOneId,
      checkoutId: selected.checkout.id,
      fence: selected.checkout.fence,
    });
    const failedStep = selectedJob.steps.find((step) => step.ordinal === 1);
    if (!failedStep)
      throw new Error("Selected retry fixture has no first step.");
    const failedAt = new Date();
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
      revisionId: selectedJob.inputRevisionId,
      bundleHash: selectedJob.inputBundleHash,
    });

    expect(retried).toMatchObject({
      id: selectedJob.id,
      state: "QUEUED",
      laneOwner: true,
      queuedAt: selectedJob.queuedAt,
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
      revisionId: selectedJob.inputRevisionId,
      bundleHash: selectedJob.inputBundleHash,
      reason: "Integration cleanup after selected retry proof",
    });
    const waitingClaim = await claimNextReview(database);
    expect(waitingClaim?.id).toBe(waitingJob.id);
    await workflows.cancelReview({
      actorId: editorTwoId,
      jobId: waitingJob.id,
      revisionId: waitingJob.inputRevisionId,
      bundleHash: waitingJob.inputBundleHash,
      reason: "Integration cleanup after waiting-order proof",
    });
  });

  it("rejects a selected retry when another review owns the lane without mutating either review", async () => {
    const focused = await workflows.createSituation({
      actorId: editorTwoId,
      slug: "integration-review-retry-lane-owner",
      title: "A review already holding the focus lane",
    });
    const focusedJob = await queueReview({
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
    const selectedJob = await queueReview({
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
        revisionId: selectedJob.inputRevisionId,
        bundleHash: selectedJob.inputBundleHash,
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
      revisionId: selectedJob.inputRevisionId,
      bundleHash: selectedJob.inputBundleHash,
      reason: "Integration cleanup after retry lane conflict",
    });
    await workflows.cancelReview({
      actorId: editorTwoId,
      jobId: focusedJob.id,
      revisionId: focusedJob.inputRevisionId,
      bundleHash: focusedJob.inputBundleHash,
      reason: "Integration cleanup after focused lane conflict",
    });
  });

  it("rejects a stale request behind the unresolved focused review without hiding or mutating it", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-stale-request-behind-focus",
      title: "A stale request behind the unresolved focused review",
    });
    const focusedJob = await queueReview({
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
      revisionId: focusedJob.inputRevisionId,
      bundleHash: focusedJob.inputBundleHash,
      reason: "Integration cleanup after stale request proof",
    });
  });

  it("keeps an explicitly non-retryable provider failure terminal", async () => {
    const created = await workflows.createSituation({
      actorId: editorOneId,
      slug: "integration-review-nonretryable",
      title: "A non-retryable authentication failure scenario",
    });
    const queued = await queueReview({
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
    const waitingJob = await queueReview({
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
      laneOwner: false,
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
    const waitingClaim = await claimNextReview(database, timing);
    expect(waitingClaim?.id).toBe(waitingJob.id);
    await workflows.cancelReview({
      actorId: editorTwoId,
      jobId: waitingJob.id,
      revisionId: waitingJob.inputRevisionId,
      bundleHash: waitingJob.inputBundleHash,
      reason: "Integration cleanup after terminal lane proof",
    });
    await workflows.cancelReview({
      actorId: editorOneId,
      jobId: queued.id,
      revisionId: queued.inputRevisionId,
      bundleHash: queued.inputBundleHash,
      reason: "Integration cleanup after released terminal failure",
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
    const cancelledJob = await queueReview({
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
      revisionId: cancelledJob.inputRevisionId,
      bundleHash: cancelledJob.inputBundleHash,
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
    const fencedJob = await queueReview({
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
    const queued = await queueReview({
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
