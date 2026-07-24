import { execFile } from "node:child_process";
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
  canonicalText,
  reviewStages,
  sha256,
  situationBundleSchema,
} from "@situation-studio/domain";
import { claimNextReview, processClaimedReview } from "../src/review";

const executeFile = promisify(execFile);
const studioRoot = path.resolve(import.meta.dirname, "../../..");

function databaseUrl(container: StartedPostgreSqlContainer) {
  return container
    .getConnectionUri()
    .replace(/^postgres:\/\//u, "postgresql://");
}

describe("checkout fencing and the complete durable review DAG", () => {
  let container: StartedPostgreSqlContainer;
  let url: string;
  let database: DatabaseClient;
  let workflows: typeof import("@/server/workflows/situations");
  let editorOneId: string;
  let editorTwoId: string;
  let adminId: string;

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

  it("runs all 22 stages once, globally serializes jobs, and fences cancellation", async () => {
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
    expect(firstJob.steps).toHaveLength(22);
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
        proposal: true,
      },
    });
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.steps).toHaveLength(22);
    expect(completed.steps.every((step) => step.state === "SUCCEEDED")).toBe(
      true,
    );
    expect(completed.steps.flatMap((step) => step.runs)).toHaveLength(22);
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
    ).toBe(22);

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
      retryable: true,
    });
    expect(completed.steps[0]?.runs[1]?.outputHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
