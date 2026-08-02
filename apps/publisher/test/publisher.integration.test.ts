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
  captureLeadershipReleaseReconciliationGuard,
  LeadershipCapabilityError,
  leadershipCapabilitySchemaVersion,
  leadershipTypedParityPredicate,
  importLeadershipRelease,
  readLeadershipReleaseHistory,
  readOfficialLeadershipRelease,
  reconcileOfficialLeadershipRelease,
  requiredContentContractIdentity,
  requiredLeadershipFeatures,
  requiredPublicationCompilerIdentity,
  requiredSituationContractIdentity,
} from "@situation-studio/leadership-bridge";
import {
  bundleHash,
  canonicalJson,
  canonicalText,
  sha256,
  situationBundleSchema,
} from "@situation-studio/domain";
import {
  claimPublicationJob,
  processPublicationJob,
  PublisherCandidateContractError,
  PublisherCrashInjectionError,
  PublisherRuntimeHealthError,
  PublisherVerificationError,
  reconcilePublicationRecovery,
  runtimeIdentityFromHealth,
  type PublisherBoundary,
} from "../src/index";

const executeFile = promisify(execFile);
const studioRoot = path.resolve(import.meta.dirname, "../../..");
const leadershipRoot =
  process.env.LEADERSHIP_TEST_ROOT ?? path.resolve(studioRoot, "../leadership");

