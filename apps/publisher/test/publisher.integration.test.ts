import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@situation-studio/db";
import {
  importLeadershipRelease,
  readLeadershipReleaseHistory,
  readOfficialLeadershipRelease,
} from "@situation-studio/leadership-bridge";
import {
  bundleHash,
  canonicalText,
  sha256,
  situationBundleSchema,
} from "@situation-studio/domain";
import {
  processPublicationJob,
  PublisherCrashInjectionError,
  type PublisherBoundary,
} from "../src/index";

const executeFile = promisify(execFile);
const studioRoot = path.resolve(import.meta.dirname, "../../..");
const leadershipRoot = path.resolve(studioRoot, "../leadership");

function databaseUrl(container: StartedPostgreSqlContainer) {
  return container
    .getConnectionUri()
    .replace(/^postgres:\/\//u, "postgresql://");
}

async function command(
  cwd: string,
  args: string[],
  environment: Record<string, string>,
) {
  await executeFile("pnpm", args, {
    cwd,
    env: { ...process.env, ...environment },
  });
}

async function leadershipIdentity(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{
      release_id: string;
      manifest_hash: string;
      generation: string;
    }>(`
      SELECT pointer.release_id,
             release.manifest_hash,
             pointer.generation::text
        FROM current_release pointer
        JOIN content_releases release ON release.id = pointer.release_id
       WHERE pointer.id = 'official'
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Missing test Leadership pointer.");
    return {
      releaseId: row.release_id,
      manifestHash: row.manifest_hash,
      generation: BigInt(row.generation),
    };
  } finally {
    await client.end();
  }
}

describe("durable cross-database publisher", () => {
  let studioContainer: StartedPostgreSqlContainer;
  let leadershipContainer: StartedPostgreSqlContainer;
  let studioUrl: string;
  let leadershipUrl: string;
  let leadershipReaderUrl: string;
  let leadershipPublisherUrl: string;
  let studio: DatabaseClient;
  let workflows: typeof import("@/server/workflows/situations");
  let lastPublisherError: unknown;

  beforeAll(async () => {
    [studioContainer, leadershipContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16.12-bookworm")
        .withDatabase("situation_studio")
        .withUsername("studio_test_owner")
        .withPassword("studio_test_password")
        .start(),
      new PostgreSqlContainer("postgres:16.12-bookworm")
        .withDatabase("leadership_field_guide")
        .withUsername("leadership_test_owner")
        .withPassword("leadership_test_password")
        .start(),
    ]);
    studioUrl = databaseUrl(studioContainer);
    leadershipUrl = databaseUrl(leadershipContainer);
    await Promise.all([
      command(studioRoot, ["db:migrate:deploy"], {
        STUDIO_DATABASE_URL: studioUrl,
      }),
      command(leadershipRoot, ["db:migrate:deploy"], {
        DATABASE_URL: leadershipUrl,
      }),
    ]);
    await command(
      leadershipRoot,
      ["content:database:import", "--", "--git-ref", "0d7d161", "--official"],
      { DATABASE_URL: leadershipUrl },
    );
    const readerPassword = "reader-test-password-that-is-long-enough";
    const publisherPassword = "publisher-test-password-that-is-long-enough";
    await executeFile(
      "psql",
      [
        leadershipUrl,
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        path.join(leadershipRoot, "ops/provision-studio-roles.sql"),
      ],
      {
        env: {
          ...process.env,
          SITUATION_STUDIO_LEADERSHIP_READER_PASSWORD: readerPassword,
          SITUATION_STUDIO_LEADERSHIP_PUBLISHER_PASSWORD: publisherPassword,
        },
      },
    );
    await executeFile(
      "psql",
      [
        leadershipUrl,
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        path.join(leadershipRoot, "ops/grant-studio-roles.sql"),
      ],
      { env: process.env },
    );
    const readerUrl = new URL(leadershipUrl);
    readerUrl.username = "situation_studio_leadership_reader";
    readerUrl.password = readerPassword;
    leadershipReaderUrl = readerUrl.toString();
    const publisherUrl = new URL(leadershipUrl);
    publisherUrl.username = "situation_studio_leadership_publisher";
    publisherUrl.password = publisherPassword;
    leadershipPublisherUrl = publisherUrl.toString();
    studio = createDatabaseClient(studioUrl, 4);
    const snapshot = await readOfficialLeadershipRelease(leadershipReaderUrl);
    await importLeadershipRelease(studio, snapshot, "BOOTSTRAP_IMPORT");
    const user = await studio.user.create({
      data: {
        username: "publisher-test-editor",
        displayName: "Publisher test editor",
        passwordHash: "not-used-by-integration-test",
        roles: { create: [{ role: "EDITOR" }, { role: "ADMIN" }] },
      },
    });
    process.env.STUDIO_DATABASE_URL = studioUrl;
    process.env.SESSION_SECRET = "s".repeat(32);
    process.env.CSRF_SECRET = "c".repeat(32);
    process.env.THROTTLE_SECRET = "t".repeat(32);
    process.env.SITUATION_STUDIO_ORIGIN = "http://127.0.0.1:3015";
    workflows = await import("@/server/workflows/situations");
    expect(user.id).toMatch(/^[a-f0-9-]{36}$/u);
  });

  afterAll(async () => {
    await studio?.$disconnect();
    await Promise.all([studioContainer?.stop(), leadershipContainer?.stop()]);
  });

  async function requestChangedPublication(label: string) {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const situation = await studio.situation.findUniqueOrThrow({
      where: { slug: "repeatedly-misses-deadlines" },
    });
    const checkout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    const workspace = await workflows.workspaceForSlug(situation.slug);
    const revision = workspace?.drafts[0]?.revisions[0];
    const bodyArtifact = revision?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    );
    if (!revision || !bodyArtifact?.content.textBody)
      throw new Error("Test draft is unavailable.");
    const changedBody = canonicalText(
      bodyArtifact.content.textBody.replace(
        /^(## The short answer\n\n[^\n]+)/mu,
        `$1\n\n${label}`,
      ),
    );
    const bundle = situationBundleSchema.parse({
      ...situationBundleSchema.parse(revision.bundleManifest),
      bodyHash: sha256(changedBody),
    });
    await workflows.saveDraft({
      actorId: user.id,
      checkoutId: checkout.id,
      fence: checkout.fence,
      bundle,
      body: changedBody,
      namedCheckpoint: label,
    });
    return workflows.requestPublication({
      actorId: user.id,
      checkoutId: checkout.id,
      fence: checkout.fence,
    });
  }

  async function processAgainstCurrentRuntime(
    jobId: string,
    afterBoundary?: (boundary: PublisherBoundary) => Promise<void>,
  ) {
    return processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        onFailure: (error) => {
          lastPublisherError = error;
        },
        runtimeIdentity: async () => {
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
        afterBoundary,
      },
      jobId,
    );
  }

  async function typedSituation(slug: string) {
    const identity = await leadershipIdentity(leadershipUrl);
    const client = new Client({ connectionString: leadershipUrl });
    await client.connect();
    try {
      const result = await client.query<{
        slug: string;
        visibility: "PUBLIC" | "RETIRED";
        body_mdx: string;
      }>(
        `
          SELECT slug, visibility::text, body_mdx
            FROM situations
           WHERE release_id = $1
             AND slug = $2
        `,
        [identity.releaseId, slug],
      );
      return { identity, situation: result.rows[0] ?? null };
    } finally {
      await client.end();
    }
  }

  async function sharedGuideFixture() {
    const client = new Client({ connectionString: leadershipUrl });
    await client.connect();
    try {
      const result = await client.query<{
        guide_slug: string;
        body_mdx: string;
        target_slug: string;
        other_slug: string;
      }>(`
        SELECT guide.slug AS guide_slug,
               guide.body_mdx,
               target.slug AS target_slug,
               other.slug AS other_slug
          FROM current_release pointer
          JOIN guides guide
            ON guide.release_id = pointer.release_id
           AND guide.visibility = 'GLOBAL'
          JOIN guide_situations target_membership
            ON target_membership.guide_id = guide.id
          JOIN situations target
            ON target.id = target_membership.situation_id
          JOIN LATERAL (
            SELECT candidate.slug
              FROM guide_situations other_membership
              JOIN situations candidate
                ON candidate.id = other_membership.situation_id
             WHERE other_membership.guide_id = guide.id
               AND candidate.id <> target.id
             ORDER BY candidate.slug
             LIMIT 1
          ) other ON true
         WHERE pointer.id = 'official'
         ORDER BY guide.slug, target.slug
         LIMIT 1
      `);
      const fixture = result.rows[0];
      if (!fixture)
        throw new Error("A guide shared by two situations is required.");
      return fixture;
    } finally {
      await client.end();
    }
  }

  it("keeps the Leadership reader read-only and the publisher append-only", async () => {
    const reader = new Client({ connectionString: leadershipReaderUrl });
    const publisher = new Client({ connectionString: leadershipPublisherUrl });
    await Promise.all([reader.connect(), publisher.connect()]);
    try {
      await expect(
        reader.query(
          "INSERT INTO content_releases (id) VALUES (gen_random_uuid())",
        ),
      ).rejects.toThrow();
      await expect(
        publisher.query(
          "UPDATE current_release SET reason = reason WHERE id = 'official'",
        ),
      ).rejects.toThrow();
      await expect(
        publisher.query("DROP TABLE current_release"),
      ).rejects.toThrow();
    } finally {
      await Promise.all([reader.end(), publisher.end()]);
    }
  });

  it("publishes one complete immutable successor and preserves unrelated situations", async () => {
    const before = await leadershipIdentity(leadershipUrl);
    const client = new Client({ connectionString: leadershipUrl });
    await client.connect();
    const unrelatedBefore = await client.query<{ body_mdx: string }>(
      `
        SELECT body_mdx
          FROM situations
         WHERE release_id = $1
           AND slug = 'defensive-about-feedback'
      `,
      [before.releaseId],
    );
    await client.end();

    const job = await requestChangedPublication(
      "Publisher integration checkpoint one.",
    );
    await processAgainstCurrentRuntime(job.id);

    const after = await leadershipIdentity(leadershipUrl);
    if (after.releaseId === before.releaseId) {
      const failed = await studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: {
          events: { orderBy: { sequence: "asc" } },
          attempts: { orderBy: { attempt: "asc" } },
        },
      });
      throw new Error(
        `Publisher did not advance: ${JSON.stringify(failed, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        )}`,
      );
    }
    expect(after.releaseId).not.toBe(before.releaseId);
    expect(after.generation).toBe(before.generation + 1n);
    const persisted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: {
        receipt: true,
        candidateSnapshot: true,
        backups: true,
      },
    });
    expect(persisted.state).toBe("SUCCEEDED");
    expect(persisted.receipt).toMatchObject({
      expectedReleaseId: after.releaseId,
      expectedManifestHash: after.manifestHash,
    });
    expect(persisted.candidateSnapshot?.artifactCount).toBe(32);
    expect(persisted.backups).toHaveLength(1);
    const releaseCounts = await new Client({
      connectionString: leadershipUrl,
    });
    await releaseCounts.connect();
    const counts = await releaseCounts.query<{
      artifacts: string;
      situations: string;
      unrelated_body: string;
    }>(
      `
        SELECT
          (SELECT count(*)::text FROM release_artifacts WHERE release_id = $1)
            AS artifacts,
          (SELECT count(*)::text FROM situations WHERE release_id = $1)
            AS situations,
          (SELECT body_mdx FROM situations
            WHERE release_id = $1 AND slug = 'defensive-about-feedback')
            AS unrelated_body
      `,
      [after.releaseId],
    );
    await releaseCounts.end();
    expect(counts.rows[0]).toMatchObject({
      artifacts: "32",
      situations: "15",
      unrelated_body: unrelatedBefore.rows[0]?.body_mdx,
    });
  });

  it("creates, retires, and restores one situation through forward-only releases", async () => {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const slug = "publisher-lifecycle-situation";
    const unrelatedBefore = await typedSituation("defensive-about-feedback");
    const created = await workflows.createSituation({
      actorId: user.id,
      slug,
      title: "Publisher lifecycle situation",
    });
    const createJob = await workflows.requestPublication({
      actorId: user.id,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
    await processAgainstCurrentRuntime(createJob.id);

    const publicVersion =
      await studio.productionSituationVersion.findFirstOrThrow({
        where: {
          situationId: created.situation.id,
          sourceKind: "CREATE",
        },
      });
    const observedCreation =
      await readOfficialLeadershipRelease(leadershipReaderUrl);
    const observedCreationBundle = observedCreation.situations.find(
      (situation) => situation.slug === slug,
    )?.bundle;
    expect(
      observedCreationBundle
        ? situationBundleSchema.parse({
            ...observedCreationBundle,
            situationId: created.situation.id,
          })
        : null,
    ).toEqual(situationBundleSchema.parse(publicVersion.bundleManifest));
    const afterCreate = await typedSituation(slug);
    expect(afterCreate.situation).toMatchObject({
      slug,
      visibility: "PUBLIC",
    });
    expect(afterCreate.identity.generation).toBe(
      unrelatedBefore.identity.generation + 1n,
    );
    await expect(
      studio.situationCheckout.count({
        where: { id: created.checkout.id, releasedAt: null },
      }),
    ).resolves.toBe(0);

    const retirementCheckout = await workflows.checkoutSituation({
      situationId: created.situation.id,
      actorId: user.id,
    });
    await workflows.createRetirementDraft({
      actorId: user.id,
      checkoutId: retirementCheckout.id,
      fence: retirementCheckout.fence,
    });
    const retireJob = await workflows.requestPublication({
      actorId: user.id,
      checkoutId: retirementCheckout.id,
      fence: retirementCheckout.fence,
    });
    await processAgainstCurrentRuntime(retireJob.id);

    const persistedRetirement = await studio.publicationJob.findUniqueOrThrow({
      where: { id: retireJob.id },
      include: {
        events: { orderBy: { sequence: "asc" } },
        attempts: { orderBy: { attempt: "asc" } },
      },
    });
    if (persistedRetirement.state !== "SUCCEEDED")
      throw new Error(
        `Retirement did not succeed: ${JSON.stringify(
          persistedRetirement,
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
        )}`,
      );
    const afterRetire = await typedSituation(slug);
    expect(afterRetire.situation).toMatchObject({
      slug,
      visibility: "RETIRED",
    });
    expect(afterRetire.identity.generation).toBe(
      afterCreate.identity.generation + 1n,
    );
    await expect(
      studio.situation.findUniqueOrThrow({
        where: { id: created.situation.id },
        select: { visibility: true },
      }),
    ).resolves.toEqual({ visibility: "RETIRED" });

    const restorationCheckout = await workflows.checkoutSituation({
      situationId: created.situation.id,
      actorId: user.id,
    });
    await workflows.startRestorationDraft({
      actorId: user.id,
      checkoutId: restorationCheckout.id,
      fence: restorationCheckout.fence,
      productionVersionId: publicVersion.id,
    });
    const restoreJob = await workflows.requestPublication({
      actorId: user.id,
      checkoutId: restorationCheckout.id,
      fence: restorationCheckout.fence,
    });
    await processAgainstCurrentRuntime(restoreJob.id);

    const persistedRestoration = await studio.publicationJob.findUniqueOrThrow({
      where: { id: restoreJob.id },
      include: {
        events: { orderBy: { sequence: "asc" } },
        attempts: { orderBy: { attempt: "asc" } },
      },
    });
    if (persistedRestoration.state !== "SUCCEEDED")
      throw new Error(
        `Restoration did not succeed: ${JSON.stringify(
          persistedRestoration,
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
        )}`,
      );
    const afterRestore = await typedSituation(slug);
    expect(afterRestore.situation).toMatchObject({
      slug,
      visibility: "PUBLIC",
      body_mdx: afterCreate.situation?.body_mdx,
    });
    expect(afterRestore.identity.generation).toBe(
      afterRetire.identity.generation + 1n,
    );
    const unrelatedAfter = await typedSituation("defensive-about-feedback");
    expect(unrelatedAfter.situation?.body_mdx).toBe(
      unrelatedBefore.situation?.body_mdx,
    );
    await expect(
      studio.productionSituationVersion.findMany({
        where: { situationId: created.situation.id },
        orderBy: { productionAt: "asc" },
        select: { sourceKind: true },
      }),
    ).resolves.toEqual([
      { sourceKind: "CREATE" },
      { sourceKind: "RETIRE" },
      { sourceKind: "RESTORE" },
    ]);
  });

  it("carries one scoped guide through consecutive releases without changing another consumer", async () => {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const fixture = await sharedGuideFixture();
    const situation = await studio.situation.findUniqueOrThrow({
      where: { slug: fixture.target_slug },
    });
    const firstCheckout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    const firstWorkspace = await workflows.workspaceForSlug(
      fixture.target_slug,
    );
    const firstRevision = firstWorkspace?.drafts[0]?.revisions[0];
    const originalRelationship = situationBundleSchema
      .parse(firstRevision?.bundleManifest)
      .relationships.find(
        (relationship) =>
          relationship.logicalId === `guide:${fixture.guide_slug}`,
      );
    if (!originalRelationship)
      throw new Error("The shared guide relationship is unavailable.");
    const scoped = await workflows.createScopedArtifactEdit({
      actorId: user.id,
      checkoutId: firstCheckout.id,
      fence: firstCheckout.fence,
      originalLogicalId: originalRelationship.logicalId,
      kind: "GUIDE",
      originalContentHash: originalRelationship.contentHash,
      changedBody: canonicalText(
        `${fixture.body_mdx}\nScoped only to ${fixture.target_slug}.`,
      ),
    });
    const firstJob = await workflows.requestPublication({
      actorId: user.id,
      checkoutId: firstCheckout.id,
      fence: firstCheckout.fence,
    });
    await processAgainstCurrentRuntime(firstJob.id);
    const firstPersisted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: firstJob.id },
      include: {
        attempts: { orderBy: { attempt: "asc" } },
        events: { orderBy: { sequence: "asc" } },
      },
    });
    if (firstPersisted.state !== "SUCCEEDED")
      throw new Error(
        `First scoped publication failed: ${
          lastPublisherError instanceof Error
            ? lastPublisherError.message
            : String(lastPublisherError)
        }`,
        { cause: lastPublisherError },
      );
    const firstRelease = await leadershipIdentity(leadershipUrl);

    const secondCheckout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    const secondWorkspace = await workflows.workspaceForSlug(
      fixture.target_slug,
    );
    const secondRevision = secondWorkspace?.drafts[0]?.revisions[0];
    const bodyArtifact = secondRevision?.artifacts.find(
      (artifact) => artifact.kind === "SITUATION",
    );
    if (!secondRevision || !bodyArtifact?.content.textBody)
      throw new Error("The second scoped draft is unavailable.");
    const changedBody = canonicalText(
      bodyArtifact.content.textBody.replace(
        /^(## The short answer\n\n[^\n]+)/mu,
        "$1\n\nConsecutive scoped publication.",
      ),
    );
    await workflows.saveDraft({
      actorId: user.id,
      checkoutId: secondCheckout.id,
      fence: secondCheckout.fence,
      bundle: situationBundleSchema.parse({
        ...situationBundleSchema.parse(secondRevision.bundleManifest),
        bodyHash: sha256(changedBody),
      }),
      body: changedBody,
      namedCheckpoint: "Consecutive scoped publication",
    });
    const secondJob = await workflows.requestPublication({
      actorId: user.id,
      checkoutId: secondCheckout.id,
      fence: secondCheckout.fence,
    });
    await processAgainstCurrentRuntime(secondJob.id);
    const secondRelease = await leadershipIdentity(leadershipUrl);

    const client = new Client({ connectionString: leadershipUrl });
    await client.connect();
    try {
      const proof = await client.query<{
        first_scoped: string;
        second_scoped: string;
        target_bindings: string;
        other_global_membership: string;
        global_body: string;
      }>(
        `
          SELECT
            (SELECT count(*)::text
               FROM guides
              WHERE release_id = $1
                AND visibility = 'SITUATION_SCOPED'
                AND owner_situation_slug = $3
                AND forked_from_logical_id = $5) AS first_scoped,
            (SELECT count(*)::text
               FROM guides
              WHERE release_id = $2
                AND visibility = 'SITUATION_SCOPED'
                AND owner_situation_slug = $3
                AND forked_from_logical_id = $5) AS second_scoped,
            (SELECT count(*)::text
               FROM situation_artifact_bindings
              WHERE release_id = $2
                AND situation_slug = $3
                AND original_logical_id = $5
                AND resolved_logical_id = $6) AS target_bindings,
            (SELECT count(*)::text
               FROM guide_situations membership
               JOIN guides guide ON guide.id = membership.guide_id
               JOIN situations situation ON situation.id = membership.situation_id
              WHERE guide.release_id = $2
                AND guide.slug = $4
                AND guide.visibility = 'GLOBAL'
                AND situation.slug = $7) AS other_global_membership,
            (SELECT body_mdx
               FROM guides
              WHERE release_id = $2
                AND slug = $4
                AND visibility = 'GLOBAL') AS global_body
        `,
        [
          firstRelease.releaseId,
          secondRelease.releaseId,
          fixture.target_slug,
          fixture.guide_slug,
          originalRelationship.logicalId,
          scoped.variant.logicalId,
          fixture.other_slug,
        ],
      );
      expect(proof.rows[0]).toMatchObject({
        first_scoped: "1",
        second_scoped: "1",
        target_bindings: "1",
        other_global_membership: "1",
        global_body: fixture.body_mdx,
      });
    } finally {
      await client.end();
    }
  });

  it.each<PublisherBoundary>([
    "CANDIDATE_PERSISTED",
    "LEADERSHIP_PROMOTED",
    "RUNTIME_VERIFIED",
  ])("reconciles an injected process crash after %s", async (boundary) => {
    const before = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      `Publisher crash checkpoint ${boundary}.`,
    );
    let injected = false;
    await expect(
      processAgainstCurrentRuntime(job.id, async (observedBoundary) => {
        if (!injected && observedBoundary === boundary) {
          injected = true;
          throw new PublisherCrashInjectionError(boundary);
        }
      }),
    ).rejects.toThrow(PublisherCrashInjectionError);
    expect(injected).toBe(true);

    await processAgainstCurrentRuntime(job.id);
    const after = await leadershipIdentity(leadershipUrl);
    expect(after.generation).toBe(before.generation + 1n);
    const persisted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { attempts: true, receipt: true },
    });
    expect(persisted.state).toBe("SUCCEEDED");
    expect(persisted.attempts).toHaveLength(2);
    expect(
      persisted.attempts.filter((attempt) => attempt.finishedAt),
    ).toHaveLength(1);
    expect(persisted.receipt).toMatchObject({
      expectedReleaseId: after.releaseId,
      expectedManifestHash: after.manifestHash,
    });
    const client = new Client({ connectionString: leadershipUrl });
    await client.connect();
    try {
      const releases = await client.query<{ count: string }>(
        `
          SELECT count(*)::text
            FROM content_releases
           WHERE studio_publication_id = $1
        `,
        [job.publicationId],
      );
      expect(releases.rows[0]?.count).toBe("1");
    } finally {
      await client.end();
    }
  });

  it("restores and verifies the prior official release after runtime verification fails", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher integration checkpoint two.",
    );
    let healthCalls = 0;
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        runtimeIdentity: async () => {
          healthCalls += 1;
          if (healthCalls === 1)
            return {
              releaseId: crypto.randomUUID(),
              manifestHash: "f".repeat(64),
            };
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
      },
      job.id,
    );
    const after = await leadershipIdentity(leadershipUrl);
    expect(after).toMatchObject({
      releaseId: prior.releaseId,
      manifestHash: prior.manifestHash,
      generation: prior.generation + 2n,
    });
    const persisted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(persisted.state).toBe("RESTORED");
    expect(persisted.failureCode).toBe("VERIFICATION_FAILED_RESTORED");
    await expect(
      studio.situationCheckout.count({
        where: { id: job.checkoutId, releasedAt: null },
      }),
    ).resolves.toBe(1);
  });

  it("enumerates and imports every formerly official Leadership release", async () => {
    const history = await readLeadershipReleaseHistory(leadershipReaderUrl);
    const client = new Client({ connectionString: leadershipUrl });
    await client.connect();
    try {
      const recoverable = await client.query<{ id: string }>(`
        SELECT id
          FROM content_releases
         WHERE state IN ('OFFICIAL', 'RETIRED')
           AND published_at IS NOT NULL
         ORDER BY published_at, created_at, id
      `);
      expect(history.map((release) => release.identity.releaseId)).toEqual(
        recoverable.rows.map((release) => release.id),
      );
    } finally {
      await client.end();
    }
    for (const release of history) {
      const observation = await studio.leadershipReleaseObservation.findUnique({
        where: { releaseId: release.identity.releaseId },
      });
      if (!observation) continue;
      for (const item of release.situations) {
        const situation = await studio.situation.findUnique({
          where: { slug: item.slug },
        });
        if (!situation) continue;
        const existing = await studio.productionSituationVersion.findUnique({
          where: {
            situationId_observationId: {
              situationId: situation.id,
              observationId: observation.id,
            },
          },
        });
        if (!existing) continue;
        const observedHash = bundleHash(
          situationBundleSchema.parse({
            ...item.bundle,
            situationId: situation.id,
            artifacts: item.bundle.artifacts.map((artifact) => ({
              ...artifact,
              ownerSituationId:
                artifact.visibility === "GLOBAL" ? null : situation.id,
            })),
          }),
        );
        expect(
          existing.bundleHash,
          `${release.identity.releaseId}:${item.slug}`,
        ).toBe(observedHash);
      }
    }
    for (const release of history)
      try {
        await importLeadershipRelease(studio, release, "BOOTSTRAP_IMPORT");
      } catch (error) {
        throw new Error(
          `Failed to import historical release ${release.identity.releaseId}.`,
          { cause: error },
        );
      }
    await expect(
      studio.leadershipReleaseObservation.count({
        where: {
          releaseId: {
            in: history.map((release) => release.identity.releaseId),
          },
        },
      }),
    ).resolves.toBe(history.length);
  });
});
