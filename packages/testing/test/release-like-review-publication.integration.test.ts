import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  candidateBuilderOutputSchema,
  normalizedOutputSchema,
  runDeterministic,
  type AdapterRequest,
  type AdapterResult,
} from "../../ai-adapters/src/index";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "@situation-studio/db";
import {
  bundleHash,
  canonicalText,
  legacySituationBundleSchema,
  sha256,
  situationBundleSchema,
} from "../../domain/src/index";
import {
  importLeadershipRelease,
  readOfficialLeadershipRelease,
  runtimeCapabilitiesFromHealth,
} from "@situation-studio/leadership-bridge";
import {
  claimPublicationJob,
  processPublicationJob,
  runtimeIdentityFromHealth,
  runtimeRouteProofFromVerificationEndpoint,
  type RuntimeRouteExpectation,
} from "../../../apps/publisher/src/index";
import {
  claimNextReview,
  processClaimedReview,
} from "../../../apps/review-worker/src/review";

const executeFile = promisify(execFile);
const studioRoot = path.resolve(import.meta.dirname, "../../..");
const leadershipRoot =
  process.env.LEADERSHIP_TEST_ROOT ?? path.resolve(studioRoot, "../leadership");
const importedLeadershipCommit = "0d7d161";
const fixtureSlug = "repeatedly-misses-deadlines";
const changedShortAnswer =
  "Name the dated commitments and their downstream effects, ask what is driving the pattern, and agree on one earlier risk signal plus the next observable commitment.";

const studioEnvironmentKeys = [
  "STUDIO_DATABASE_URL",
  "SESSION_SECRET",
  "CSRF_SECRET",
  "THROTTLE_SECRET",
  "SITUATION_STUDIO_ORIGIN",
  "LEADERSHIP_STUDIO_READER_DATABASE_URL",
  "LEADERSHIP_RUNTIME_CAPABILITIES_URL",
] as const;

type ManagedRuntime = {
  child: ChildProcess;
  output: () => string;
  startupError: () => Error | undefined;
};

type RuntimeSituation = {
  frontmatter: { slug: string };
  body: string;
};

type RuntimeVerificationProof = {
  schemaVersion: "affected-route-proof-json-v1";
  slug: string;
  releaseId: string;
  manifestHash: string;
  pointerGeneration: string;
  visibility: "PUBLIC" | "RETIRED";
  situationBodyHash: string;
};