function databaseUrl(container: StartedPostgreSqlContainer) {
  return container
    .getConnectionUri()
    .replace(/^postgres:\/\//u, "postgresql://");
}

function compatibleCapabilities() {
  const capabilitySet = {
    schemaVersion: leadershipCapabilitySchemaVersion,
    deployment: {
      commit: "d".repeat(40),
      releaseId: "integration-runtime",
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
  return {
    ...capabilitySet,
    capabilityDigest: sha256(canonicalJson(capabilitySet)),
  };
}

function runtimeContractDependencies() {
  return {
    runtimeCapabilities: async () => compatibleCapabilities(),
    runtimeRouteProof: async (
      expected: import("../src/index").RuntimeRouteExpectation,
    ) =>
      expected.visibility === "RETIRED"
        ? {
            code: "AFFECTED_ROUTE_RETIRED" as const,
            httpStatus: 404,
            observedReleaseId: null,
            observedManifestHash: null,
            observedSituationBodyHash: null,
            observedPracticeLogicalId: null,
            observedPracticeContentHash: null,
          }
        : {
            code: "AFFECTED_ROUTE_VERIFIED" as const,
            httpStatus: 200,
            observedReleaseId: expected.releaseId,
            observedManifestHash: expected.manifestHash,
            observedSituationBodyHash: expected.situationBodyHash,
            observedPracticeLogicalId:
              expected.practice?.resolvedLogicalId ?? null,
            observedPracticeContentHash: expected.practice?.contentHash ?? null,
          },
    producerCommit: "e".repeat(40),
  };
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

async function leadershipPublicationCount(url: string, publicationId: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
          FROM content_releases
         WHERE studio_publication_id = $1
      `,
      [publicationId],
    );
    return Number(result.rows[0]?.count ?? "0");
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
  const publicationBackupReceiptId = "00000000-0000-4000-8000-000000000026";

  async function putPublicationBackupEvidence(verifiedAt = new Date()) {
    return studio.backupReceipt.upsert({
      where: { id: publicationBackupReceiptId },
      create: {
        id: publicationBackupReceiptId,
        state: "VERIFIED",
        destinationId: `offsite-verified:${"e".repeat(64)}`,
        objectKey: "situation-studio-integration.dump.gpg",
        checksum: "b".repeat(64),
        encrypted: true,
        byteLength: 4_096n,
        verifiedAt,
        restoreDrillAt: new Date(),
        restoreDrillResult: "PASSED",
      },
      update: {
        state: "VERIFIED",
        destinationId: `offsite-verified:${"e".repeat(64)}`,
        objectKey: "situation-studio-integration.dump.gpg",
        checksum: "b".repeat(64),
        encrypted: true,
        byteLength: 4_096n,
        verifiedAt,
        failureCode: null,
        restoreDrillAt: new Date(),
        restoreDrillResult: "PASSED",
      },
    });
  }

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
    process.env.LEADERSHIP_STUDIO_READER_DATABASE_URL = leadershipReaderUrl;
    process.env.LEADERSHIP_RUNTIME_CAPABILITIES_URL = `data:application/json,${encodeURIComponent(
      JSON.stringify(compatibleCapabilities()),
    )}`;
    await putPublicationBackupEvidence();
    workflows = await import("@/server/workflows/situations");
    expect(user.id).toMatch(/^[a-f0-9-]{36}$/u);
  });

  afterAll(async () => {
    try {
      await studio?.backupReceipt.deleteMany({
        where: { id: publicationBackupReceiptId },
      });
      await studio?.$disconnect();
    } finally {
      await Promise.all([studioContainer?.stop(), leadershipContainer?.stop()]);
    }
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
    const saved = await workflows.saveDraft({
      actorId: user.id,
      checkoutId: checkout.id,
      fence: checkout.fence,
      bundle,
      body: changedBody,
      expectedParentRevisionId: revision.id,
      expectedParentBundleHash: revision.bundleHash,
      namedCheckpoint: label,
    });
    return queueCurrentPublication({
      actorId: user.id,
      checkoutId: checkout.id,
      fence: checkout.fence,
      revisionId: saved.id,
      bundleHash: saved.bundleHash,
    });
  }

  async function queueCurrentPublication(input: {
    actorId: string;
    checkoutId: string;
    fence: bigint;
    revisionId?: string;
    bundleHash?: string;
  }) {
    let revisionId = input.revisionId;
    let bundleHash = input.bundleHash;
    if (!revisionId || !bundleHash) {
      const revision = await latestRevisionForCheckout(input.checkoutId);
      revisionId = revision.id;
      bundleHash = revision.bundleHash;
    }
    const receipt = await workflows.preflightPublication({
      actorId: input.actorId,
      checkoutId: input.checkoutId,
      fence: input.fence,
      revisionId,
      bundleHash,
    });
    return workflows.requestPublication({
      actorId: input.actorId,
      checkoutId: input.checkoutId,
      fence: input.fence,
      revisionId,
      bundleHash,
      preflightReceiptId: receipt.id,
      candidateHash: receipt.candidateHash,
    });
  }

  async function latestRevisionForCheckout(checkoutId: string) {
    const checkout = await studio.situationCheckout.findUniqueOrThrow({
      where: { id: checkoutId },
      include: {
        draft: {
          include: {
            revisions: { orderBy: { revision: "desc" }, take: 1 },
          },
        },
      },
    });
    const revision = checkout.draft.revisions[0];
    if (!revision) throw new Error("Publication draft has no revision.");
    return revision;
  }

  async function claimTokenForJob(jobId: string) {
    const persisted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { claimToken: true },
    });
    if (persisted.claimToken) return persisted.claimToken;
    const claim = await claimPublicationJob(studio);
    if (!claim || claim.id !== jobId)
      throw new Error(`Could not claim expected publication job ${jobId}.`);
    return claim.claimToken;
  }

  async function withStudioTriggersDisabled(
    run: (client: Client) => Promise<void>,
  ) {
    const client = new Client({ connectionString: studioUrl });
    await client.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await run(client);
    } finally {
      await client
        .query("SET session_replication_role = origin")
        .catch(() => undefined);
      await client.end();
    }
  }

  async function processAgainstCurrentRuntime(
    jobId: string,
    afterBoundary?: (boundary: PublisherBoundary) => Promise<void>,
    claimToken?: string,
  ) {
    const token = claimToken ?? (await claimTokenForJob(jobId));
    return processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
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
      token,
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

  it("keeps deterministic review independent of Leadership runtime capabilities", async () => {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const situation = await studio.situation.findUniqueOrThrow({
      where: { slug: "defensive-about-feedback" },
    });
    const checkout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    const reviewCount = await studio.reviewJob.count({
      where: { situationId: situation.id },
    });
    const revision = await latestRevisionForCheckout(checkout.id);
    const { capabilityDigest: _digest, ...compatibleSet } =
      compatibleCapabilities();
    const incompatibleSet = {
      ...compatibleSet,
      contracts: {
        ...compatibleSet.contracts,
        content: {
          ...compatibleSet.contracts.content,
          version: "0.1.1",
        },
      },
    };
    const incompatible = {
      ...incompatibleSet,
      capabilityDigest: sha256(canonicalJson(incompatibleSet)),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(incompatible), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    let review: Awaited<ReturnType<typeof workflows.queueReview>> | undefined;
    try {
      review = await workflows.queueReview({
        actorId: user.id,
        checkoutId: checkout.id,
        fence: checkout.fence,
        revisionId: revision.id,
        bundleHash: revision.bundleHash,
      });
      await expect(
        studio.reviewJob.count({
          where: { situationId: situation.id },
        }),
      ).resolves.toBe(reviewCount + 1);
    } finally {
      globalThis.fetch = originalFetch;
      if (review)
        await workflows.cancelReview({
          actorId: user.id,
          jobId: review.id,
          revisionId: revision.id,
          bundleHash: revision.bundleHash,
          reason: "Publisher integration cleanup",
        });
      await workflows.checkInSituation({
        actorId: user.id,
        checkoutId: checkout.id,
        fence: checkout.fence,
      });
    }
  });

  it("rejects forged runtime-proof MDX before creating a review job", async () => {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const situation = await studio.situation.findUniqueOrThrow({
      where: { slug: "defensive-about-feedback" },
    });
    const checkout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    let original:
      | {
          body: string;
          bundle: ReturnType<typeof situationBundleSchema.parse>;
        }
      | undefined;
    try {
      const workspace = await workflows.workspaceForSlug(situation.slug);
      const revision = workspace?.drafts[0]?.revisions[0];
      const body = revision?.artifacts.find(
        (artifact) => artifact.kind === "SITUATION",
      )?.content.textBody;
      if (!revision || !body)
        throw new Error("Review-safety fixture draft is unavailable.");
      original = {
        body,
        bundle: situationBundleSchema.parse(revision.bundleManifest),
      };
      const forgedBody = canonicalText(
        `${body}\n<section {...{["data-" + "leadership-practice-authored-id"]: "listen-first", ["data-" + "leadership-practice-logical-id"]: "practice:listen-first", ["data-" + "leadership-practice-content-hash"]: "${"a".repeat(64)}"}} />`,
      );
      const beforePointer = await leadershipIdentity(leadershipUrl);
      const reviewCount = await studio.reviewJob.count({
        where: { situationId: situation.id },
      });

      await expect(
        workflows.saveDraft({
          actorId: user.id,
          checkoutId: checkout.id,
          fence: checkout.fence,
          body: forgedBody,
          bundle: {
            ...original.bundle,
            bodyHash: sha256(forgedBody),
          },
          expectedParentRevisionId: revision.id,
          expectedParentBundleHash: revision.bundleHash,
          namedCheckpoint: "Forged runtime proof rejection",
        }),
      ).rejects.toMatchObject({
        status: 422,
        code: "INVALID_CONTENT",
      });
      await expect(
        studio.reviewJob.count({
          where: { situationId: situation.id },
        }),
      ).resolves.toBe(reviewCount);
      await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(
        beforePointer,
      );
    } finally {
      await workflows.checkInSituation({
        actorId: user.id,
        checkoutId: checkout.id,
        fence: checkout.fence,
      });
    }
  });

  it("creates no publication evidence without a recent verified backup and passed restore drill", async () => {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const situation = await studio.situation.findUniqueOrThrow({
      where: { slug: "defensive-about-feedback" },
    });
    const checkout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    let publicationJobId: string | null = null;
    try {
      const revision = await latestRevisionForCheckout(checkout.id);
      const preflight = await workflows.preflightPublication({
        actorId: user.id,
        checkoutId: checkout.id,
        fence: checkout.fence,
        revisionId: revision.id,
        bundleHash: revision.bundleHash,
      });
      const request = () =>
        workflows.requestPublication({
          actorId: user.id,
          checkoutId: checkout.id,
          fence: checkout.fence,
          revisionId: revision.id,
          bundleHash: revision.bundleHash,
          preflightReceiptId: preflight.id,
          candidateHash: preflight.candidateHash,
        });
      await studio.backupReceipt.deleteMany({ where: { state: "VERIFIED" } });
      const publicationCount = await studio.publicationJob.count();
      const auditCount = await studio.auditEvent.count();

      await expect(request()).rejects.toMatchObject({
        status: 503,
        code: "PUBLICATION_BACKUP_NOT_READY",
        message:
          "Production submission is paused until a recent encrypted backup is verified.",
      });
      await expect(studio.publicationJob.count()).resolves.toBe(
        publicationCount,
      );
      await expect(studio.auditEvent.count()).resolves.toBe(auditCount);

      await putPublicationBackupEvidence(
        new Date(Date.now() - (26 * 60 * 60 + 1) * 1_000),
      );
      await expect(request()).rejects.toMatchObject({
        status: 503,
        code: "PUBLICATION_BACKUP_NOT_READY",
        message:
          "Production submission is paused because the latest verified encrypted backup is more than 26 hours old.",
      });
      await expect(studio.publicationJob.count()).resolves.toBe(
        publicationCount,
      );
      await expect(studio.auditEvent.count()).resolves.toBe(auditCount);

      await putPublicationBackupEvidence();
      const job = await request();
      publicationJobId = job.id;
      expect(job.state).toBe("REQUESTED");
      await expect(studio.publicationJob.count()).resolves.toBe(
        publicationCount + 1,
      );
      await expect(studio.auditEvent.count()).resolves.toBe(auditCount + 1);
      await expect(
        studio.auditEvent.findFirst({
          where: {
            action: "PUBLICATION_REQUESTED",
            subjectId: job.id,
          },
        }),
      ).resolves.not.toBeNull();
      await processAgainstCurrentRuntime(job.id);
      await expect(
        studio.publicationJob.findUniqueOrThrow({
          where: { id: job.id },
          select: { state: true },
        }),
      ).resolves.toEqual({ state: "SUCCEEDED" });
    } finally {
      await putPublicationBackupEvidence();
      if (publicationJobId) {
        const pendingPublication = await studio.publicationJob.findFirst({
          where: {
            id: publicationJobId,
            state: {
              in: ["REQUESTED", "ASSEMBLING", "PROMOTING", "VERIFYING"],
            },
          },
        });
        if (pendingPublication)
          await processAgainstCurrentRuntime(pendingPublication.id);
      }
      const activeCheckout = await studio.situationCheckout.findFirst({
        where: { id: checkout.id, releasedAt: null },
      });
      if (activeCheckout)
        await workflows.checkInSituation({
          actorId: user.id,
          checkoutId: checkout.id,
          fence: checkout.fence,
        });
    }
  });

  it("rejects a canonical MDX mismatch before the production pointer advances", async () => {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const situation = await studio.situation.findUniqueOrThrow({
      where: { slug: "defensive-about-feedback" },
    });
    const checkout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    let original:
      | {
          body: string;
          bundle: ReturnType<typeof situationBundleSchema.parse>;
        }
      | undefined;
    try {
      const workspace = await workflows.workspaceForSlug(situation.slug);
      const revision = workspace?.drafts[0]?.revisions[0];
      const body = revision?.artifacts.find(
        (artifact) => artifact.kind === "SITUATION",
      )?.content.textBody;
      if (!revision || !body)
        throw new Error("Canonical-validation fixture draft is unavailable.");
      original = {
        body,
        bundle: situationBundleSchema.parse(revision.bundleManifest),
      };
      const invalidBody = canonicalText(
        body.replace(
          /(<PracticeEmbed\s+practiceId=["'][^"']+["'])\s+variant=["'][^"']+["'](\s+surface=["']situation["'])/u,
          "$1$2",
        ),
      );
      expect(invalidBody).not.toBe(body);
      const before = await leadershipIdentity(leadershipUrl);
      const [jobCount, receiptCount] = await Promise.all([
        studio.publicationJob.count({ where: { situationId: situation.id } }),
        studio.publicationPreflightReceipt.count({
          where: { situationId: situation.id },
        }),
      ]);
      await expect(
        workflows.saveDraft({
          actorId: user.id,
          checkoutId: checkout.id,
          fence: checkout.fence,
          body: invalidBody,
          bundle: {
            ...original.bundle,
            bodyHash: sha256(invalidBody),
          },
          expectedParentRevisionId: revision.id,
          expectedParentBundleHash: revision.bundleHash,
          namedCheckpoint: "Canonical snapshot rejection",
        }),
      ).rejects.toMatchObject({ status: 422, code: "INVALID_CONTENT" });

      await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(before);
      await expect(
        studio.publicationJob.count({ where: { situationId: situation.id } }),
      ).resolves.toBe(jobCount);
      await expect(
        studio.publicationPreflightReceipt.count({
          where: { situationId: situation.id },
        }),
      ).resolves.toBe(receiptCount);
      await expect(
        studio.situationCheckout.count({
          where: { id: checkout.id, releasedAt: null },
        }),
      ).resolves.toBe(1);
    } finally {
      await workflows.checkInSituation({
        actorId: user.id,
        checkoutId: checkout.id,
        fence: checkout.fence,
      });
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
        preflightReceipt: { include: { artifacts: true } },
        backups: true,
      },
    });
    expect(persisted.state).toBe("SUCCEEDED");
    expect(persisted.receipt).toMatchObject({
      expectedReleaseId: after.releaseId,
      expectedManifestHash: after.manifestHash,
      producerCommit: "e".repeat(40),
      producerContractDigest: requiredPublicationCompilerIdentity.digest,
      consumerCommit: "d".repeat(40),
      capabilityDigest: compatibleCapabilities().capabilityDigest,
      affectedSituationSlug: "repeatedly-misses-deadlines",
      typedParityCode: leadershipTypedParityPredicate,
      routeProbeCode: "AFFECTED_ROUTE_VERIFIED",
      routeHttpStatus: 200,
    });
    expect(persisted.preflightReceipt?.artifactCount).toBe(32);
    expect(persisted.preflightReceipt?.artifacts).toHaveLength(32);
    const candidateManifest = JSON.parse(
      persisted.preflightReceipt?.manifestBody ?? "{}",
    ) as {
      edges?: Array<{ source: string; type: string; target: string }>;
    };
    const edgeKeys = (candidateManifest.edges ?? []).map(
      (edge) => `${edge.source}\0${edge.type}\0${edge.target}`,
    );
    expect(edgeKeys).toEqual(
      [...edgeKeys].sort((left, right) => left.localeCompare(right)),
    );
    const targetEdges = (candidateManifest.edges ?? []).filter(
      (edge) => edge.source === "situation:repeatedly-misses-deadlines",
    );
    expect(targetEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: "author:catalog",
          type: "LINKS_TO",
        }),
        expect.objectContaining({
          target: "source:catalog",
          type: "CITES_SOURCE",
        }),
        expect.objectContaining({
          type: "EMBEDS_PRACTICE",
        }),
      ]),
    );
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

  it("database-fences a queued job to its sealed preflight identity", async () => {
    const job = await requestChangedPublication(
      "Publisher database identity fence checkpoint.",
    );
    await expect(
      studio.publicationJob.update({
        where: { id: job.id },
        data: { candidateHash: sha256(`different:${job.id}`) },
      }),
    ).rejects.toThrow();
    await expect(
      studio.publicationCandidateArtifact.create({
        data: {
          receiptId: job.preflightReceiptId!,
          logicalId: `tampered:${job.id}`,
          position: 99,
          artifactType: "GUIDE",
          path: `content/guides/tampered-${job.id}.mdx`,
          contentHash: sha256("tampered\n"),
          byteLength: 9,
          encoding: "UTF8",
          mediaType: "text/mdx; charset=utf-8",
          bytes: new TextEncoder().encode("tampered\n"),
        },
      }),
    ).rejects.toThrow();

    await processAgainstCurrentRuntime(job.id);
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ state: "SUCCEEDED", failureCode: null });
  });

  it("rejects a stale publisher claim without mutating the newer owner", async () => {
    const job = await requestChangedPublication(
      "Publisher stale claim fence checkpoint.",
    );
    const staleClaim = await claimPublicationJob(studio);
    expect(staleClaim?.id).toBe(job.id);
    if (!staleClaim) throw new Error("Test publication was not claimed.");
    await studio.publicationJob.update({
      where: { id: job.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    const currentClaim = await claimPublicationJob(studio);
    expect(currentClaim?.id).toBe(job.id);
    expect(currentClaim?.claimToken).not.toBe(staleClaim?.claimToken);

    await expect(
      processPublicationJob(
        {
          studio,
          leadershipPublisherUrl,
          ...runtimeContractDependencies(),
          runtimeIdentity: async () => {
            const identity = await leadershipIdentity(leadershipUrl);
            return {
              releaseId: identity.releaseId,
              manifestHash: identity.manifestHash,
            };
          },
        },
        job.id,
        staleClaim.claimToken,
      ),
    ).rejects.toThrow(/lease/iu);
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      state: "ASSEMBLING",
      claimToken: currentClaim?.claimToken,
    });
    await processAgainstCurrentRuntime(job.id);
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ state: "SUCCEEDED" });
  });

  it("reconciles a lost response after Leadership COMMIT idempotently", async () => {
    const before = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher ambiguous commit checkpoint.",
    );
    let lostResponses = 0;
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeIdentity: async () => {
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
        afterPromotionCommit: async () => {
          lostResponses += 1;
          throw new Error("Simulated connection loss after COMMIT.");
        },
      },
      job.id,
      await claimTokenForJob(job.id),
    );
    const after = await leadershipIdentity(leadershipUrl);
    expect(lostResponses).toBe(1);
    expect(after.generation).toBe(before.generation + 1n);
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ state: "SUCCEEDED", failureCode: null });
    const leadership = new Client({ connectionString: leadershipUrl });
    await leadership.connect();
    try {
      const releases = await leadership.query<{ count: string }>(
        `
          SELECT count(*)::text
            FROM content_releases
           WHERE studio_publication_id = $1
        `,
        [job.publicationId],
      );
      expect(releases.rows[0]?.count).toBe("1");
    } finally {
      await leadership.end();
    }
  });

  it("never restores a runtime-verified release after Studio finalization is interrupted", async () => {
    const before = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher finalization interruption checkpoint.",
    );
    let interrupted = false;
    await processAgainstCurrentRuntime(job.id, async (boundary) => {
      if (!interrupted && boundary === "RUNTIME_VERIFIED") {
        interrupted = true;
        throw new Error("Simulated Studio finalization outage.");
      }
    });
    const verifiedIdentity = await leadershipIdentity(leadershipUrl);
    expect(interrupted).toBe(true);
    expect(verifiedIdentity.generation).toBe(before.generation + 1n);
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      state: "VERIFYING",
      claimToken: null,
      failureCode: null,
    });

    await processAgainstCurrentRuntime(job.id);
    await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(
      verifiedIdentity,
    );
    const finalized = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { events: true, receipt: true },
    });
    expect(finalized.state).toBe("SUCCEEDED");
    expect(finalized.receipt).not.toBeNull();
    expect(
      finalized.events.filter((event) => event.kind === "VERIFIED"),
    ).toHaveLength(1);
    expect(
      finalized.events.filter((event) => event.kind === "SUCCEEDED"),
    ).toHaveLength(1);
    expect(
      finalized.events.filter((event) => event.kind === "RESTORED"),
    ).toHaveLength(0);
  });

  it("retries transient typed-route convergence before finalizing", async () => {
    const job = await requestChangedPublication(
      "Publisher typed route convergence checkpoint.",
    );
    const contract = runtimeContractDependencies();
    let routeCalls = 0;
    let capabilityCalls = 0;
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...contract,
        runtimeVerification: { attempts: 3, intervalMs: 0 },
        runtimeCapabilities: async () => {
          capabilityCalls += 1;
          if (capabilityCalls < 3)
            throw new LeadershipCapabilityError(
              "Leadership capability endpoint is still loading.",
              "RUNTIME_CAPABILITY_UNAVAILABLE",
              true,
            );
          return compatibleCapabilities();
        },
        runtimeIdentity: async () => {
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
        runtimeRouteProof: async (expected) => {
          routeCalls += 1;
          if (routeCalls < 3)
            throw new PublisherVerificationError(
              "Leadership route cache has not converged.",
              "AFFECTED_ROUTE_VERIFICATION_FAILED",
              true,
            );
          return contract.runtimeRouteProof(expected);
        },
      },
      job.id,
      await claimTokenForJob(job.id),
    );
    expect(routeCalls).toBe(3);
    expect(capabilityCalls).toBe(5);
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ state: "SUCCEEDED", failureCode: null });
  });

  it("rejects a tampered typed projection before Leadership promotion", async () => {
    const before = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher projection tamper defense checkpoint.",
    );
    await withStudioTriggersDisabled(async (client) => {
      const changed = await client.query(
        `
          UPDATE publication_preflight_receipts
             SET compiled_projection = jsonb_set(
               compiled_projection,
               '{frontmatter,title}',
               to_jsonb($2::text),
               false
             )
           WHERE id = $1
        `,
        [
          job.preflightReceiptId,
          "Tampered projection title that never existed in the Studio revision",
        ],
      );
      expect(changed.rowCount).toBe(1);
    });

    await processAgainstCurrentRuntime(job.id);
    await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(before);
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      state: "FAILED",
      failureCode: "CANONICAL_SNAPSHOT_INVALID",
    });
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("rejects a sealed revision whose publication intent was rewritten", async () => {
    const before = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher exact revision intent defense checkpoint.",
    );
    const revision = await studio.draftRevision.findUniqueOrThrow({
      where: { id: job.targetRevisionId },
      select: { bundleManifest: true },
    });
    const originalBundle = situationBundleSchema.parse(revision.bundleManifest);
    const originalBundleHash = bundleHash(originalBundle);
    const tamperedBundle = situationBundleSchema.parse({
      ...originalBundle,
      visibility: "UNPUBLISHED",
    });
    const tamperedBundleHash = bundleHash(tamperedBundle);
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    try {
      await withStudioTriggersDisabled(async (client) => {
        await client.query(
          `
            UPDATE draft_revisions
               SET bundle_manifest = $2::jsonb,
                   bundle_hash = $3
             WHERE id = $1
          `,
          [
            job.targetRevisionId,
            JSON.stringify(tamperedBundle),
            tamperedBundleHash,
          ],
        );
        await client.query(
          `
            UPDATE publication_preflight_receipts
               SET revision_bundle_hash = $2
             WHERE id = $1
          `,
          [job.preflightReceiptId, tamperedBundleHash],
        );
        await client.query(
          `
            UPDATE publication_jobs
               SET target_bundle_hash = $2
             WHERE id = $1
          `,
          [job.id, tamperedBundleHash],
        );
      });

      await processAgainstCurrentRuntime(job.id);
      await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(before);
      await expect(
        studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
      ).resolves.toMatchObject({
        state: "FAILED",
        failureCode: "CANONICAL_SNAPSHOT_INVALID",
      });
    } finally {
      await withStudioTriggersDisabled(async (client) => {
        await client.query(
          `
            UPDATE draft_revisions
               SET bundle_manifest = $2::jsonb,
                   bundle_hash = $3
             WHERE id = $1
          `,
          [
            job.targetRevisionId,
            JSON.stringify(originalBundle),
            originalBundleHash,
          ],
        );
        await client.query(
          `
            UPDATE publication_preflight_receipts
               SET revision_bundle_hash = $2
             WHERE id = $1
          `,
          [job.preflightReceiptId, originalBundleHash],
        );
        await client.query(
          `
            UPDATE publication_jobs
               SET target_bundle_hash = $2
             WHERE id = $1
          `,
          [job.id, originalBundleHash],
        );
      });
      await workflows.checkInSituation({
        actorId: user.id,
        checkoutId: job.checkoutId,
        fence: job.checkoutFence,
      });
    }
  });

  it("recomputes and rejects a forged complete candidate hash", async () => {
    const before = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher candidate hash recomputation checkpoint.",
    );
    const forgedCandidateHash = sha256(`forged:${job.id}`);
    await withStudioTriggersDisabled(async (client) => {
      await client.query(
        `
          UPDATE publication_preflight_receipts
             SET candidate_hash = $2
           WHERE id = $1
        `,
        [job.preflightReceiptId, forgedCandidateHash],
      );
      await client.query(
        `
          UPDATE publication_jobs
             SET candidate_hash = $2
           WHERE id = $1
        `,
        [job.id, forgedCandidateHash],
      );
    });

    await processAgainstCurrentRuntime(job.id);
    await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(before);
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      state: "FAILED",
      failureCode: "CANONICAL_SNAPSHOT_INVALID",
      candidateHash: forgedCandidateHash,
    });
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("quarantines a nonterminal rollout-era job without preflight evidence", async () => {
    const before = await leadershipIdentity(leadershipUrl);
    const legacy = await requestChangedPublication(
      "Publisher rollout-era legacy quarantine checkpoint.",
    );
    await withStudioTriggersDisabled(async (client) => {
      const changed = await client.query(
        `
          UPDATE publication_jobs
             SET preflight_receipt_id = NULL,
                 candidate_hash = NULL,
                 legacy_preflight_exempt = TRUE
           WHERE id = $1
        `,
        [legacy.id],
      );
      expect(changed.rowCount).toBe(1);
    });

    await processAgainstCurrentRuntime(legacy.id);
    await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(before);
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: legacy.id },
        include: { events: { orderBy: { sequence: "asc" } } },
      }),
    ).resolves.toMatchObject({
      state: "FAILED",
      failureCode: "PREFLIGHT_REQUIRED",
      preflightReceiptId: null,
      candidateHash: null,
      events: expect.arrayContaining([
        expect.objectContaining({ kind: "FAILED" }),
      ]),
    });
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: legacy.checkoutId,
      fence: legacy.checkoutFence,
    });
  });

  it("rejects an incomplete new situation before the production pointer advances", async () => {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const slug = "publisher-lifecycle-situation";
    const created = await workflows.createSituation({
      actorId: user.id,
      slug,
      title: "Publisher lifecycle situation",
    });
    const before = await leadershipIdentity(leadershipUrl);
    const jobCount = await studio.publicationJob.count({
      where: { situationId: created.situation.id },
    });
    await expect(
      queueCurrentPublication({
        actorId: user.id,
        checkoutId: created.checkout.id,
        fence: created.checkout.fence,
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      studio.situationCheckout.count({
        where: { id: created.checkout.id, releasedAt: null },
      }),
    ).resolves.toBe(1);
    await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(before);
    await expect(
      studio.publicationJob.count({
        where: { situationId: created.situation.id },
      }),
    ).resolves.toBe(jobCount);
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: created.checkout.id,
      fence: created.checkout.fence,
    });
  });

  it("retires and restores one situation through forward-only releases", async () => {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const situation = await studio.situation.findUniqueOrThrow({
      where: { slug: "defensive-about-feedback" },
    });
    const publicVersion =
      await studio.productionSituationVersion.findFirstOrThrow({
        where: {
          situationId: situation.id,
          sourceKind: "BOOTSTRAP_IMPORT",
        },
        orderBy: { productionAt: "desc" },
      });
    const beforeRetire = await typedSituation(situation.slug);
    const unrelatedBefore = await typedSituation("repeatedly-misses-deadlines");

    const retirementCheckout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    await workflows.createRetirementDraft({
      actorId: user.id,
      checkoutId: retirementCheckout.id,
      fence: retirementCheckout.fence,
    });
    const retireJob = await queueCurrentPublication({
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
    const afterRetire = await typedSituation(situation.slug);
    expect(afterRetire.situation).toMatchObject({
      slug: situation.slug,
      visibility: "RETIRED",
    });
    expect(afterRetire.identity.generation).toBe(
      beforeRetire.identity.generation + 1n,
    );
    await expect(
      studio.situation.findUniqueOrThrow({
        where: { id: situation.id },
        select: { visibility: true },
      }),
    ).resolves.toEqual({ visibility: "RETIRED" });

    const restorationCheckout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    await workflows.startRestorationDraft({
      actorId: user.id,
      checkoutId: restorationCheckout.id,
      fence: restorationCheckout.fence,
      productionVersionId: publicVersion.id,
    });
    const restoreJob = await queueCurrentPublication({
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
    const afterRestore = await typedSituation(situation.slug);
    expect(afterRestore.situation).toMatchObject({
      slug: situation.slug,
      visibility: "PUBLIC",
      body_mdx: beforeRetire.situation?.body_mdx,
    });
    expect(afterRestore.identity.generation).toBe(
      afterRetire.identity.generation + 1n,
    );
    const unrelatedAfter = await typedSituation("repeatedly-misses-deadlines");
    expect(unrelatedAfter.situation?.body_mdx).toBe(
      unrelatedBefore.situation?.body_mdx,
    );
    await expect(
      studio.productionSituationVersion.findMany({
        where: {
          situationId: situation.id,
          sourceKind: { in: ["RETIRE", "RESTORE"] },
        },
        orderBy: { productionAt: "asc" },
        select: { sourceKind: true },
      }),
    ).resolves.toEqual([{ sourceKind: "RETIRE" }, { sourceKind: "RESTORE" }]);
  });

  it("rejects a scoped guide candidate the canonical contract cannot represent", async () => {
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
    const originalBundle = situationBundleSchema.parse(
      firstRevision?.bundleManifest,
    );
    const originalRelationship = originalBundle.relationships.find(
      (relationship) =>
        relationship.logicalId === `guide:${fixture.guide_slug}`,
    );
    if (!originalRelationship)
      throw new Error("The shared guide relationship is unavailable.");
    const before = await leadershipIdentity(leadershipUrl);
    const jobCount = await studio.publicationJob.count({
      where: { situationId: situation.id },
    });
    try {
      await expect(
        workflows.createScopedArtifactEdit({
          actorId: user.id,
          checkoutId: firstCheckout.id,
          fence: firstCheckout.fence,
          originalLogicalId: originalRelationship.logicalId,
          kind: "GUIDE",
          originalContentHash: originalRelationship.contentHash,
          changedBody: canonicalText(
            `${fixture.body_mdx}\nScoped only to ${fixture.target_slug}.`,
          ),
        }),
      ).rejects.toMatchObject({ status: 422, code: "INVALID_CONTENT" });
      await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(before);
      await expect(
        studio.publicationJob.count({ where: { situationId: situation.id } }),
      ).resolves.toBe(jobCount);
    } finally {
      await workflows.checkInSituation({
        actorId: user.id,
        checkoutId: firstCheckout.id,
        fence: firstCheckout.fence,
      });
    }
  });

  it("rejects an incomplete scoped practice before queuing and publishes a complete replacement", async () => {
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    const situation = await studio.situation.findUniqueOrThrow({
      where: { slug: "nothing-in-one-on-ones" },
    });
    const checkout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: user.id,
    });
    const workspace = await workflows.workspaceForSlug(situation.slug);
    const revision = workspace?.drafts[0]?.revisions[0];
    const sourceBundle = situationBundleSchema.parse(revision?.bundleManifest);
    const practiceRelationship = sourceBundle.relationships.find(
      (relationship) => relationship.kind === "PRACTICE",
    );
    if (!practiceRelationship)
      throw new Error("The test situation has no practice relationship.");
    const rounds = [
      {
        id: "notice",
        setup: "A delivery commitment slips for the second time.",
        prompt: "What do you do first?",
        choices: [
          {
            id: "ask",
            label: "Ask for the most recent example.",
            consequenceId: "specific",
            consequence: "The conversation starts with observable detail.",
            explanation: "A specific example slows premature diagnosis.",
            signal: "toward",
          },
          {
            id: "label",
            label: "Call the person unreliable.",
            consequenceId: "judged",
            consequence: "A character judgment replaces the work pattern.",
            explanation: "Describe the pattern before evaluating the person.",
            signal: "away",
          },
        ],
      },
      {
        id: "follow-up",
        setup: "You agree on one next commitment.",
        prompt: "How do you close?",
        choices: [
          {
            id: "date",
            label: "Set a dated follow-up.",
            consequenceId: "visible",
            consequence: "The commitment has a clear review point.",
            explanation: "A date makes follow-through observable.",
            signal: "toward",
          },
          {
            id: "hope",
            label: "Say you hope it improves.",
            consequenceId: "vague",
            consequence: "Ownership and timing remain unclear.",
            explanation: "Close with a concrete owner and review point.",
            signal: "away",
          },
        ],
      },
    ];
    const practice = {
      id: "delivery-follow-up",
      title: "Name the pattern and follow up",
      description: "Practice moving from an example to a dated commitment.",
      estimatedTime: "3 minutes",
      rounds: rounds.slice(0, 1),
    };
    await expect(
      workflows.createScopedArtifactEdit({
        actorId: user.id,
        checkoutId: checkout.id,
        fence: checkout.fence,
        originalLogicalId: practiceRelationship.logicalId,
        kind: "PRACTICE",
        originalContentHash: practiceRelationship.contentHash,
        changedBody: canonicalJson(practice),
      }),
    ).rejects.toMatchObject({ code: "INVALID_SCOPED_ARTIFACT", status: 422 });
    practice.rounds = rounds;
    const scoped = await workflows.createScopedArtifactEdit({
      actorId: user.id,
      checkoutId: checkout.id,
      fence: checkout.fence,
      originalLogicalId: practiceRelationship.logicalId,
      kind: "PRACTICE",
      originalContentHash: practiceRelationship.contentHash,
      changedBody: canonicalJson(practice),
    });
    const job = await queueCurrentPublication({
      actorId: user.id,
      checkoutId: checkout.id,
      fence: checkout.fence,
    });
    await processAgainstCurrentRuntime(job.id);
    const published = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { attempts: true, events: { orderBy: { sequence: "asc" } } },
    });
    if (published.state !== "SUCCEEDED")
      throw new Error(
        `Scoped practice publication failed: ${JSON.stringify(
          {
            published,
            error:
              lastPublisherError instanceof Error
                ? {
                    name: lastPublisherError.name,
                    message: lastPublisherError.message,
                    cause:
                      lastPublisherError.cause instanceof Error
                        ? lastPublisherError.cause.message
                        : lastPublisherError.cause,
                  }
                : lastPublisherError,
          },
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
        )}`,
      );
    expect(published).toMatchObject({ state: "SUCCEEDED", failureCode: null });

    const release = await leadershipIdentity(leadershipUrl);
    const leadership = new Client({ connectionString: leadershipUrl });
    await leadership.connect();
    try {
      const proof = await leadership.query<{
        practices: string;
        rounds: string;
      }>(
        `
          SELECT
            count(DISTINCT practice.id)::text AS practices,
            count(round.id)::text AS rounds
          FROM practices practice
          LEFT JOIN practice_rounds round
            ON round.practice_version_id = practice.id
          WHERE practice.release_id = $1
            AND practice.visibility = 'SITUATION_SCOPED'
            AND practice.owner_situation_slug = $2
            AND practice.forked_from_logical_id = $3
            AND practice.forked_from_content_hash = $4
        `,
        [
          release.releaseId,
          situation.slug,
          practiceRelationship.logicalId,
          practiceRelationship.contentHash,
        ],
      );
      expect(proof.rows[0]).toEqual({ practices: "1", rounds: "2" });
      expect(scoped.variant.visibility).toBe("SITUATION_SCOPED");
    } finally {
      await leadership.end();
    }

    const history = await readLeadershipReleaseHistory(leadershipReaderUrl);
    const publishedRelease = history.find(
      (candidate) => candidate.identity.releaseId === release.releaseId,
    );
    const publishedSituation = publishedRelease?.situations.find(
      (candidate) => candidate.slug === situation.slug,
    );
    if (!publishedSituation)
      throw new Error("The scoped-practice release was absent from history.");
    const restoredPracticeRelationship =
      publishedSituation.bundle.relationships.find(
        (relationship) => relationship.kind === "PRACTICE",
      );
    expect(publishedSituation.bundle.metadata.practiceId).toBe(
      sourceBundle.metadata.practiceId,
    );
    expect(restoredPracticeRelationship).toMatchObject({
      logicalId: scoped.variant.logicalId,
      originalLogicalId: practiceRelationship.originalLogicalId,
      contentHash: scoped.variant.contentHash,
      visibility: "SITUATION_SCOPED",
    });
    const storedProduction =
      await studio.productionSituationVersion.findFirstOrThrow({
        where: {
          situationId: situation.id,
          observation: { releaseId: release.releaseId },
        },
      });
    const reconstructedBundle = situationBundleSchema.parse({
      ...publishedSituation.bundle,
      situationId: situation.id,
      artifacts: publishedSituation.bundle.artifacts.map((artifact) => ({
        ...artifact,
        ownerSituationId:
          artifact.visibility === "GLOBAL" ? null : situation.id,
      })),
    });
    expect(reconstructedBundle).toEqual(
      situationBundleSchema.parse(storedProduction.bundleManifest),
    );
    expect(bundleHash(reconstructedBundle)).toBe(storedProduction.bundleHash);
  });

  it.each<PublisherBoundary>([
    "CANDIDATE_PERSISTED",
    "LEADERSHIP_PROMOTION_COMMITTED",
    "LEADERSHIP_PROMOTED",
    "RUNTIME_VERIFIED",
    "STUDIO_SUCCESS_FINALIZING",
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
      include: {
        attempts: true,
        receipt: true,
        events: { orderBy: { sequence: "asc" } },
      },
    });
    if (persisted.state !== "SUCCEEDED")
      throw new Error(
        `Crash reconciliation failed: ${JSON.stringify(
          persisted,
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
        )}`,
      );
    expect(persisted.state).toBe("SUCCEEDED");
    expect(persisted.attempts).toHaveLength(2);
    expect(
      persisted.attempts.filter((attempt) => attempt.finishedAt),
    ).toHaveLength(2);
    expect(
      persisted.attempts.find((attempt) => attempt.attempt === 1),
    ).toMatchObject({
      failureCode: "PUBLISHER_PROCESS_INTERRUPTED",
      reconciledState: {
        outcome: "INTERRUPTED_BEFORE_RETRY",
        supersededByAttempt: 2,
      },
    });
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

  it("recovers only a persisted legacy candidate interrupted after promotion", async () => {
    const before = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher persisted legacy recovery checkpoint.",
    );
    await expect(
      processAgainstCurrentRuntime(job.id, async (boundary) => {
        if (boundary === "LEADERSHIP_PROMOTED")
          throw new PublisherCrashInjectionError(boundary);
      }),
    ).rejects.toThrow(PublisherCrashInjectionError);
    const interrupted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { preflightReceipt: true },
    });
    const receipt = interrupted.preflightReceipt;
    if (!receipt) throw new Error("Interrupted test job lost its receipt.");
    expect(interrupted.state).toBe("PROMOTING");
    await expect(
      studio.publicationCandidateSnapshot.findUniqueOrThrow({
        where: { jobId: job.id },
      }),
    ).resolves.toMatchObject({
      releaseId: receipt.releaseId,
      parentReleaseId: receipt.baseReleaseId,
      expectedPointerGeneration: receipt.expectedPointerGeneration,
      manifestHash: receipt.manifestHash,
      manifestBody: receipt.manifestBody,
      artifactCount: receipt.artifactCount,
      edgeCount: receipt.edgeCount,
      totalByteLength: receipt.totalByteLength,
    });
    await withStudioTriggersDisabled(async (client) => {
      await client.query(
        `
          UPDATE publication_jobs
             SET preflight_receipt_id = NULL,
                 candidate_hash = NULL,
                 legacy_preflight_exempt = TRUE
           WHERE id = $1
        `,
        [job.id],
      );
    });

    await processAgainstCurrentRuntime(job.id);
    const after = await leadershipIdentity(leadershipUrl);
    expect(after.generation).toBe(before.generation + 1n);
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      state: "SUCCEEDED",
      preflightReceiptId: null,
      candidateHash: null,
      legacyPreflightExempt: true,
    });
  });

  it("restores a promoted crash retry when capabilities become unavailable", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher capability failure after promotion.",
    );
    let injected = false;
    await expect(
      processAgainstCurrentRuntime(job.id, async (boundary) => {
        if (!injected && boundary === "LEADERSHIP_PROMOTED") {
          injected = true;
          throw new PublisherCrashInjectionError(boundary);
        }
      }),
    ).rejects.toThrow(PublisherCrashInjectionError);
    expect(injected).toBe(true);
    const promotedJob = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect((await leadershipIdentity(leadershipUrl)).releaseId).toBe(
      promotedJob.leadershipReleaseId,
    );

    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeVerification: { attempts: 1, intervalMs: 0 },
        runtimeCapabilities: async () => {
          throw new LeadershipCapabilityError(
            "Leadership capabilities are unavailable after restart.",
            "RUNTIME_CAPABILITY_UNAVAILABLE",
            true,
          );
        },
        runtimeIdentity: async () => {
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
      },
      job.id,
      await claimTokenForJob(job.id),
    );
    await expect(leadershipIdentity(leadershipUrl)).resolves.toMatchObject({
      releaseId: prior.releaseId,
      manifestHash: prior.manifestHash,
      generation: prior.generation + 2n,
    });
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { receipt: true },
      }),
    ).resolves.toMatchObject({
      state: "RESTORED",
      failureCode: "RUNTIME_CAPABILITY_UNAVAILABLE_RESTORED",
      receipt: null,
    });
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("yields a lease-lost attempt without mutating the replacement owner", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher claim handoff checkpoint.",
    );
    const firstClaim = await claimPublicationJob(studio);
    expect(firstClaim?.id).toBe(job.id);
    await expect(claimPublicationJob(studio)).resolves.toBeNull();
    let replacementClaim: Awaited<ReturnType<typeof claimPublicationJob>> =
      null;
    await expect(
      processAgainstCurrentRuntime(
        job.id,
        async (boundary) => {
          if (boundary !== "CANDIDATE_PERSISTED" || replacementClaim) return;
          const expired = await studio.publicationJob.updateMany({
            where: { id: job.id, claimToken: firstClaim?.claimToken },
            data: { leaseExpiresAt: new Date(0) },
          });
          expect(expired.count).toBe(1);
          replacementClaim = await claimPublicationJob(studio);
          expect(replacementClaim?.id).toBe(job.id);
        },
        firstClaim?.claimToken,
      ),
    ).rejects.toThrow(/lease|authority/iu);

    await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(prior);
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { attempts: { orderBy: { attempt: "asc" } } },
      }),
    ).resolves.toMatchObject({
      state: "ASSEMBLING",
      claimToken: replacementClaim?.claimToken,
      finishedAt: null,
      failureCode: null,
      attempts: [expect.objectContaining({ finishedAt: null })],
    });

    await processAgainstCurrentRuntime(
      job.id,
      undefined,
      replacementClaim?.claimToken,
    );
    const completed = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { attempts: { orderBy: { attempt: "asc" } } },
    });
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.attempts).toHaveLength(2);
    expect(completed.attempts[0]).toMatchObject({
      finishedAt: expect.any(Date),
      failureCode: "PUBLISHER_PROCESS_INTERRUPTED",
    });
    expect(completed.attempts[1]).toMatchObject({
      finishedAt: expect.any(Date),
      failureCode: null,
    });
  });

  it.each<PublisherBoundary>([
    "LEADERSHIP_PROMOTION_READY",
    "LEADERSHIP_PROMOTION_COMMIT_READY",
  ])(
    "rolls back Leadership promotion when the claim is replaced at %s",
    async (claimLossBoundary) => {
      const prior = await leadershipIdentity(leadershipUrl);
      const job = await requestChangedPublication(
        "Publisher final promotion fence checkpoint.",
      );
      const firstClaim = await claimPublicationJob(studio);
      expect(firstClaim?.id).toBe(job.id);
      let replacementClaim: Awaited<ReturnType<typeof claimPublicationJob>> =
        null;

      await expect(
        processPublicationJob(
          {
            studio,
            leadershipPublisherUrl,
            ...runtimeContractDependencies(),
            publicationLeaseHeartbeatMs: 120_000,
            runtimeIdentity: async () => {
              const identity = await leadershipIdentity(leadershipUrl);
              return {
                releaseId: identity.releaseId,
                manifestHash: identity.manifestHash,
              };
            },
            afterBoundary: async (boundary) => {
              if (boundary !== claimLossBoundary || replacementClaim) return;
              const expired = await studio.publicationJob.updateMany({
                where: { id: job.id, claimToken: firstClaim?.claimToken },
                data: { leaseExpiresAt: new Date(0) },
              });
              expect(expired.count).toBe(1);
              replacementClaim = await claimPublicationJob(studio);
              expect(replacementClaim?.id).toBe(job.id);
            },
          },
          job.id,
          firstClaim?.claimToken,
        ),
      ).rejects.toThrow(/lease|authority/iu);

      await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(prior);
      const leadership = new Client({ connectionString: leadershipUrl });
      await leadership.connect();
      try {
        const releases = await leadership.query<{ count: string }>(
          `
          SELECT count(*)::text
            FROM content_releases
           WHERE studio_publication_id = $1
        `,
          [job.publicationId],
        );
        expect(releases.rows[0]?.count).toBe("0");
      } finally {
        await leadership.end();
      }
      await expect(
        studio.publicationJob.findUniqueOrThrow({
          where: { id: job.id },
          include: { attempts: { orderBy: { attempt: "asc" } } },
        }),
      ).resolves.toMatchObject({
        state: "PROMOTING",
        claimToken: replacementClaim?.claimToken,
        finishedAt: null,
        failureCode: null,
        attempts: [expect.objectContaining({ finishedAt: null })],
      });

      await processAgainstCurrentRuntime(
        job.id,
        undefined,
        replacementClaim?.claimToken,
      );
      await expect(
        studio.publicationJob.findUniqueOrThrow({
          where: { id: job.id },
          include: { attempts: { orderBy: { attempt: "asc" } } },
        }),
      ).resolves.toMatchObject({
        state: "SUCCEEDED",
        attempts: [
          expect.objectContaining({
            finishedAt: expect.any(Date),
            failureCode: "PUBLISHER_PROCESS_INTERRUPTED",
          }),
          expect.objectContaining({
            finishedAt: expect.any(Date),
            failureCode: null,
          }),
        ],
      });
    },
  );

  it("uses the sealed candidate when a legacy mutable job base is changed", async () => {
    const job = await requestChangedPublication(
      "Publisher persisted-candidate conflict checkpoint.",
    );
    let injected = false;
    await expect(
      processAgainstCurrentRuntime(job.id, async (boundary) => {
        if (!injected && boundary === "CANDIDATE_PERSISTED") {
          injected = true;
          throw new PublisherCrashInjectionError(boundary);
        }
      }),
    ).rejects.toThrow(PublisherCrashInjectionError);
    expect(injected).toBe(true);
    await studio.publicationJob.update({
      where: { id: job.id },
      data: { baseBundleHash: "f".repeat(64) },
    });

    await processAgainstCurrentRuntime(job.id);
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { attempts: { orderBy: { attempt: "asc" } } },
      }),
    ).resolves.toMatchObject({
      state: "SUCCEEDED",
      failureCode: null,
      attempts: [
        expect.objectContaining({
          finishedAt: expect.any(Date),
          failureCode: "PUBLISHER_PROCESS_INTERRUPTED",
        }),
        expect.objectContaining({
          finishedAt: expect.any(Date),
          failureCode: null,
          reconciledState: expect.objectContaining({ outcome: "SUCCEEDED" }),
        }),
      ],
    });
  });

  it("rolls back all Studio success state before restoring Leadership", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const situationBefore = await studio.situation.findUniqueOrThrow({
      where: { slug: "repeatedly-misses-deadlines" },
      select: {
        id: true,
        productionReleaseId: true,
        productionBundleHash: true,
        productionAt: true,
      },
    });
    const versionsBefore = await studio.productionSituationVersion.count({
      where: { situationId: situationBefore.id },
    });
    const job = await requestChangedPublication(
      "Publisher atomic Studio finalization checkpoint.",
    );
    let injected = false;
    await expect(
      processAgainstCurrentRuntime(job.id, async (boundary) => {
        if (!injected && boundary === "LEADERSHIP_PROMOTED") {
          injected = true;
          throw new PublisherCrashInjectionError(boundary);
        }
      }),
    ).rejects.toThrow(PublisherCrashInjectionError);
    expect(injected).toBe(true);
    const promotedJob = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { preflightReceipt: true },
    });
    expect((await leadershipIdentity(leadershipUrl)).releaseId).toBe(
      promotedJob.preflightReceipt?.releaseId,
    );

    const leadership = new Client({ connectionString: leadershipUrl });
    await leadership.connect();
    try {
      await leadership.query("SET session_replication_role = replica");
      const corrupted = await leadership.query<{ id: string }>(
        `
          UPDATE artifact_versions version
             SET text_body = version.text_body || E'\ncorrupted after promotion\n'
            FROM release_artifacts membership
           WHERE membership.release_id = $1
             AND membership.logical_id = 'situation:repeatedly-misses-deadlines'
             AND version.id = membership.artifact_version_id
          RETURNING version.id
        `,
        [promotedJob.preflightReceipt?.releaseId],
      );
      expect(corrupted.rowCount).toBe(1);
    } finally {
      await leadership
        .query("SET session_replication_role = origin")
        .catch(() => undefined);
      await leadership.end();
    }

    await processAgainstCurrentRuntime(job.id);

    await expect(leadershipIdentity(leadershipUrl)).resolves.toMatchObject({
      releaseId: prior.releaseId,
      manifestHash: prior.manifestHash,
      generation: prior.generation + 2n,
    });
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { attempts: true, receipt: true },
      }),
    ).resolves.toMatchObject({
      state: "RESTORED",
      receipt: null,
      attempts: [
        expect.objectContaining({
          finishedAt: expect.any(Date),
          failureCode: "PUBLISHER_PROCESS_INTERRUPTED",
        }),
        expect.objectContaining({
          finishedAt: expect.any(Date),
          failureCode: "POST_PROMOTION_VERIFICATION",
        }),
      ],
    });
    await expect(
      studio.situation.findUniqueOrThrow({
        where: { id: situationBefore.id },
        select: {
          id: true,
          productionReleaseId: true,
          productionBundleHash: true,
          productionAt: true,
        },
      }),
    ).resolves.toEqual(situationBefore);
    await expect(
      studio.productionSituationVersion.count({
        where: { situationId: situationBefore.id },
      }),
    ).resolves.toBe(versionsBefore);
    await expect(
      studio.situationCheckout.count({
        where: { id: job.checkoutId, releasedAt: null },
      }),
    ).resolves.toBe(1);
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("keeps an atomically committed Studio success when acknowledgement is lost", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher ambiguous Studio commit checkpoint.",
    );
    lastPublisherError = undefined;
    let injected = false;
    await processAgainstCurrentRuntime(job.id, async (boundary) => {
      if (!injected && boundary === "STUDIO_SUCCESS_COMMITTED") {
        injected = true;
        throw new Error("Simulated lost Studio commit acknowledgement.");
      }
    });
    expect(injected).toBe(true);
    expect(lastPublisherError).toBeUndefined();

    const current = await leadershipIdentity(leadershipUrl);
    expect(current.generation).toBe(prior.generation + 1n);
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { attempts: true, receipt: true },
      }),
    ).resolves.toMatchObject({
      state: "SUCCEEDED",
      leadershipReleaseId: current.releaseId,
      receipt: expect.objectContaining({
        expectedReleaseId: current.releaseId,
        expectedManifestHash: current.manifestHash,
      }),
      attempts: [
        expect.objectContaining({
          finishedAt: expect.any(Date),
          failureCode: null,
          reconciledState: expect.objectContaining({ outcome: "SUCCEEDED" }),
        }),
      ],
    });
  });

  it("restores when Leadership commits promotion before Studio can observe it", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher ambiguous promotion-commit checkpoint.",
    );
    let injected = false;
    await processAgainstCurrentRuntime(job.id, async (boundary) => {
      if (!injected && boundary === "LEADERSHIP_PROMOTION_COMMITTED") {
        injected = true;
        throw new Error(
          "Simulated connection loss after promotion commit acknowledgement.",
        );
      }
    });
    expect(injected).toBe(true);

    const restored = await leadershipIdentity(leadershipUrl);
    const persisted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: {
        attempts: { orderBy: { attempt: "asc" } },
        candidateSnapshot: true,
        receipt: true,
      },
    });
    const candidate = persisted.candidateSnapshot;
    expect(candidate).not.toBeNull();
    expect(restored).toMatchObject({
      releaseId: prior.releaseId,
      manifestHash: prior.manifestHash,
      generation: prior.generation + 2n,
    });
    expect(persisted).toMatchObject({
      state: "RESTORED",
      failureCode: "VERIFICATION_FAILED_RESTORED",
      receipt: null,
    });
    expect(persisted.attempts).toHaveLength(1);
    expect(persisted.attempts[0]).toMatchObject({
      finishedAt: expect.any(Date),
      failureCode: "POST_PROMOTION_VERIFICATION",
      reconciledState: expect.objectContaining({
        failureCode: "PUBLICATION_FAILED",
        promoted: true,
        promotionAttempted: true,
        promotionStateUnverified: false,
      }),
    });
    await expect(claimPublicationJob(studio)).resolves.toBeNull();
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("finishes the attempt when the Leadership database connection fails", async () => {
    const job = await requestChangedPublication(
      "Publisher connection failure checkpoint.",
    );
    let observedFailure: unknown;
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl:
          "postgresql://publisher" +
          ":publisher@127.0.0.1:1/leadership?connect_timeout=1",
        ...runtimeContractDependencies(),
        runtimeIdentity: async () => {
          throw new Error("Runtime identity must not run without Leadership.");
        },
        onFailure: (error) => {
          observedFailure = error;
        },
      },
      job.id,
      await claimTokenForJob(job.id),
    );
    expect(observedFailure).toBeInstanceOf(Error);
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { attempts: true },
      }),
    ).resolves.toMatchObject({
      state: "FAILED",
      failureCode: "PUBLICATION_FAILED",
      attempts: [
        expect.objectContaining({
          finishedAt: expect.any(Date),
          failureCode: "PUBLICATION_FAILED",
        }),
      ],
    });
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("keeps a promoted candidate out of Studio while recovery is required", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Leadership reconciliation recovery-fence checkpoint.",
    );
    let injected = false;
    await expect(
      processAgainstCurrentRuntime(job.id, async (boundary) => {
        if (!injected && boundary === "LEADERSHIP_PROMOTED") {
          injected = true;
          throw new PublisherCrashInjectionError(boundary);
        }
      }),
    ).rejects.toThrow(PublisherCrashInjectionError);
    expect(injected).toBe(true);

    const promoted = await leadershipIdentity(leadershipUrl);
    const persisted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { candidateSnapshot: true },
    });
    const candidate = persisted.candidateSnapshot;
    expect(candidate).not.toBeNull();
    expect(promoted.releaseId).toBe(candidate?.releaseId);
    expect(promoted.releaseId).not.toBe(prior.releaseId);

    await studio.$transaction(async (transaction) => {
      await transaction.publicationJob.update({
        where: { id: job.id },
        data: {
          state: "RECOVERY_REQUIRED",
          failureCode: "PROMOTION_STATE_UNVERIFIED",
          claimToken: null,
          leaseExpiresAt: null,
        },
      });
      await transaction.publicationAttempt.updateMany({
        where: { jobId: job.id, finishedAt: null },
        data: {
          finishedAt: new Date(),
          failureCode: "PROMOTION_STATE_UNVERIFIED",
        },
      });
    });

    try {
      const externalCandidate =
        await readOfficialLeadershipRelease(leadershipReaderUrl);
      expect(externalCandidate.identity).toMatchObject({
        releaseId: candidate?.releaseId,
        manifestHash: candidate?.manifestHash,
        state: "OFFICIAL",
      });
      const [observationsBefore, versionsBefore, pointersBefore, cursorBefore] =
        await Promise.all([
          studio.leadershipReleaseObservation.findMany({
            orderBy: { id: "asc" },
            select: { id: true, releaseId: true },
          }),
          studio.productionSituationVersion.findMany({
            orderBy: { id: "asc" },
            select: { id: true, observationId: true, situationId: true },
          }),
          studio.situation.findMany({
            orderBy: { id: "asc" },
            select: {
              id: true,
              title: true,
              visibility: true,
              productionBundleHash: true,
              productionReleaseId: true,
              productionAt: true,
            },
          }),
          studio.leadershipSyncCursor.findUnique({
            where: { id: "official" },
          }),
        ]);

      const recoveryGuard =
        await captureLeadershipReleaseReconciliationGuard(studio);
      expect(recoveryGuard).toMatchObject({
        state: "BLOCKED",
        publicationJobId: job.id,
        publicationState: "RECOVERY_REQUIRED",
      });
      await expect(
        reconcileOfficialLeadershipRelease(
          studio,
          externalCandidate,
          recoveryGuard.guard,
        ),
      ).resolves.toMatchObject({
        state: "BLOCKED",
        publicationJobId: job.id,
        publicationState: "RECOVERY_REQUIRED",
      });
      const { reconcileLeadershipRelease } =
        await import("@/server/leadership-sync");
      await expect(
        reconcileLeadershipRelease({ force: true }),
      ).resolves.toBeUndefined();

      await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(
        promoted,
      );
      await expect(
        studio.leadershipReleaseObservation.findMany({
          orderBy: { id: "asc" },
          select: { id: true, releaseId: true },
        }),
      ).resolves.toEqual(observationsBefore);
      await expect(
        studio.productionSituationVersion.findMany({
          orderBy: { id: "asc" },
          select: { id: true, observationId: true, situationId: true },
        }),
      ).resolves.toEqual(versionsBefore);
      await expect(
        studio.situation.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            title: true,
            visibility: true,
            productionBundleHash: true,
            productionReleaseId: true,
            productionAt: true,
          },
        }),
      ).resolves.toEqual(pointersBefore);
      await expect(
        studio.leadershipSyncCursor.findUnique({
          where: { id: "official" },
        }),
      ).resolves.toEqual(cursorBefore);
      await expect(
        studio.leadershipReleaseObservation.findUnique({
          where: { releaseId: promoted.releaseId },
        }),
      ).resolves.toBeNull();
    } finally {
      if (!candidate)
        throw new Error("Promoted test publication has no candidate snapshot.");
      const leadership = new Client({
        connectionString: leadershipPublisherUrl,
      });
      await leadership.connect();
      try {
        const current = await leadershipIdentity(leadershipUrl);
        if (current.releaseId === candidate.releaseId)
          await leadership.query(
            `
              SELECT *
                FROM leadership_studio_restore_release(
                  $1, $2, $3, $4, $5::varchar(240)
                )
            `,
            [
              candidate.releaseId,
              candidate.parentReleaseId,
              job.publicationId,
              current.generation.toString(),
              "Restore reconciliation recovery-fence integration fixture",
            ],
          );
      } finally {
        await leadership.end();
      }
      await expect(
        reconcilePublicationRecovery({
          studio,
          leadershipPublisherUrl,
          ...runtimeContractDependencies(),
          runtimeVerification: { attempts: 1, intervalMs: 0 },
          runtimeIdentity: async () => {
            const identity = await leadershipIdentity(leadershipUrl);
            return {
              releaseId: identity.releaseId,
              manifestHash: identity.manifestHash,
            };
          },
        }),
      ).resolves.toBe(1);
      const user = await studio.user.findUniqueOrThrow({
        where: { username: "publisher-test-editor" },
      });
      await workflows.checkInSituation({
        actorId: user.id,
        checkoutId: job.checkoutId,
        fence: job.checkoutFence,
      });
    }
  });

  it("rejects a Leadership snapshot when the publication set changed during its read", async () => {
    const staleGuard =
      await captureLeadershipReleaseReconciliationGuard(studio);
    expect(staleGuard.state).toBe("READY");
    const staleSnapshot =
      await readOfficialLeadershipRelease(leadershipReaderUrl);

    const job = await requestChangedPublication(
      "Leadership reconciliation stale-guard checkpoint.",
    );
    await processAgainstCurrentRuntime(job.id);
    const currentIdentity = await leadershipIdentity(leadershipUrl);
    expect(currentIdentity.releaseId).not.toBe(
      staleSnapshot.identity.releaseId,
    );

    const currentGuard =
      await captureLeadershipReleaseReconciliationGuard(studio);
    expect(currentGuard.state).toBe("READY");
    const currentSnapshot =
      await readOfficialLeadershipRelease(leadershipReaderUrl);
    await expect(
      reconcileOfficialLeadershipRelease(
        studio,
        currentSnapshot,
        currentGuard.guard,
      ),
    ).resolves.toMatchObject({ state: "IMPORTED" });

    const [observationsBefore, versionsBefore, pointersBefore, cursorBefore] =
      await Promise.all([
        studio.leadershipReleaseObservation.findMany({
          orderBy: { id: "asc" },
          select: { id: true, releaseId: true },
        }),
        studio.productionSituationVersion.findMany({
          orderBy: { id: "asc" },
          select: { id: true, observationId: true, situationId: true },
        }),
        studio.situation.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            title: true,
            visibility: true,
            productionBundleHash: true,
            productionReleaseId: true,
            productionAt: true,
          },
        }),
        studio.leadershipSyncCursor.findUnique({
          where: { id: "official" },
        }),
      ]);
    expect(cursorBefore?.lastReleaseId).toBe(currentIdentity.releaseId);

    await expect(
      reconcileOfficialLeadershipRelease(
        studio,
        staleSnapshot,
        staleGuard.guard,
      ),
    ).resolves.toEqual({
      state: "STALE_GUARD",
      guardedPublicationJobCount: staleGuard.guard.publicationJobCount,
      observedPublicationJobCount: currentGuard.guard.publicationJobCount,
    });

    await expect(leadershipIdentity(leadershipUrl)).resolves.toEqual(
      currentIdentity,
    );
    await expect(
      studio.leadershipReleaseObservation.findMany({
        orderBy: { id: "asc" },
        select: { id: true, releaseId: true },
      }),
    ).resolves.toEqual(observationsBefore);
    await expect(
      studio.productionSituationVersion.findMany({
        orderBy: { id: "asc" },
        select: { id: true, observationId: true, situationId: true },
      }),
    ).resolves.toEqual(versionsBefore);
    await expect(
      studio.situation.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          title: true,
          visibility: true,
          productionBundleHash: true,
          productionReleaseId: true,
          productionAt: true,
        },
      }),
    ).resolves.toEqual(pointersBefore);
    await expect(
      studio.leadershipSyncCursor.findUnique({
        where: { id: "official" },
      }),
    ).resolves.toEqual(cursorBefore);
  });

  it("restores a promoted crash retry when capabilities become unavailable", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher capability failure after promotion.",
    );
    let injected = false;
    await expect(
      processAgainstCurrentRuntime(job.id, async (boundary) => {
        if (!injected && boundary === "LEADERSHIP_PROMOTED") {
          injected = true;
          throw new PublisherCrashInjectionError(boundary);
        }
      }),
    ).rejects.toThrow(PublisherCrashInjectionError);
    expect(injected).toBe(true);
    const promotedJob = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect((await leadershipIdentity(leadershipUrl)).releaseId).toBe(
      promotedJob.leadershipReleaseId,
    );

    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeCapabilities: async () => {
          throw new LeadershipCapabilityError(
            "Leadership capabilities are unavailable after restart.",
            "RUNTIME_CAPABILITY_UNAVAILABLE",
            true,
          );
        },
        runtimeIdentity: async () => {
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
      },
      job.id,
      await claimTokenForJob(job.id),
    );
    await expect(leadershipIdentity(leadershipUrl)).resolves.toMatchObject({
      releaseId: prior.releaseId,
      manifestHash: prior.manifestHash,
      generation: prior.generation + 2n,
    });
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { receipt: true },
      }),
    ).resolves.toMatchObject({
      state: "RESTORED",
      failureCode: "RUNTIME_CAPABILITY_UNAVAILABLE_RESTORED",
      receipt: null,
    });
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("restores an already-promoted candidate when persisted validation fails after restart", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher invalid promoted retry recovery.",
    );
    let injected = false;
    await expect(
      processAgainstCurrentRuntime(job.id, async (boundary) => {
        if (!injected && boundary === "LEADERSHIP_PROMOTED") {
          injected = true;
          throw new PublisherCrashInjectionError(boundary);
        }
      }),
    ).rejects.toThrow(PublisherCrashInjectionError);
    expect(injected).toBe(true);
    const promotedJob = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { candidateSnapshot: true },
    });
    expect((await leadershipIdentity(leadershipUrl)).releaseId).toBe(
      promotedJob.candidateSnapshot?.releaseId,
    );

    const leadership = new Client({ connectionString: leadershipUrl });
    await leadership.connect();
    try {
      await leadership.query("SET session_replication_role = replica");
      const corrupted = await leadership.query<{ id: string }>(
        `
          UPDATE artifact_versions version
             SET text_body = version.text_body || E'\ncorrupted after promotion\n'
            FROM release_artifacts membership
           WHERE membership.release_id = $1
             AND membership.logical_id = 'situation:repeatedly-misses-deadlines'
             AND version.id = membership.artifact_version_id
          RETURNING version.id
        `,
        [promotedJob.candidateSnapshot?.releaseId],
      );
      expect(corrupted.rowCount).toBe(1);
    } finally {
      await leadership
        .query("SET session_replication_role = origin")
        .catch(() => undefined);
      await leadership.end();
    }

    await processAgainstCurrentRuntime(job.id);

    await expect(leadershipIdentity(leadershipUrl)).resolves.toMatchObject({
      releaseId: prior.releaseId,
      manifestHash: prior.manifestHash,
      generation: prior.generation + 2n,
    });
    await expect(
      studio.publicationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      state: "RESTORED",
      failureCode: "VERIFICATION_FAILED_RESTORED",
    });
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("waits for the runtime identity to converge after promotion", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher runtime convergence checkpoint.",
    );
    let healthCalls = 0;
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeVerification: { attempts: 3, intervalMs: 0 },
        runtimeIdentity: async () => {
          healthCalls += 1;
          if (healthCalls === 1)
            throw new Error("Leadership runtime is still loading.");
          if (healthCalls === 2)
            return {
              releaseId: prior.releaseId,
              manifestHash: prior.manifestHash,
            };
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
      },
      job.id,
      await claimTokenForJob(job.id),
    );
    const persisted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { receipt: true },
    });
    expect(healthCalls).toBe(3);
    expect(persisted.state).toBe("SUCCEEDED");
    expect(persisted.receipt?.observedRuntimeReleaseId).toBe(
      persisted.leadershipReleaseId,
    );
  });

  it("classifies content-health status, payload, and timeout failures without raw details", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("sensitive runtime body", {
          status: 503,
        })) as typeof fetch;
      let statusError: unknown;
      try {
        await runtimeIdentityFromHealth("https://runtime.invalid/health");
      } catch (error) {
        statusError = error;
      }
      expect(statusError).toMatchObject({
        name: "PublisherRuntimeHealthError",
        reason: "HTTP_STATUS",
        httpStatus: 503,
      });
      expect(String(statusError)).not.toMatch(/sensitive|runtime\.invalid/iu);

      globalThis.fetch = (async () =>
        new Response('{"not":"an identity"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      await expect(
        runtimeIdentityFromHealth("https://runtime.invalid/health"),
      ).rejects.toMatchObject({
        reason: "INVALID_RESPONSE",
        httpStatus: null,
      });

      globalThis.fetch = ((_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        })) as typeof fetch;
      await expect(
        runtimeIdentityFromHealth("https://runtime.invalid/health", {
          timeoutMs: 5,
        }),
      ).rejects.toMatchObject({
        reason: "UNAVAILABLE",
        httpStatus: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
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
        ...runtimeContractDependencies(),
        runtimeVerification: { attempts: 1, intervalMs: 0 },
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
      await claimTokenForJob(job.id),
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
    expect(persisted.failureCode).toBe("RUNTIME_IDENTITY_MISMATCH_RESTORED");
    await expect(
      studio.situationCheckout.count({
        where: { id: job.checkoutId, releasedAt: null },
      }),
    ).resolves.toBe(1);
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("persists safe HTTP health diagnostics and renews the lease for restoration probes", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher typed runtime-health failure checkpoint.",
    );
    const claim = await claimPublicationJob(studio);
    expect(claim?.id).toBe(job.id);
    let healthCalls = 0;
    const probeLeases: Date[] = [];
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeVerification: { attempts: 1, intervalMs: 0 },
        runtimeIdentity: async () => {
          healthCalls += 1;
          if (healthCalls === 1)
            throw new PublisherRuntimeHealthError("HTTP_STATUS", 503);
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
        onRuntimeIdentityProbe: async () => {
          const current = await studio.publicationJob.findUniqueOrThrow({
            where: { id: job.id },
            select: { claimToken: true, leaseExpiresAt: true },
          });
          expect(current.claimToken).toBe(claim?.claimToken);
          expect(current.leaseExpiresAt).not.toBeNull();
          probeLeases.push(current.leaseExpiresAt!);
        },
      },
      job.id,
      claim?.claimToken,
    );

    expect(healthCalls).toBe(2);
    expect(probeLeases).toHaveLength(2);
    for (const lease of probeLeases)
      expect(lease.getTime()).toBeGreaterThan(Date.now() + 170_000);

    const persisted = await studio.publicationJob.findUniqueOrThrow({
      where: { id: job.id },
      include: {
        attempts: { orderBy: { attempt: "desc" }, take: 1 },
        events: { orderBy: { sequence: "asc" } },
        receipt: true,
      },
    });
    expect(persisted).toMatchObject({
      state: "RESTORED",
      failureCode: "RUNTIME_HEALTH_UNAVAILABLE_RESTORED",
      receipt: null,
    });
    const failureDetail = {
      schemaVersion: "publication-failure-detail-v1",
      phase: "RUNTIME_IDENTITY",
      source: "LEADERSHIP_CONTENT_HEALTH",
      reason: "HTTP_STATUS",
      attempts: 1,
      lastHttpStatus: 503,
      lastObservedReleaseId: null,
      lastObservedManifestHash: null,
    };
    expect(persisted.events).toContainEqual(
      expect.objectContaining({
        kind: "RESTORE_STARTED",
        payload: expect.objectContaining({
          failureDetail: expect.objectContaining(failureDetail),
        }),
      }),
    );
    expect(persisted.attempts[0]?.reconciledState).toEqual(
      expect.objectContaining({
        failureCode: "RUNTIME_HEALTH_UNAVAILABLE",
        promoted: true,
        promotionStateUnverified: false,
        failureDetail: expect.objectContaining(failureDetail),
      }),
    );
    expect(JSON.stringify(persisted.attempts[0]?.reconciledState)).not.toMatch(
      /database|leadershipUrl|stack|secret/iu,
    );
    await expect(
      studio.situationCheckout.count({
        where: { id: job.checkoutId, releasedAt: null },
      }),
    ).resolves.toBe(1);
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("withholds success and restores after the affected route fails verification", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher affected-route verification checkpoint.",
    );
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeIdentity: async () => {
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
        runtimeRouteProof: async () => {
          throw new PublisherVerificationError(
            "The rendered situation did not expose the scoped practice.",
            "AFFECTED_ROUTE_VERIFICATION_FAILED",
          );
        },
      },
      job.id,
      await claimTokenForJob(job.id),
    );
    await expect(leadershipIdentity(leadershipUrl)).resolves.toMatchObject({
      releaseId: prior.releaseId,
      manifestHash: prior.manifestHash,
      generation: prior.generation + 2n,
    });
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { receipt: true },
      }),
    ).resolves.toMatchObject({
      state: "RESTORED",
      failureCode: "AFFECTED_ROUTE_VERIFICATION_FAILED_RESTORED",
      receipt: null,
    });
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("withholds a receipt when the Leadership deployment changes during route verification", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const job = await requestChangedPublication(
      "Publisher capability identity bracket checkpoint.",
    );
    const initialCapabilities = compatibleCapabilities();
    const { capabilityDigest: _digest, ...changedCapabilitySet } = {
      ...initialCapabilities,
      deployment: {
        ...initialCapabilities.deployment,
        commit: "c".repeat(40),
      },
    };
    const changedCapabilities = {
      ...changedCapabilitySet,
      capabilityDigest: sha256(canonicalJson(changedCapabilitySet)),
    };
    let capabilityCalls = 0;
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeCapabilities: async () => {
          capabilityCalls += 1;
          return capabilityCalls < 3
            ? initialCapabilities
            : changedCapabilities;
        },
        runtimeIdentity: async () => {
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
      },
      job.id,
      await claimTokenForJob(job.id),
    );
    expect(capabilityCalls).toBe(3);
    await expect(leadershipIdentity(leadershipUrl)).resolves.toMatchObject({
      releaseId: prior.releaseId,
      manifestHash: prior.manifestHash,
      generation: prior.generation + 2n,
    });
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        include: { receipt: true },
      }),
    ).resolves.toMatchObject({
      state: "RESTORED",
      failureCode: "RUNTIME_CAPABILITY_UNAVAILABLE_RESTORED",
      receipt: null,
    });
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("marks an immutable candidate stale instead of rebasing a pointer race", async () => {
    const job = await requestChangedPublication(
      "Publisher durable rebase checkpoint.",
    );
    const firstClaim = await claimPublicationJob(studio);
    expect(firstClaim?.id).toBe(job.id);
    if (!firstClaim) throw new Error("Test publication was not claimed.");
    let shifted = false;
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeIdentity: async () => {
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
        afterBoundary: async (boundary) => {
          if (shifted || boundary !== "CANDIDATE_PERSISTED") return;
          shifted = true;
          const client = new Client({ connectionString: leadershipUrl });
          await client.connect();
          try {
            await client.query(`
              UPDATE current_release
                 SET generation = generation + 1,
                     updated_at = now(),
                     reason = 'Publisher integration pointer race'
               WHERE id = 'official'
            `);
          } finally {
            await client.end();
          }
        },
      },
      job.id,
      firstClaim.claimToken,
    );
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
        select: {
          state: true,
          failureCode: true,
          claimToken: true,
          leaseExpiresAt: true,
          preflightReceiptId: true,
          candidateHash: true,
        },
      }),
    ).resolves.toEqual({
      state: "NEEDS_REFRESH",
      failureCode: "PREFLIGHT_BASE_CHANGED",
      claimToken: null,
      leaseExpiresAt: null,
      preflightReceiptId: job.preflightReceiptId,
      candidateHash: job.candidateHash,
    });
    await expect(claimPublicationJob(studio)).resolves.toBeNull();
    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await workflows.checkInSituation({
      actorId: user.id,
      checkoutId: job.checkoutId,
      fence: job.checkoutFence,
    });
  });

  it("reconciles an exact completed restoration and unblocks the queued retry", async () => {
    const prior = await leadershipIdentity(leadershipUrl);
    const recovery = await requestChangedPublication(
      "Publisher recovery reconciliation checkpoint.",
    );
    const failedRuntimeIdentities = [crypto.randomUUID(), crypto.randomUUID()];
    let failedRuntimeIdentityIndex = 0;
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeVerification: { attempts: 1, intervalMs: 0 },
        runtimeIdentity: async () => ({
          releaseId:
            failedRuntimeIdentities[failedRuntimeIdentityIndex++] ??
            crypto.randomUUID(),
          manifestHash: "f".repeat(64),
        }),
      },
      recovery.id,
      await claimTokenForJob(recovery.id),
    );
    const pendingRecovery = await studio.publicationJob.findUniqueOrThrow({
      where: { id: recovery.id },
      include: {
        attempts: { orderBy: { attempt: "desc" }, take: 1 },
        events: { orderBy: { sequence: "asc" } },
      },
    });
    expect(pendingRecovery.state).toBe("RECOVERY_REQUIRED");
    const recoveryRequiredEvent = pendingRecovery.events.find(
      (event) => event.kind === "RECOVERY_REQUIRED",
    );
    expect(recoveryRequiredEvent?.payload).toEqual(
      expect.objectContaining({
        failureDetail: expect.objectContaining({
          reason: "IDENTITY_MISMATCH",
          lastObservedReleaseId: failedRuntimeIdentities[0],
        }),
        recoveryFailureDetail: expect.objectContaining({
          reason: "IDENTITY_MISMATCH",
          lastObservedReleaseId: failedRuntimeIdentities[1],
        }),
      }),
    );
    expect(pendingRecovery.attempts[0]?.reconciledState).toEqual(
      expect.objectContaining({
        failureDetail: expect.objectContaining({
          lastObservedReleaseId: failedRuntimeIdentities[0],
        }),
        recoveryFailureDetail: expect.objectContaining({
          lastObservedReleaseId: failedRuntimeIdentities[1],
        }),
      }),
    );
    await expect(leadershipIdentity(leadershipUrl)).resolves.toMatchObject({
      releaseId: prior.releaseId,
      manifestHash: prior.manifestHash,
      generation: prior.generation + 2n,
    });

    const user = await studio.user.findUniqueOrThrow({
      where: { username: "publisher-test-editor" },
    });
    await expect(
      workflows.checkInSituation({
        actorId: user.id,
        checkoutId: recovery.checkoutId,
        fence: recovery.checkoutFence,
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_REQUIRED" });
    await expect(
      workflows.requestPublication({
        actorId: user.id,
        checkoutId: recovery.checkoutId,
        fence: recovery.checkoutFence,
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_REQUIRED" });
    const availableSituation = await studio.situation.findFirstOrThrow({
      where: {
        id: { not: recovery.situationId },
        checkouts: { none: { releasedAt: null } },
      },
    });
    await expect(
      workflows.checkoutSituation({
        actorId: user.id,
        situationId: availableSituation.id,
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_REQUIRED" });
    await expect(claimPublicationJob(studio)).resolves.toBeNull();

    await expect(
      reconcilePublicationRecovery({
        studio,
        leadershipPublisherUrl,
        ...runtimeContractDependencies(),
        runtimeVerification: { attempts: 1, intervalMs: 0 },
        runtimeIdentity: async () => {
          const identity = await leadershipIdentity(leadershipUrl);
          return {
            releaseId: identity.releaseId,
            manifestHash: identity.manifestHash,
          };
        },
      }),
    ).resolves.toBe(1);
    const reconciled = await studio.publicationJob.findUniqueOrThrow({
      where: { id: recovery.id },
      include: {
        events: { orderBy: { sequence: "asc" } },
      },
    });
    expect(reconciled.state).toBe("RESTORED");
    expect(reconciled.failureCode).toBe("VERIFICATION_FAILED_RESTORED");
    expect(reconciled.events.at(-1)).toMatchObject({
      kind: "RESTORED",
      payload: expect.objectContaining({
        reconciledAfterRuntimeConvergence: true,
      }),
    });

    const retry = await queueCurrentPublication({
      actorId: user.id,
      checkoutId: recovery.checkoutId,
      fence: recovery.checkoutFence,
    });
    const claim = await claimPublicationJob(studio);
    expect(claim?.id).toBe(retry.id);
    await processAgainstCurrentRuntime(retry.id, undefined, claim?.claimToken);
    await expect(
      studio.publicationJob.findUniqueOrThrow({
        where: { id: retry.id },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: "SUCCEEDED" });
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
