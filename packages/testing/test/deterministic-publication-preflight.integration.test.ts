import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const studioRoot = path.resolve(import.meta.dirname, "../../..");
const migrationsRoot = path.join(studioRoot, "packages/db/prisma/migrations");
const targetMigration = "20260802120000_deterministic_publication_preflight";

type RevisionFixture = {
  id: string;
  bundleHash: string;
  revision: number;
};

type WorkspaceFixture = {
  situationId: string;
  draftId: string;
  checkoutId: string;
  checkoutFence: bigint;
  revisions: RevisionFixture[];
};

type ReceiptFixture = {
  id: string;
  publicationId: string;
  releaseId: string;
  candidateHash: string;
  baseReleaseId: string;
  expectedPointerGeneration: bigint;
  revision: RevisionFixture;
};

function digest(seed: string | Buffer) {
  return createHash("sha256").update(seed).digest("hex");
}

function databaseUrl(container: StartedPostgreSqlContainer, database: string) {
  const url = new URL(
    container.getConnectionUri().replace(/^postgres:\/\//u, "postgresql://"),
  );
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function createDatabase(adminUrl: string, database: string) {
  if (!/^[a-z][a-z0-9_]+$/u.test(database))
    throw new Error(`Unsafe fixture database name ${database}.`);
  const client = await connect(adminUrl);
  try {
    await client.query(`CREATE DATABASE "${database}"`);
  } finally {
    await client.end();
  }
}

async function applyMigrationsBeforeTarget(url: string) {
  const client = await connect(url);
  try {
    const entries = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^\d+_/u.test(entry.name) &&
          entry.name < targetMigration,
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sql = await readFile(
        path.join(migrationsRoot, entry.name, "migration.sql"),
        "utf8",
      );
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

async function applyTargetMigration(url: string) {
  const client = await connect(url);
  try {
    const sql = await readFile(
      path.join(migrationsRoot, targetMigration, "migration.sql"),
      "utf8",
    );
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function insertUser(client: Client, username: string) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO users (
       id, username, display_name, password_hash, updated_at
     ) VALUES ($1, $2, $3, 'not-used', now())`,
    [id, username, `Fixture ${username}`],
  );
  return id;
}

async function insertWorkspace(
  client: Client,
  input: {
    actorId: string;
    slug: string;
    revisionCount: number;
    currentRevision?: number;
  },
): Promise<WorkspaceFixture> {
  const situationId = randomUUID();
  const draftId = randomUUID();
  const checkoutId = randomUUID();
  const checkoutFence = 1n;
  await client.query(
    `INSERT INTO situations (
       id, slug, title, visibility, fence, updated_at
     ) VALUES ($1, $2, $3, 'PUBLIC', $4, now())`,
    [situationId, input.slug, `Fixture ${input.slug}`, checkoutFence],
  );
  await client.query(
    `INSERT INTO drafts (
       id, situation_id, lineage, state, current_revision_number,
       current_bundle_hash, updated_at
     ) VALUES ($1, $2, 1, 'ACTIVE', 0, NULL, now())`,
    [draftId, situationId],
  );
  const revisions: RevisionFixture[] = [];
  let parentId: string | null = null;
  for (let revision = 1; revision <= input.revisionCount; revision += 1) {
    const id = randomUUID();
    const bundleHash = digest(`${input.slug}:bundle:${revision}`);
    await client.query(
      `INSERT INTO draft_revisions (
         id, draft_id, revision, parent_id, bundle_hash, bundle_manifest,
         contract_version, validation_policy, actor_id, named_checkpoint
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'fixture-contract',
                 'fixture-policy', $7, $8)`,
      [
        id,
        draftId,
        revision,
        parentId,
        bundleHash,
        JSON.stringify({ slug: input.slug, revision }),
        input.actorId,
        `Fixture revision ${revision}`,
      ],
    );
    revisions.push({ id, bundleHash, revision });
    parentId = id;
  }
  const selected =
    revisions[(input.currentRevision ?? input.revisionCount) - 1];
  if (!selected) throw new Error("Fixture current revision is unavailable.");
  await client.query(
    `UPDATE drafts
        SET current_revision_number = $2,
            current_bundle_hash = $3,
            updated_at = now()
      WHERE id = $1`,
    [draftId, selected.revision, selected.bundleHash],
  );
  await client.query(
    `INSERT INTO situation_checkouts (
       id, situation_id, holder_id, draft_id, fence
     ) VALUES ($1, $2, $3, $4, $5)`,
    [checkoutId, situationId, input.actorId, draftId, checkoutFence],
  );
  return {
    situationId,
    draftId,
    checkoutId,
    checkoutFence,
    revisions,
  };
}

async function insertOldReviewJob(
  client: Client,
  workspace: WorkspaceFixture,
  revision: RevisionFixture,
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO review_jobs (
       id, situation_id, input_revision_id, checkout_id, checkout_fence,
       state, context_hash, contract_version, policy_version
     ) VALUES ($1, $2, $3, $4, $5, 'SUCCEEDED', $6,
               'fixture-contract', 'fixture-policy')`,
    [
      id,
      workspace.situationId,
      revision.id,
      workspace.checkoutId,
      workspace.checkoutFence,
      digest(`${id}:context`),
    ],
  );
  return id;
}

async function insertOldProposal(
  client: Client,
  input: { jobId: string; inputRevisionId: string; seed: string },
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO review_proposals (
       id, job_id, input_revision_id, summary, findings, proposal_hash
     ) VALUES ($1, $2, $3, $4, '[]'::jsonb, $5)`,
    [
      id,
      input.jobId,
      input.inputRevisionId,
      `Fixture proposal ${input.seed}`,
      digest(`${input.seed}:proposal`),
    ],
  );
  return id;
}

async function insertProposalChange(
  client: Client,
  input: {
    proposalId: string;
    seed: string;
    state?: "PENDING" | "ACCEPTED";
    appliedRevisionId?: string;
  },
) {
  const id = randomUUID();
  const afterBody = `Replacement ${input.seed}\n`;
  await client.query(
    `INSERT INTO proposal_changes (
       id, proposal_id, position, target_kind, target_key, before_hash,
       after_body, after_hash, rationale, state, decided_at,
       applied_revision_id
     ) VALUES ($1, $2, 0, 'SECTION', 'The short answer', $3, $4, $5,
               'Fixture rationale', $6::"ProposalChangeState",
               CASE WHEN $6::"ProposalChangeState" = 'ACCEPTED'
                    THEN now() ELSE NULL END,
               $7)`,
    [
      id,
      input.proposalId,
      digest(`${input.seed}:before`),
      afterBody,
      digest(afterBody),
      input.state ?? "PENDING",
      input.appliedRevisionId ?? null,
    ],
  );
  return id;
}

async function insertLegacyPublicationJob(
  client: Client,
  workspace: WorkspaceFixture,
  state: "REQUESTED" | "PROMOTING",
) {
  const revision = workspace.revisions.at(-1);
  if (!revision) throw new Error("Publication fixture revision is missing.");
  const id = randomUUID();
  const publicationId = randomUUID();
  await client.query(
    `INSERT INTO publication_jobs (
       id, publication_id, situation_id, target_revision_id, checkout_id,
       checkout_fence, source_kind, state, target_bundle_hash,
       expected_pointer_generation, observed_release_id, previous_release_id,
       started_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', $7, $8, 7, $9, $9,
               now())`,
    [
      id,
      publicationId,
      workspace.situationId,
      revision.id,
      workspace.checkoutId,
      workspace.checkoutFence,
      state,
      revision.bundleHash,
      randomUUID(),
    ],
  );
  if (state === "PROMOTING")
    await client.query(
      `INSERT INTO publication_candidate_snapshots (
         id, job_id, release_id, parent_release_id,
         expected_pointer_generation, manifest_hash, manifest_body,
         artifact_count, edge_count, total_byte_length, assembly
       ) VALUES ($1, $2, $3, $4, 7, $5, '{}', 1, 0, 3, $6::jsonb)`,
      [
        randomUUID(),
        id,
        randomUUID(),
        randomUUID(),
        digest(`${id}:manifest`),
        JSON.stringify({ migratedLegacyRecovery: true }),
      ],
    );
  return id;
}

async function insertReceipt(
  client: Client,
  workspace: WorkspaceFixture,
  input: {
    seed: string;
    artifactCount?: number;
    totalByteLength?: number;
    artifactPosition?: number;
  },
): Promise<ReceiptFixture> {
  const revision = workspace.revisions.at(-1);
  if (!revision) throw new Error("Receipt fixture revision is missing.");
  const id = randomUUID();
  const publicationId = randomUUID();
  const releaseId = randomUUID();
  const baseReleaseId = randomUUID();
  const candidateHash = digest(`${input.seed}:candidate`);
  const expectedPointerGeneration = 7n;
  const bytes = Buffer.from("abc", "utf8");
  await client.query(
    `INSERT INTO publication_preflight_receipts (
       id, publication_id, release_id, situation_id, revision_id,
       checkout_id, checkout_fence, revision_bundle_hash, candidate_hash,
       base_release_id, base_manifest_hash, expected_pointer_generation,
       contract_identity, contract_digest, validation_result, diagnostics,
       route_expectations, source_kind, manifest_hash, manifest_body,
       artifact_count, edge_count, total_byte_length, compiled_projection
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13::jsonb, $14, 'PASSED', '[]'::jsonb, '[]'::jsonb, 'MANUAL',
       $15, '{}', $16, 0, $17, '{}'::jsonb
     )`,
    [
      id,
      publicationId,
      releaseId,
      workspace.situationId,
      revision.id,
      workspace.checkoutId,
      workspace.checkoutFence,
      revision.bundleHash,
      candidateHash,
      baseReleaseId,
      digest(`${input.seed}:base-manifest`),
      expectedPointerGeneration,
      JSON.stringify({ schemaVersion: "fixture-compiler-v1" }),
      digest(`${input.seed}:contract`),
      digest(`${input.seed}:manifest`),
      input.artifactCount ?? 1,
      input.totalByteLength ?? bytes.byteLength,
    ],
  );
  await client.query(
    `INSERT INTO publication_candidate_artifacts (
       receipt_id, logical_id, position, artifact_type, path,
       content_hash, byte_length, encoding, media_type, bytes
     ) VALUES ($1, $2, $3, 'SITUATION', $4, $5, $6, 'UTF8',
               'text/mdx; charset=utf-8', $7)`,
    [
      id,
      `situation:${input.seed}`,
      input.artifactPosition ?? 0,
      `content/situations/${input.seed}.mdx`,
      digest(bytes),
      bytes.byteLength,
      bytes,
    ],
  );
  return {
    id,
    publicationId,
    releaseId,
    candidateHash,
    baseReleaseId,
    expectedPointerGeneration,
    revision,
  };
}

async function sealReceipt(client: Client, receiptId: string) {
  await client.query(
    `UPDATE publication_preflight_receipts
        SET sealed_at = now()
      WHERE id = $1`,
    [receiptId],
  );
}

async function expectSqlState(
  operation: Promise<QueryResult>,
  code: "23514" | "55000",
) {
  await expect(operation).rejects.toMatchObject({ code });
}

describe("deterministic publication preflight migration", () => {
  let container: StartedPostgreSqlContainer;
  let freshUrl: string;
  let upgradeUrl: string;
  let upgrade: Client;
  let actorId: string;
  let retainedWorkspace: WorkspaceFixture;
  let retainedProposalId: string;
  let legacyRequestedJobId: string;
  let legacyPromotingJobId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16.12-bookworm")
      .withDatabase("migration_harness")
      .withUsername("studio_test_owner")
      .withPassword("studio_test_password")
      .start();
    const adminUrl = databaseUrl(container, "migration_harness");
    await createDatabase(adminUrl, "fresh_apply");
    await createDatabase(adminUrl, "upgrade_apply");
    freshUrl = databaseUrl(container, "fresh_apply");
    upgradeUrl = databaseUrl(container, "upgrade_apply");

    await Promise.all([
      executeFile("pnpm", ["db:migrate:deploy"], {
        cwd: studioRoot,
        env: { ...process.env, STUDIO_DATABASE_URL: freshUrl },
      }),
      applyMigrationsBeforeTarget(upgradeUrl),
    ]);

    upgrade = await connect(upgradeUrl);
    actorId = await insertUser(upgrade, "migration-fixture-editor");
    retainedWorkspace = await insertWorkspace(upgrade, {
      actorId,
      slug: "retained-proposal-history",
      revisionCount: 3,
    });
    const retainedReviewJobId = await insertOldReviewJob(
      upgrade,
      retainedWorkspace,
      retainedWorkspace.revisions[0]!,
    );
    retainedProposalId = await insertOldProposal(upgrade, {
      jobId: retainedReviewJobId,
      inputRevisionId: retainedWorkspace.revisions[0]!.id,
      seed: "retained",
    });
    await insertProposalChange(upgrade, {
      proposalId: retainedProposalId,
      seed: "retained-applied",
      state: "ACCEPTED",
      appliedRevisionId: retainedWorkspace.revisions[1]!.id,
    });

    const legacyRequestedWorkspace = await insertWorkspace(upgrade, {
      actorId,
      slug: "legacy-requested-publication",
      revisionCount: 1,
    });
    legacyRequestedJobId = await insertLegacyPublicationJob(
      upgrade,
      legacyRequestedWorkspace,
      "REQUESTED",
    );
    const legacyPromotingWorkspace = await insertWorkspace(upgrade, {
      actorId,
      slug: "legacy-promoting-publication",
      revisionCount: 1,
    });
    legacyPromotingJobId = await insertLegacyPublicationJob(
      upgrade,
      legacyPromotingWorkspace,
      "PROMOTING",
    );

    await upgrade.end();
    await applyTargetMigration(upgradeUrl);
    upgrade = await connect(upgradeUrl);
  });

  afterAll(async () => {
    await upgrade?.end().catch(() => undefined);
    await container?.stop();
  });

  it("applies cleanly to a fresh database through Prisma migrate deploy", async () => {
    const fresh = await connect(freshUrl);
    try {
      const migration = await fresh.query<{ finished_at: Date | null }>(
        `SELECT finished_at
           FROM _prisma_migrations
          WHERE migration_name = $1`,
        [targetMigration],
      );
      expect(migration.rows).toHaveLength(1);
      expect(migration.rows[0]?.finished_at).toBeInstanceOf(Date);
      const schema = await fresh.query<{
        receipts: string | null;
        artifacts: string | null;
        input_bundle_hash: string | null;
      }>(
        `SELECT
           to_regclass('public.publication_preflight_receipts')::text AS receipts,
           to_regclass('public.publication_candidate_artifacts')::text AS artifacts,
           (
             SELECT column_name
               FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'review_jobs'
                AND column_name = 'input_bundle_hash'
           ) AS input_bundle_hash`,
      );
      expect(schema.rows[0]).toEqual({
        receipts: "publication_preflight_receipts",
        artifacts: "publication_candidate_artifacts",
        input_bundle_hash: "input_bundle_hash",
      });
    } finally {
      await fresh.end();
    }
  });

  it("backfills retained proposal fences from accepted history and marks later workspace movement", async () => {
    const proposal = await upgrade.query<{
      input_bundle_hash: string;
      current_revision_id: string;
      current_bundle_hash: string;
      superseded_at: Date | null;
      superseded_by_revision_id: string | null;
    }>(
      `SELECT input_bundle_hash, current_revision_id, current_bundle_hash,
              superseded_at, superseded_by_revision_id
         FROM review_proposals
        WHERE id = $1`,
      [retainedProposalId],
    );
    expect(proposal.rows[0]).toMatchObject({
      input_bundle_hash: retainedWorkspace.revisions[0]!.bundleHash,
      current_revision_id: retainedWorkspace.revisions[1]!.id,
      current_bundle_hash: retainedWorkspace.revisions[1]!.bundleHash,
      superseded_by_revision_id: retainedWorkspace.revisions[2]!.id,
    });
    expect(proposal.rows[0]?.superseded_at).toBeInstanceOf(Date);
  });

  it("keeps old review and proposal inserts compatible and advances their fence from an accepted change", async () => {
    const workspace = await insertWorkspace(upgrade, {
      actorId,
      slug: "rolling-old-review-writer",
      revisionCount: 2,
      currentRevision: 1,
    });
    const jobId = await insertOldReviewJob(
      upgrade,
      workspace,
      workspace.revisions[0]!,
    );
    const job = await upgrade.query<{ input_bundle_hash: string }>(
      `SELECT input_bundle_hash FROM review_jobs WHERE id = $1`,
      [jobId],
    );
    expect(job.rows[0]?.input_bundle_hash).toBe(
      workspace.revisions[0]!.bundleHash,
    );

    const proposalId = await insertOldProposal(upgrade, {
      jobId,
      inputRevisionId: workspace.revisions[0]!.id,
      seed: "rolling-old-writer",
    });
    const initial = await upgrade.query<{
      input_bundle_hash: string;
      current_revision_id: string;
      current_bundle_hash: string;
    }>(
      `SELECT input_bundle_hash, current_revision_id, current_bundle_hash
         FROM review_proposals
        WHERE id = $1`,
      [proposalId],
    );
    expect(initial.rows[0]).toEqual({
      input_bundle_hash: workspace.revisions[0]!.bundleHash,
      current_revision_id: workspace.revisions[0]!.id,
      current_bundle_hash: workspace.revisions[0]!.bundleHash,
    });

    const changeId = await insertProposalChange(upgrade, {
      proposalId,
      seed: "rolling-old-writer",
    });
    await upgrade.query(
      `UPDATE drafts
          SET current_revision_number = $2,
              current_bundle_hash = $3,
              updated_at = now()
        WHERE id = $1`,
      [
        workspace.draftId,
        workspace.revisions[1]!.revision,
        workspace.revisions[1]!.bundleHash,
      ],
    );
    await upgrade.query(
      `UPDATE proposal_changes
          SET state = 'ACCEPTED',
              decided_at = now(),
              decided_by_id = $2,
              applied_revision_id = $3
        WHERE id = $1`,
      [changeId, actorId, workspace.revisions[1]!.id],
    );
    const advanced = await upgrade.query<{
      current_revision_id: string;
      current_bundle_hash: string;
    }>(
      `SELECT current_revision_id, current_bundle_hash
         FROM review_proposals
        WHERE id = $1`,
      [proposalId],
    );
    expect(advanced.rows[0]).toEqual({
      current_revision_id: workspace.revisions[1]!.id,
      current_bundle_hash: workspace.revisions[1]!.bundleHash,
    });
    await expectSqlState(
      upgrade.query(
        `UPDATE review_jobs SET input_bundle_hash = $2 WHERE id = $1`,
        [jobId, digest("forged-review-input")],
      ),
      "55000",
    );
  });

  it("preserves and explicitly marks rollout-era in-flight publication jobs", async () => {
    const jobs = await upgrade.query<{
      id: string;
      state: string;
      legacy_preflight_exempt: boolean;
      preflight_receipt_id: string | null;
      candidate_hash: string | null;
    }>(
      `SELECT id, state, legacy_preflight_exempt, preflight_receipt_id,
              candidate_hash
         FROM publication_jobs
        WHERE id = ANY($1::uuid[])
        ORDER BY state`,
      [[legacyRequestedJobId, legacyPromotingJobId]],
    );
    const jobsById = new Map(jobs.rows.map((job) => [job.id, job]));
    expect(jobsById.get(legacyPromotingJobId)).toEqual({
      id: legacyPromotingJobId,
      state: "PROMOTING",
      legacy_preflight_exempt: true,
      preflight_receipt_id: null,
      candidate_hash: null,
    });
    expect(jobsById.get(legacyRequestedJobId)).toEqual({
      id: legacyRequestedJobId,
      state: "REQUESTED",
      legacy_preflight_exempt: true,
      preflight_receipt_id: null,
      candidate_hash: null,
    });
    const snapshot = await upgrade.query<{ assembly: unknown }>(
      `SELECT assembly
         FROM publication_candidate_snapshots
        WHERE job_id = $1`,
      [legacyPromotingJobId],
    );
    expect(snapshot.rows[0]?.assembly).toEqual({
      migratedLegacyRecovery: true,
    });
  });

  it("rejects every newly inserted receipt-less publication job, including attempted legacy opt-in", async () => {
    const workspace = await insertWorkspace(upgrade, {
      actorId,
      slug: "receiptless-new-publication",
      revisionCount: 1,
    });
    const revision = workspace.revisions[0]!;
    for (const legacyPreflightExempt of [false, true])
      await expectSqlState(
        upgrade.query(
          `INSERT INTO publication_jobs (
             id, publication_id, situation_id, target_revision_id,
             checkout_id, checkout_fence, source_kind, state,
             target_bundle_hash, legacy_preflight_exempt
           ) VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', 'REQUESTED',
                     $7, $8)`,
          [
            randomUUID(),
            randomUUID(),
            workspace.situationId,
            revision.id,
            workspace.checkoutId,
            workspace.checkoutFence,
            revision.bundleHash,
            legacyPreflightExempt,
          ],
        ),
        "23514",
      );
  });

  it("enforces exact artifact count and byte totals before sealing", async () => {
    const workspace = await insertWorkspace(upgrade, {
      actorId,
      slug: "receipt-sealing-accounting",
      revisionCount: 1,
    });
    const wrongCount = await insertReceipt(upgrade, workspace, {
      seed: "wrong-count",
      artifactCount: 2,
    });
    await expectSqlState(
      upgrade.query(
        `UPDATE publication_preflight_receipts
            SET sealed_at = now()
          WHERE id = $1`,
        [wrongCount.id],
      ),
      "23514",
    );
    const wrongBytes = await insertReceipt(upgrade, workspace, {
      seed: "wrong-bytes",
      totalByteLength: 4,
    });
    await expectSqlState(
      upgrade.query(
        `UPDATE publication_preflight_receipts
            SET sealed_at = now()
          WHERE id = $1`,
        [wrongBytes.id],
      ),
      "23514",
    );
    const exact = await insertReceipt(upgrade, workspace, { seed: "exact" });
    await sealReceipt(upgrade, exact.id);
    const sealed = await upgrade.query<{ sealed_at: Date | null }>(
      `SELECT sealed_at
         FROM publication_preflight_receipts
        WHERE id = $1`,
      [exact.id],
    );
    expect(sealed.rows[0]?.sealed_at).toBeInstanceOf(Date);
  });

  it("makes receipt evidence and candidate artifacts immutable across the one-way seal", async () => {
    const workspace = await insertWorkspace(upgrade, {
      actorId,
      slug: "receipt-immutability",
      revisionCount: 1,
    });
    const receipt = await insertReceipt(upgrade, workspace, {
      seed: "immutable",
    });
    await expectSqlState(
      upgrade.query(
        `UPDATE publication_candidate_artifacts
            SET content_hash = $2
          WHERE receipt_id = $1`,
        [receipt.id, digest("tampered-artifact")],
      ),
      "55000",
    );
    await expectSqlState(
      upgrade.query(
        `DELETE FROM publication_candidate_artifacts WHERE receipt_id = $1`,
        [receipt.id],
      ),
      "55000",
    );
    await expectSqlState(
      upgrade.query(
        `UPDATE publication_preflight_receipts
            SET manifest_hash = $2
          WHERE id = $1`,
        [receipt.id, digest("tampered-manifest")],
      ),
      "55000",
    );
    await sealReceipt(upgrade, receipt.id);
    await expectSqlState(
      upgrade.query(
        `INSERT INTO publication_candidate_artifacts (
           receipt_id, logical_id, position, artifact_type, path,
           content_hash, byte_length, encoding, media_type, bytes
         ) VALUES ($1, 'guide:late', 1, 'GUIDE', 'content/guides/late.mdx',
                   $2, 4, 'UTF8', 'text/mdx; charset=utf-8', $3)`,
        [receipt.id, digest("late"), Buffer.from("late")],
      ),
      "55000",
    );
    await expectSqlState(
      upgrade.query(
        `DELETE FROM publication_preflight_receipts WHERE id = $1`,
        [receipt.id],
      ),
      "55000",
    );
  });

  it("requires a sealed exact receipt identity for each new publication job", async () => {
    const workspace = await insertWorkspace(upgrade, {
      actorId,
      slug: "job-receipt-identity",
      revisionCount: 1,
    });
    const unsealed = await insertReceipt(upgrade, workspace, {
      seed: "unsealed-job",
    });
    await expectSqlState(
      upgrade.query(
        `INSERT INTO publication_jobs (
           id, publication_id, situation_id, target_revision_id, checkout_id,
           checkout_fence, source_kind, state, target_bundle_hash,
           preflight_receipt_id, candidate_hash, legacy_preflight_exempt,
           expected_pointer_generation, observed_release_id,
           previous_release_id
         ) VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', 'REQUESTED', $7,
                   $8, $9, false, $10, $11, $11)`,
        [
          randomUUID(),
          unsealed.publicationId,
          workspace.situationId,
          unsealed.revision.id,
          workspace.checkoutId,
          workspace.checkoutFence,
          unsealed.revision.bundleHash,
          unsealed.id,
          unsealed.candidateHash,
          unsealed.expectedPointerGeneration,
          unsealed.baseReleaseId,
        ],
      ),
      "23514",
    );

    const receipt = await insertReceipt(upgrade, workspace, {
      seed: "exact-job",
    });
    await sealReceipt(upgrade, receipt.id);
    await expectSqlState(
      upgrade.query(
        `INSERT INTO publication_jobs (
           id, publication_id, situation_id, target_revision_id, checkout_id,
           checkout_fence, source_kind, state, target_bundle_hash,
           preflight_receipt_id, candidate_hash, legacy_preflight_exempt,
           expected_pointer_generation, observed_release_id,
           previous_release_id
         ) VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', 'REQUESTED', $7,
                   $8, $9, false, $10, $11, $11)`,
        [
          randomUUID(),
          receipt.publicationId,
          workspace.situationId,
          receipt.revision.id,
          workspace.checkoutId,
          workspace.checkoutFence,
          receipt.revision.bundleHash,
          receipt.id,
          digest("wrong-candidate"),
          receipt.expectedPointerGeneration,
          receipt.baseReleaseId,
        ],
      ),
      "23514",
    );
    const jobId = randomUUID();
    await upgrade.query(
      `INSERT INTO publication_jobs (
         id, publication_id, situation_id, target_revision_id, checkout_id,
         checkout_fence, source_kind, state, target_bundle_hash,
         preflight_receipt_id, candidate_hash, legacy_preflight_exempt,
         expected_pointer_generation, observed_release_id,
         previous_release_id
       ) VALUES ($1, $2, $3, $4, $5, $6, 'MANUAL', 'REQUESTED', $7,
                 $8, $9, false, $10, $11, $11)`,
      [
        jobId,
        receipt.publicationId,
        workspace.situationId,
        receipt.revision.id,
        workspace.checkoutId,
        workspace.checkoutFence,
        receipt.revision.bundleHash,
        receipt.id,
        receipt.candidateHash,
        receipt.expectedPointerGeneration,
        receipt.baseReleaseId,
      ],
    );
    await expectSqlState(
      upgrade.query(
        `UPDATE publication_jobs SET candidate_hash = $2 WHERE id = $1`,
        [jobId, digest("later-tampering")],
      ),
      "55000",
    );
  });
});