function databaseUrl(container: StartedPostgreSqlContainer) {
  return container
    .getConnectionUri()
    .replace(/^postgres:\/\//u, "postgresql://");
}

function errorOutput(error: unknown) {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as {
    message?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return [candidate.message, candidate.stdout, candidate.stderr]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .join("\n");
}

async function command(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) {
  try {
    const result = await executeFile("pnpm", args, {
      cwd,
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    throw new Error(`pnpm ${args.join(" ")} failed.\n${errorOutput(error)}`, {
      cause: error,
    });
  }
}

async function gitIdentity(root: string) {
  const result = await executeFile("git", ["rev-parse", "HEAD"], {
    cwd: root,
    maxBuffer: 1024 * 1024,
  });
  const commit = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(commit))
    throw new Error(`Repository ${root} has no immutable Git identity.`);
  return commit;
}

async function sourceTreeDigest(root: string) {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix = "") => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (
        [
          ".git",
          ".next",
          "node_modules",
          "cache",
          ".release-commit",
          ".release-archive-sha256",
        ].includes(entry.name)
      )
        continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        hash.update(relative);
        hash.update("\0");
        hash.update(await readFile(absolute));
        hash.update("\0");
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function prepareLeadershipRelease(releaseRoot: string) {
  const excluded = new Set([
    ".DS_Store",
    ".git",
    ".next",
    "node_modules",
    "playwright-report",
    "test-results",
    "tsconfig.tsbuildinfo",
  ]);
  const entries = await readdir(leadershipRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (excluded.has(entry.name)) continue;
    await cp(
      path.join(leadershipRoot, entry.name),
      path.join(releaseRoot, entry.name),
      { recursive: entry.isDirectory() },
    );
  }
  const [commit, archiveDigest] = await Promise.all([
    gitIdentity(leadershipRoot),
    sourceTreeDigest(releaseRoot),
  ]);
  await Promise.all([
    symlink(
      path.join(leadershipRoot, "node_modules"),
      path.join(releaseRoot, "node_modules"),
      "dir",
    ),
    writeFile(path.join(releaseRoot, ".release-commit"), `${commit}\n`),
    writeFile(
      path.join(releaseRoot, ".release-archive-sha256"),
      `${archiveDigest}\n`,
    ),
  ]);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local Leadership runtime port.");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function startLeadershipRuntime(
  releaseRoot: string,
  port: number,
  environment: NodeJS.ProcessEnv,
): ManagedRuntime {
  const nextBinary = path.join(
    leadershipRoot,
    "node_modules/next/dist/bin/next",
  );
  const child = spawn(
    process.execPath,
    [nextBinary, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: releaseRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let startupError: Error | undefined;
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
  };
  child.once("error", (error) => {
    startupError = error;
  });
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return {
    child,
    output: () => output,
    startupError: () => startupError,
  };
}

async function stopLeadershipRuntime(runtime: ManagedRuntime | undefined) {
  if (
    !runtime ||
    runtime.child.exitCode !== null ||
    runtime.child.signalCode !== null
  )
    return;
  runtime.child.kill("SIGTERM");
  await Promise.race([
    once(runtime.child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill("SIGKILL");
    await Promise.race([
      once(runtime.child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

async function waitForRuntime(
  runtime: ManagedRuntime,
  url: string,
  accept: (body: unknown) => boolean,
) {
  let lastFailure = "no response";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const startupError = runtime.startupError();
    if (startupError)
      throw new Error(
        `Leadership runtime could not start: ${startupError.message}.`,
        { cause: startupError },
      );
    if (runtime.child.exitCode !== null)
      throw new Error(
        `Leadership runtime exited with ${runtime.child.exitCode}.\n${runtime.output()}`,
      );
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "cache-control": "no-cache" },
        cache: "no-store",
        signal: AbortSignal.timeout(2_000),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && accept(body)) return body;
      lastFailure = `HTTP ${response.status}: ${JSON.stringify(body)}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Leadership runtime did not become ready: ${lastFailure}.\n${runtime.output()}`,
  );
}

async function deterministicReviewStage(
  request: Omit<AdapterRequest, "provider" | "model">,
): Promise<AdapterResult> {
  const base = await runDeterministic({
    ...request,
    provider: "deterministic",
    model: "deterministic-provider-v1",
  });
  const output =
    request.role === "critical-review"
      ? normalizedOutputSchema.parse({
          role: "critical-review",
          summary: "One bounded, actionable reliability finding.",
          findings: [
            {
              id: "name-observable-commitments",
              severity: "important",
              targetKind: "SECTION",
              targetKey: "The short answer",
              summary: "Name the observable commitments and effects.",
              rationale:
                "Dated observations and an explicit next signal make the conversation fair and actionable.",
              evidenceRoleCodes: ["critic-nvc", "critic-manager-tools"],
            },
          ],
          provenance: "release-like-deterministic-review",
        })
      : request.role === "candidate-builder"
        ? candidateBuilderOutputSchema.parse({
            role: "candidate-builder",
            summary: "One minimal safe section replacement.",
            findings: [],
            provenance: "release-like-deterministic-review",
            changeIntents: [
              {
                targetKind: "SECTION",
                targetKey: "The short answer",
                afterBody: changedShortAnswer,
                problem:
                  "The opening should make the reliability concern directly observable.",
                explanation:
                  "Names the dated evidence, downstream effects, inquiry, and next commitment.",
                rationale:
                  "The bounded replacement addresses the retained finding without changing managed components or unrelated guidance.",
                upstreamFindingIds: [
                  "critical-review:name-observable-commitments",
                ],
                evidenceRoleCodes: ["critic-nvc", "critic-manager-tools"],
              },
            ],
          })
        : base.output;
  return {
    ...base,
    output,
    outputHash: sha256(JSON.stringify(output)),
  };
}

describe("release-like review to verified Leadership publication", () => {
  let studioContainer: StartedPostgreSqlContainer | undefined;
  let leadershipContainer: StartedPostgreSqlContainer | undefined;
  let studio: DatabaseClient | undefined;
  let workflowDatabase: DatabaseClient | undefined;
  let leadershipReleaseRoot: string | undefined;
  let leadershipRuntime: ManagedRuntime | undefined;
  let leadershipUrl: string;
  let leadershipReaderUrl: string;
  let leadershipPublisherUrl: string;
  let leadershipOrigin: string;
  let leadershipHealthUrl: string;
  let leadershipCapabilitiesUrl: string;
  let editorId: string;
  let workflows: typeof import("../../../apps/web/src/server/workflows/situations");
  let studioCommit: string;
  const priorEnvironment = new Map<string, string | undefined>();

  beforeAll(async () => {
    for (const key of studioEnvironmentKeys)
      priorEnvironment.set(key, process.env[key]);
    leadershipReleaseRoot = await mkdtemp(
      path.join(os.tmpdir(), "situation-studio-leadership-release-"),
    );
    [studioContainer, leadershipContainer] = await Promise.all([
      new PostgreSqlContainer("postgres:16.12-bookworm")
        .withDatabase("situation_studio_release_like")
        .withUsername("studio_release_test_owner")
        .withPassword("studio_release_test_password")
        .start(),
      new PostgreSqlContainer("postgres:16.12-bookworm")
        .withDatabase("leadership_field_guide")
        .withUsername("leadership_release_test_owner")
        .withPassword("leadership_release_test_password")
        .start(),
    ]);
    const studioUrl = databaseUrl(studioContainer);
    leadershipUrl = databaseUrl(leadershipContainer);
    await Promise.all([
      command(studioRoot, ["db:migrate:deploy"], {
        ...process.env,
        STUDIO_DATABASE_URL: studioUrl,
      }),
      command(leadershipRoot, ["db:migrate:deploy"], {
        ...process.env,
        DATABASE_URL: leadershipUrl,
      }),
      prepareLeadershipRelease(leadershipReleaseRoot),
      gitIdentity(studioRoot).then((commit) => {
        studioCommit = commit;
      }),
    ]);
    await command(
      leadershipRoot,
      [
        "content:database:import",
        "--",
        "--git-ref",
        importedLeadershipCommit,
        "--official",
      ],
      { ...process.env, DATABASE_URL: leadershipUrl },
    );

    const readerPassword = "release-like-reader-password-long-enough";
    const publisherPassword = "release-like-publisher-password-long-enough";
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
        maxBuffer: 4 * 1024 * 1024,
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
      { env: process.env, maxBuffer: 4 * 1024 * 1024 },
    );
    const readerUrl = new URL(leadershipUrl);
    readerUrl.username = "situation_studio_leadership_reader";
    readerUrl.password = readerPassword;
    leadershipReaderUrl = readerUrl.toString();
    const publisherUrl = new URL(leadershipUrl);
    publisherUrl.username = "situation_studio_leadership_publisher";
    publisherUrl.password = publisherPassword;
    leadershipPublisherUrl = publisherUrl.toString();

    const port = await availablePort();
    leadershipOrigin = `http://127.0.0.1:${port}`;
    leadershipHealthUrl = `${leadershipOrigin}/health/content`;
    leadershipCapabilitiesUrl = `${leadershipOrigin}/health/capabilities`;
    const leadershipEnvironment = {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: leadershipUrl,
      LEADERSHIP_FIELD_GUIDE_DATABASE_URL: leadershipReaderUrl,
      LEADERSHIP_CONTENT_CACHE_ROOT: path.join(leadershipReleaseRoot, "cache"),
      LEADERSHIP_CONTENT_TARGET: "release-like-integration",
      LEADERSHIP_CONTENT_REFRESH_MS: "100",
      LEADERSHIP_RELEASE_ID: "release-like-integration",
      NEXT_PUBLIC_SITE_URL: leadershipOrigin,
    };

    studio = createDatabaseClient(studioUrl, 6);
    const snapshot = await readOfficialLeadershipRelease(leadershipReaderUrl);
    await Promise.all([
      importLeadershipRelease(studio, snapshot, "BOOTSTRAP_IMPORT"),
      (async () => {
        await command(leadershipRoot, ["build"], leadershipEnvironment);
        await cp(
          path.join(leadershipRoot, ".next"),
          path.join(leadershipReleaseRoot, ".next"),
          { recursive: true },
        );
      })(),
    ]);
    leadershipRuntime = startLeadershipRuntime(
      leadershipReleaseRoot,
      port,
      leadershipEnvironment,
    );
    await waitForRuntime(leadershipRuntime, leadershipHealthUrl, (body) =>
      Boolean(
        body &&
        typeof body === "object" &&
        (body as { status?: unknown }).status === "healthy",
      ),
    );
    await waitForRuntime(leadershipRuntime, leadershipCapabilitiesUrl, (body) =>
      Boolean(
        body &&
        typeof body === "object" &&
        (body as { schemaVersion?: unknown }).schemaVersion ===
          "leadership-studio-capabilities-v1",
      ),
    );
    await runtimeCapabilitiesFromHealth(leadershipCapabilitiesUrl);

    Object.assign(process.env, {
      STUDIO_DATABASE_URL: studioUrl,
      SESSION_SECRET: "s".repeat(32),
      CSRF_SECRET: "c".repeat(32),
      THROTTLE_SECRET: "t".repeat(32),
      SITUATION_STUDIO_ORIGIN: "http://127.0.0.1:3015",
      LEADERSHIP_STUDIO_READER_DATABASE_URL: leadershipReaderUrl,
      LEADERSHIP_RUNTIME_CAPABILITIES_URL: leadershipCapabilitiesUrl,
    });
    workflows =
      await import("../../../apps/web/src/server/workflows/situations");
    workflowDatabase = (
      await import("../../../apps/web/src/server/database")
    ).database();
    const editor = await studio.user.create({
      data: {
        username: "release-like-editor",
        displayName: "Release-like editor",
        passwordHash: "not-used-by-release-like-integration",
        roles: { create: [{ role: "EDITOR" }, { role: "ADMIN" }] },
      },
    });
    editorId = editor.id;
  }, 300_000);

  afterAll(async () => {
    await stopLeadershipRuntime(leadershipRuntime).catch(() => undefined);
    await Promise.allSettled([
      workflowDatabase?.$disconnect(),
      studio?.$disconnect(),
    ]);
    await Promise.allSettled([
      studioContainer?.stop(),
      leadershipContainer?.stop(),
    ]);
    if (leadershipReleaseRoot)
      await rm(leadershipReleaseRoot, { recursive: true, force: true });
    for (const key of studioEnvironmentKeys) {
      const prior = priorEnvironment.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  }, 60_000);

  it("synchronizes a clean retained v1 draft before review and rejects direct legacy ingress", async () => {
    if (!studio) throw new Error("Studio integration database is unavailable.");
    const situation = await studio.situation.findFirstOrThrow({
      where: {
        slug: { not: fixtureSlug },
        visibility: "PUBLIC",
        productionReleaseId: { not: null },
        checkouts: { none: { releasedAt: null } },
      },
      orderBy: { slug: "asc" },
    });
    const checkout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: editorId,
    });
    const retained = await studio.draftRevision.findFirstOrThrow({
      where: { draftId: checkout.draftId },
      orderBy: { revision: "desc" },
      include: {
        artifacts: {
          where: { kind: "SITUATION" },
          include: { content: true },
        },
      },
    });
    const body = retained.artifacts[0]?.content.textBody;
    if (!body) throw new Error("Legacy synchronization body is unavailable.");
    const currentBundle = situationBundleSchema.parse(retained.bundleManifest);
    if (currentBundle.schemaVersion !== "situation-bundle-v2")
      throw new Error("Legacy synchronization fixture did not start on v2.");
    const legacyBundle = legacySituationBundleSchema.parse({
      ...currentBundle,
      schemaVersion: "situation-bundle-v1",
      promotion: currentBundle.promotion ?? {},
    });
    const legacyBundleHash = bundleHash(legacyBundle);

    // Reproduce the immutable current row left by the prior release. The
    // workflow must append a validated v2 checkpoint rather than rewrite it.
    await studio.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        "SET LOCAL session_replication_role = replica",
      );
      await transaction.$executeRaw`
        UPDATE draft_revisions
           SET bundle_manifest = ${JSON.stringify(legacyBundle)}::jsonb,
               bundle_hash = ${legacyBundleHash},
               contract_version = ${legacyBundle.contractVersion},
               validation_policy = ${legacyBundle.validationPolicyVersion}
         WHERE id = ${retained.id}::uuid
      `;
      await transaction.$executeRaw`
        UPDATE drafts
           SET current_bundle_hash = ${legacyBundleHash}
         WHERE id = ${checkout.draftId}::uuid
      `;
    });

    await expect(
      workflows.queueReview({
        actorId: editorId,
        checkoutId: checkout.id,
        fence: checkout.fence,
        revisionId: retained.id,
        bundleHash: legacyBundleHash,
      }),
    ).rejects.toMatchObject({ code: "LEGACY_DRAFT_REQUIRES_SYNC" });
    await expect(
      studio.reviewJob.count({ where: { inputRevisionId: retained.id } }),
    ).resolves.toBe(0);

    const synchronized = await workflows.saveDraft({
      actorId: editorId,
      checkoutId: checkout.id,
      fence: checkout.fence,
      expectedParentRevisionId: retained.id,
      expectedParentBundleHash: legacyBundleHash,
      bundle: legacyBundle,
      body,
      namedCheckpoint: "Action checkpoint before review",
    });
    expect(synchronized.id).not.toBe(retained.id);
    expect(synchronized.parentId).toBe(retained.id);
    expect(
      situationBundleSchema.parse(synchronized.bundleManifest).schemaVersion,
    ).toBe("situation-bundle-v2");
    await expect(
      studio.auditEvent.count({
        where: {
          action: "LEGACY_DRAFT_SYNCHRONIZED",
          subjectId: synchronized.id,
        },
      }),
    ).resolves.toBe(1);

    const queued = await workflows.queueReview({
      actorId: editorId,
      checkoutId: checkout.id,
      fence: checkout.fence,
      revisionId: synchronized.id,
      bundleHash: synchronized.bundleHash,
    });
    expect(queued).toMatchObject({
      inputRevisionId: synchronized.id,
      inputBundleHash: synchronized.bundleHash,
    });
    await workflows.cancelReview({
      actorId: editorId,
      jobId: queued.id,
      revisionId: synchronized.id,
      bundleHash: synchronized.bundleHash,
      reason: "Legacy review ingress regression cleanup",
    });
    await workflows.checkInSituation({
      actorId: editorId,
      checkoutId: checkout.id,
      fence: checkout.fence,
    });
  }, 60_000);

  it("preserves exact review, revision, sealed candidate, publisher, and runtime identities", async () => {
    if (!studio) throw new Error("Studio integration database is unavailable.");
    const situation = await studio.situation.findUniqueOrThrow({
      where: { slug: fixtureSlug },
    });
    const checkout = await workflows.checkoutSituation({
      situationId: situation.id,
      actorId: editorId,
    });
    const workspace = await workflows.workspaceForSlug(fixtureSlug);
    const inputRevision = workspace?.drafts[0]?.revisions[0];
    if (!inputRevision)
      throw new Error("Release-like review input revision is unavailable.");

    const reviewJob = await workflows.queueReview({
      actorId: editorId,
      checkoutId: checkout.id,
      fence: checkout.fence,
      revisionId: inputRevision.id,
      bundleHash: inputRevision.bundleHash,
    });
    const reviewClaim = await claimNextReview(studio);
    expect(reviewClaim?.id).toBe(reviewJob.id);
    if (!reviewClaim?.claimToken)
      throw new Error("Release-like review did not receive a claim token.");
    const observedStages: string[] = [];
    await processClaimedReview(
      studio,
      reviewJob.id,
      { mode: "deterministic" },
      reviewClaim.claimToken,
      {
        runStage: async (request) => {
          observedStages.push(request.role);
          return deterministicReviewStage(request);
        },
      },
    );
    expect(observedStages).toEqual([
      "context-mapper",
      "critical-review",
      "candidate-builder",
      "candidate-audit",
    ]);

    const reviewed = await studio.reviewJob.findUniqueOrThrow({
      where: { id: reviewJob.id },
      include: {
        proposal: { include: { candidate: true, changes: true } },
      },
    });
    expect(reviewed.state).toBe("SUCCEEDED");
    const proposal = reviewed.proposal;
    const reviewCandidate = proposal?.candidate;
    const proposalChange = proposal?.changes[0];
    if (!proposal || !reviewCandidate || !proposalChange)
      throw new Error("Review did not materialize its candidate proposal.");
    expect(proposal.changes).toHaveLength(1);
    expect(proposalChange).toMatchObject({
      targetKind: "SECTION",
      targetKey: "The short answer",
      applicationMode: "AUTOMATIC",
      state: "PENDING",
    });
    const reviewCandidateBodyHash = sha256(canonicalText(reviewCandidate.body));
    expect(reviewCandidate.bodyHash).toBe(reviewCandidateBodyHash);

    const accepted = await workflows.decideProposalChange({
      actorId: editorId,
      checkoutId: checkout.id,
      fence: checkout.fence,
      changeId: proposalChange.id,
      decision: "ACCEPT",
      revisionId: proposal.currentRevisionId,
      bundleHash: proposal.currentBundleHash,
    });
    const acceptedRevision = await studio.draftRevision.findUniqueOrThrow({
      where: { id: accepted.authoritativeRevision.revisionId },
      include: {
        artifacts: {
          where: { kind: "SITUATION" },
          include: { content: true },
        },
      },
    });
    const acceptedBody = acceptedRevision.artifacts[0]?.content.textBody;
    if (!acceptedBody)
      throw new Error("Accepted authoritative body is unavailable.");
    const acceptedBodyHash = sha256(canonicalText(acceptedBody));
    expect(canonicalText(acceptedBody)).toBe(
      canonicalText(reviewCandidate.body),
    );
    expect(acceptedBodyHash).toBe(reviewCandidateBodyHash);

    const preflight = await workflows.preflightPublication({
      actorId: editorId,
      checkoutId: checkout.id,
      fence: checkout.fence,
      revisionId: acceptedRevision.id,
      bundleHash: acceptedRevision.bundleHash,
    });
    expect(preflight.candidatePreview.bodyMdxHash).toBe(acceptedBodyHash);
    expect(sha256(canonicalText(preflight.candidatePreview.bodyMdx))).toBe(
      acceptedBodyHash,
    );
    const sealedReceipt =
      await studio.publicationPreflightReceipt.findUniqueOrThrow({
        where: { id: preflight.id },
        include: { artifacts: { orderBy: { position: "asc" } } },
      });
    expect(sealedReceipt.sealedAt).toBeInstanceOf(Date);
    const sealedSituationArtifact = sealedReceipt.artifacts.find(
      (artifact) => artifact.logicalId === `situation:${fixtureSlug}`,
    );
    if (!sealedSituationArtifact)
      throw new Error("Sealed situation artifact is unavailable.");
    expect(sha256(Uint8Array.from(sealedSituationArtifact.bytes))).toBe(
      sealedSituationArtifact.contentHash,
    );
    expect(sealedSituationArtifact.contentHash).toBe(
      preflight.situationArtifactHash,
    );

    const backupCreatedAt = new Date(Date.now() - 2_000);
    const backupVerifiedAt = new Date(backupCreatedAt.getTime() + 500);
    const restoreDrillAt = new Date(backupVerifiedAt.getTime() + 500);
    await studio.backupReceipt.create({
      data: {
        id: "00000000-0000-4000-8000-000000000027",
        state: "VERIFIED",
        destinationId: `offsite-verified:${"e".repeat(64)}`,
        objectKey: "release-like-integration.dump.gpg",
        checksum: "b".repeat(64),
        encrypted: true,
        byteLength: 4_096n,
        createdAt: backupCreatedAt,
        verifiedAt: backupVerifiedAt,
        restoreDrillAt,
        restoreDrillResult: "PASSED",
      },
    });
    const publicationJob = await workflows.requestPublication({
      actorId: editorId,
      checkoutId: checkout.id,
      fence: checkout.fence,
      revisionId: acceptedRevision.id,
      bundleHash: acceptedRevision.bundleHash,
      preflightReceiptId: preflight.id,
      candidateHash: preflight.candidateHash,
    });
    expect(publicationJob.candidateHash).toBe(preflight.candidateHash);
    expect(publicationJob.preflightReceiptId).toBe(preflight.id);
    const publicationClaim = await claimPublicationJob(studio);
    expect(publicationClaim?.id).toBe(publicationJob.id);
    if (!publicationClaim?.claimToken)
      throw new Error("Release-like publication did not receive a claim.");
    const publisherFailures: unknown[] = [];
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        runtimeIdentity: () => runtimeIdentityFromHealth(leadershipHealthUrl),
        runtimeCapabilities: () =>
          runtimeCapabilitiesFromHealth(leadershipCapabilitiesUrl),
        runtimeRouteProof: (expected: RuntimeRouteExpectation) =>
          runtimeRouteProofFromVerificationEndpoint(
            leadershipHealthUrl,
            expected,
          ),
        runtimeVerification: { attempts: 100, intervalMs: 100 },
        producerCommit: studioCommit,
        onFailure: (error) => publisherFailures.push(error),
      },
      publicationJob.id,
      publicationClaim.claimToken,
    );
    expect(publisherFailures).toEqual([]);

    const completed = await studio.publicationJob.findUniqueOrThrow({
      where: { id: publicationJob.id },
      include: {
        candidateSnapshot: true,
        preflightReceipt: true,
        receipt: true,
        targetRevision: {
          include: {
            artifacts: {
              where: { kind: "SITUATION" },
              include: { content: true },
            },
          },
        },
      },
    });
    expect(completed.state).toBe("SUCCEEDED");
    expect(completed.candidateSnapshot).not.toBeNull();
    expect(completed.receipt).not.toBeNull();
    const candidateSnapshot = completed.candidateSnapshot;
    const verificationReceipt = completed.receipt;
    if (!candidateSnapshot || !verificationReceipt)
      throw new Error("Publisher identity evidence is incomplete.");
    const snapshotAssembly = candidateSnapshot.assembly as Record<
      string,
      unknown
    >;
    expect(snapshotAssembly).toMatchObject({
      schemaVersion: "sealed-preflight-candidate-snapshot-v1",
      preflightReceiptId: preflight.id,
      candidateHash: preflight.candidateHash,
      bodyMdxHash: acceptedBodyHash,
      situationArtifactHash: preflight.situationArtifactHash,
    });
    expect(completed.candidateHash).toBe(preflight.candidateHash);
    expect(completed.preflightReceipt?.candidateHash).toBe(
      preflight.candidateHash,
    );
    expect(candidateSnapshot.manifestHash).toBe(preflight.manifestHash);
    expect(completed.leadershipManifestHash).toBe(preflight.manifestHash);
    expect(verificationReceipt.expectedManifestHash).toBe(
      preflight.manifestHash,
    );
    expect(verificationReceipt.observedDatabaseHash).toBe(
      preflight.manifestHash,
    );
    expect(verificationReceipt.observedRuntimeHash).toBe(
      preflight.manifestHash,
    );
    expect(verificationReceipt.observedRouteManifestHash).toBe(
      preflight.manifestHash,
    );
    expect(candidateSnapshot.releaseId).toBe(preflight.releaseId);
    expect(completed.leadershipReleaseId).toBe(preflight.releaseId);
    expect(verificationReceipt.expectedReleaseId).toBe(preflight.releaseId);
    expect(verificationReceipt.observedRuntimeReleaseId).toBe(
      preflight.releaseId,
    );

    const [runtimeSituationResponse, runtimeProofResponse] = await Promise.all([
      fetch(`${leadershipOrigin}/api/v1/situations/${fixtureSlug}`, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      }),
      fetch(`${leadershipOrigin}/api/v1/verification/${fixtureSlug}`, {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
      }),
    ]);
    expect(runtimeSituationResponse.status).toBe(200);
    expect(runtimeProofResponse.status).toBe(200);
    expect(runtimeProofResponse.headers.get("cache-control")).toContain(
      "no-store",
    );
    const runtimeSituation =
      (await runtimeSituationResponse.json()) as RuntimeSituation;
    const runtimeProof =
      (await runtimeProofResponse.json()) as RuntimeVerificationProof;
    const runtimeBodyHash = sha256(canonicalText(runtimeSituation.body));
    expect(runtimeSituation.frontmatter.slug).toBe(fixtureSlug);
    expect(runtimeBodyHash).toBe(acceptedBodyHash);
    expect(runtimeBodyHash).toBe(reviewCandidateBodyHash);
    expect(runtimeProof).toMatchObject({
      schemaVersion: "affected-route-proof-json-v1",
      slug: fixtureSlug,
      releaseId: preflight.releaseId,
      manifestHash: preflight.manifestHash,
      situationBodyHash: preflight.situationArtifactHash,
    });
    expect(verificationReceipt.observedSituationBodyHash).toBe(
      runtimeProof.situationBodyHash,
    );
    expect(completed.targetRevision.artifacts[0]?.content.textBody).toBe(
      acceptedBody,
    );
  }, 180_000);
});
