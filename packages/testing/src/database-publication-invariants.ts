import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !/situation_studio_migration_test_/u.test(databaseUrl))
  throw new Error(
    "Refusing database-publication verification outside a dedicated situation_studio_migration_test_* database.",
  );

const { Client } = pg;
const client = new Client({ connectionString: databaseUrl });
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
let savepoint = 0;

async function expectRejected(
  label: string,
  operation: () => Promise<unknown>,
  messagePattern?: RegExp,
) {
  const name = `expected_rejection_${(savepoint += 1)}`;
  await client.query(`SAVEPOINT ${name}`);
  let rejected = false;
  try {
    await operation();
  } catch (error) {
    rejected = true;
    if (
      messagePattern &&
      !messagePattern.test(
        error instanceof Error ? error.message : String(error),
      )
    )
      throw error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
  await client.query(`RELEASE SAVEPOINT ${name}`);
  if (!rejected) throw new Error(`${label} was unexpectedly accepted.`);
}

await client.connect();
await client.query("BEGIN");
try {
  const roleRows = await client.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])`,
    [
      [
        "situation_studio_web",
        "situation_studio_materializer",
        "leadership_content_reader",
        "situation_studio_operations",
        "situation_studio_ai",
        "situation_studio_validator",
        "situation_studio_publisher",
      ],
    ],
  );
  if (roleRows.rowCount !== 7)
    throw new Error(
      "Checkpoint 1 roles are missing; provision test roles and apply all three ops grant scripts.",
    );

  const ids = {
    repositorySnapshot: randomUUID(),
    situation: randomUUID(),
    checkout: randomUUID(),
    draft: randomUUID(),
    artifactA: randomUUID(),
    artifactB: randomUUID(),
    officialSnapshot: randomUUID(),
    candidateSnapshot: randomUUID(),
    target: randomUUID(),
    reviewer: randomUUID(),
    publisher: randomUUID(),
    session: randomUUID(),
    bundle: randomUUID(),
    approval: randomUUID(),
    request: randomUUID(),
    databasePublication: randomUUID(),
    candidateAuthorization: randomUUID(),
    candidateReceipt: randomUUID(),
    confirmation: randomUUID(),
    officialReceipt: randomUUID(),
  };
  const commit = hash("checkpoint-1-repository").slice(0, 40);
  const repositoryManifestHash = hash("checkpoint-1-repository-manifest");
  const policyHash = hash("checkpoint-1-validation-policy");
  const bodyA = "# Exact official situation\n";
  const bodyB = '{"kind":"practice","version":1}\n';
  const bodyCandidate = "# Exact candidate situation\n";
  const bodyAHash = hash(bodyA);
  const bodyBHash = hash(bodyB);
  const bodyCandidateHash = hash(bodyCandidate);

  await expectRejected("corrupt content-addressed blob", () =>
    client.query(
      `INSERT INTO content_blobs (hash, body, byte_length) VALUES ($1, $2, $3)`,
      [hash("not-the-body"), bodyA, Buffer.byteLength(bodyA)],
    ),
  );
  const binaryBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  await expectRejected("corrupt binary content-addressed blob", () =>
    client.query(
      `INSERT INTO content_blobs
        (hash, body, encoding, binary_body, byte_length)
       VALUES ($1, '', 'BINARY', $2, $3)`,
      [hash("not-the-binary-body"), binaryBody, binaryBody.byteLength],
    ),
  );
  await client.query(
    `INSERT INTO content_blobs
      (hash, body, encoding, binary_body, byte_length)
     VALUES ($1, '', 'BINARY', $2, $3)`,
    [hash(binaryBody), binaryBody, binaryBody.byteLength],
  );
  await client.query(
    `INSERT INTO content_blobs (hash, body, byte_length) VALUES
      ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)`,
    [
      bodyAHash,
      bodyA,
      Buffer.byteLength(bodyA),
      bodyBHash,
      bodyB,
      Buffer.byteLength(bodyB),
      bodyCandidateHash,
      bodyCandidate,
      Buffer.byteLength(bodyCandidate),
    ],
  );
  await expectRejected("content blob mutation", () =>
    client.query(
      `UPDATE content_blobs SET body = body || 'x' WHERE hash = $1`,
      [bodyAHash],
    ),
  );

  await client.query(
    `INSERT INTO repository_snapshots
      (id, commit_sha, manifest, manifest_hash, parser_version, import_kind, validation_state)
     VALUES ($1, $2, '{}'::jsonb, $3, 'checkpoint-1', 'LEGACY_IMPORT', 'PASSED')`,
    [ids.repositorySnapshot, commit, repositoryManifestHash],
  );
  await client.query(
    `INSERT INTO situations (id, slug, title, updated_at)
     VALUES ($1, $2, 'Checkpoint 1 situation', clock_timestamp())`,
    [ids.situation, `checkpoint-1-${randomUUID().slice(0, 8)}`],
  );
  await client.query(
    `INSERT INTO artifacts
      (id, logical_id, type, canonical_path, primary_situation_id, repository_snapshot_id, updated_at)
     VALUES
      ($1, 'situation:checkpoint-1', 'SITUATION', 'content/situations/checkpoint-1.mdx', $3, $4, clock_timestamp()),
      ($2, 'practice:checkpoint-1', 'PRACTICE', 'content/practices/checkpoint-1.json', $3, $4, clock_timestamp())`,
    [ids.artifactA, ids.artifactB, ids.situation, ids.repositorySnapshot],
  );

  const officialManifest = JSON.stringify({
    schemaVersion: "content-snapshot-v1",
    artifacts: [
      {
        logicalId: "practice:checkpoint-1",
        path: "content/practices/checkpoint-1.json",
        type: "PRACTICE",
        contentHash: bodyBHash,
        byteLength: Buffer.byteLength(bodyB),
      },
      {
        logicalId: "situation:checkpoint-1",
        path: "content/situations/checkpoint-1.mdx",
        type: "SITUATION",
        contentHash: bodyAHash,
        byteLength: Buffer.byteLength(bodyA),
      },
    ],
  });
  const officialManifestHash = hash(officialManifest);
  await client.query(
    `INSERT INTO content_snapshots
      (id, manifest, manifest_hash, validation_policy_hash, artifact_count, total_byte_length)
     VALUES ($1, $2, $3, $4, 2, $5)`,
    [
      ids.officialSnapshot,
      officialManifest,
      officialManifestHash,
      policyHash,
      Buffer.byteLength(bodyA) + Buffer.byteLength(bodyB),
    ],
  );
  await client.query(
    `INSERT INTO content_snapshot_artifacts
      (snapshot_id, artifact_id, logical_id, canonical_path, artifact_type, content_hash, byte_length)
     VALUES
      ($1, $2, 'situation:checkpoint-1', 'content/situations/checkpoint-1.mdx', 'SITUATION', $4, $6),
      ($1, $3, 'practice:checkpoint-1', 'content/practices/checkpoint-1.json', 'PRACTICE', $5, $7)`,
    [
      ids.officialSnapshot,
      ids.artifactA,
      ids.artifactB,
      bodyAHash,
      bodyBHash,
      Buffer.byteLength(bodyA),
      Buffer.byteLength(bodyB),
    ],
  );
  await client.query(
    `INSERT INTO content_snapshot_edges
      (id, snapshot_id, source_artifact_id, target_artifact_id, edge_type, evidence)
     VALUES ($1, $2, $3, $4, 'EMBEDS_PRACTICE', 'checkpoint-1 graph fixture')`,
    [randomUUID(), ids.officialSnapshot, ids.artifactA, ids.artifactB],
  );
  await client.query(
    `UPDATE content_snapshots
     SET validation_state = 'VALIDATED', verified_at = clock_timestamp()
     WHERE id = $1`,
    [ids.officialSnapshot],
  );
  await expectRejected("finalized snapshot membership mutation", () =>
    client.query(
      `DELETE FROM content_snapshot_artifacts WHERE snapshot_id = $1 AND artifact_id = $2`,
      [ids.officialSnapshot, ids.artifactA],
    ),
  );

  await client.query(
    `INSERT INTO publication_targets (id, code, updated_at)
     VALUES ($1, 'leadership-production', clock_timestamp())`,
    [ids.target],
  );
  await client.query(
    `UPDATE publication_targets
     SET official_snapshot_id = $2, generation = 1,
         bootstrapped_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE id = $1`,
    [ids.target, ids.officialSnapshot],
  );
  await expectRejected("unfenced publication target update", () =>
    client.query(
      `UPDATE publication_targets SET updated_at = clock_timestamp() WHERE id = $1`,
      [ids.target],
    ),
  );

  await client.query(
    `INSERT INTO users
      (id, username, display_name, password_hash, identity_type, state, updated_at)
     VALUES
      ($1, $3, 'Checkpoint reviewer', '$argon2id$fixture', 'HUMAN', 'ACTIVE', clock_timestamp()),
      ($2, $4, 'Checkpoint materializer', NULL, 'SERVICE', 'ACTIVE', clock_timestamp())`,
    [
      ids.reviewer,
      ids.publisher,
      `reviewer-${randomUUID().slice(0, 8)}`,
      `materializer-${randomUUID().slice(0, 8)}`,
    ],
  );
  const reauthenticatedAt = new Date();
  await client.query(
    `INSERT INTO sessions
      (id, token_hash, user_id, password_version, csrf_secret_hash,
       idle_expires_at, absolute_expires_at, reauthenticated_at)
     VALUES ($1, $2, $3, 1, $4,
       clock_timestamp() + interval '30 minutes',
       clock_timestamp() + interval '8 hours', $5)`,
    [
      ids.session,
      hash("checkpoint-1-session-token"),
      ids.reviewer,
      hash("checkpoint-1-csrf-token"),
      reauthenticatedAt,
    ],
  );
  await client.query(
    `INSERT INTO drafts
      (id, situation_id, base_snapshot_id, state, updated_at)
     VALUES ($1, $2, $3, 'APPROVED', clock_timestamp())`,
    [ids.draft, ids.situation, ids.repositorySnapshot],
  );
  await client.query(
    `INSERT INTO situation_checkouts
      (id, situation_id, holder_user_id, mode, custody, draft_id,
       fencing_token, expires_at)
     VALUES ($1, $2, $3, 'PUBLISHING', 'PUBLISHER', $4, 0,
       clock_timestamp() + interval '30 minutes')`,
    [ids.checkout, ids.situation, ids.publisher, ids.draft],
  );
  const bundleHash = hash("checkpoint-1-bundle");
  await client.query(
    `INSERT INTO proposed_bundles
      (id, situation_id, revision, snapshot_id, draft_id, base_commit,
       base_content_snapshot_id, base_manifest_hash, graph_hash,
       canonical_hash, manifest, state)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb, 'APPROVED')`,
    [
      ids.bundle,
      ids.situation,
      ids.repositorySnapshot,
      ids.draft,
      commit,
      ids.officialSnapshot,
      officialManifestHash,
      hash("checkpoint-1-graph"),
      bundleHash,
    ],
  );
  await client.query(
    `INSERT INTO approvals
      (id, bundle_id, bundle_hash, base_commit, base_content_snapshot_id,
       base_content_snapshot_hash, validation_policy_hash, approved_by_id,
       session_id, permission_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb)`,
    [
      ids.approval,
      ids.bundle,
      bundleHash,
      commit,
      ids.officialSnapshot,
      officialManifestHash,
      policyHash,
      ids.reviewer,
      ids.session,
    ],
  );
  await client.query(
    `INSERT INTO publication_requests
      (id, publication_uuid, idempotency_key, target_environment,
       publication_target_id, bundle_id, bundle_hash, approval_id, base_commit,
       base_content_snapshot_id, base_content_snapshot_hash, requested_by_id, updated_at)
     VALUES ($1, $2, $3, 'leadership-production', $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp())`,
    [
      ids.request,
      randomUUID(),
      `checkpoint-1-${randomUUID()}`,
      ids.target,
      ids.bundle,
      bundleHash,
      ids.approval,
      commit,
      ids.officialSnapshot,
      officialManifestHash,
      ids.reviewer,
    ],
  );
  await expectRejected(
    "cross-table active rollback request",
    () =>
      client.query(
        `INSERT INTO rollback_requests
          (id, rollback_uuid, idempotency_key, target_environment,
           publication_target_id, target_content_snapshot_id,
           target_content_snapshot_hash, expected_current_content_snapshot_id,
           expected_current_content_snapshot_hash, requested_by_id, reason, updated_at)
         VALUES ($1, $2, $3, 'leadership-production', $4, $5, $6, $5, $6, $7,
           'Cross-table contention invariant', clock_timestamp())`,
        [
          randomUUID(),
          randomUUID(),
          `cross-table-${randomUUID()}`,
          ids.target,
          ids.officialSnapshot,
          officialManifestHash,
          ids.reviewer,
        ],
      ),
    /DATABASE_UNIQUE_TARGET/u,
  );
  await client.query(
    `INSERT INTO database_publications
      (id, publication_uuid, publication_request_id, target_id, bundle_id,
       approval_id, previous_official_snapshot_id, publisher_identity_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp())`,
    [
      ids.databasePublication,
      randomUUID(),
      ids.request,
      ids.target,
      ids.bundle,
      ids.approval,
      ids.officialSnapshot,
      ids.publisher,
    ],
  );

  const candidateManifest = JSON.stringify({
    schemaVersion: "content-snapshot-v1",
    artifacts: [
      {
        logicalId: "practice:checkpoint-1",
        path: "content/practices/checkpoint-1.json",
        type: "PRACTICE",
        contentHash: bodyBHash,
        byteLength: Buffer.byteLength(bodyB),
      },
      {
        logicalId: "situation:checkpoint-1",
        path: "content/situations/checkpoint-1.mdx",
        type: "SITUATION",
        contentHash: bodyCandidateHash,
        byteLength: Buffer.byteLength(bodyCandidate),
      },
    ],
  });
  const candidateManifestHash = hash(candidateManifest);
  await client.query(
    `INSERT INTO content_snapshots
      (id, parent_snapshot_id, manifest, manifest_hash, source_bundle_id,
       validation_policy_hash, artifact_count, total_byte_length)
     VALUES ($1, $2, $3, $4, $5, $6, 2, $7)`,
    [
      ids.candidateSnapshot,
      ids.officialSnapshot,
      candidateManifest,
      candidateManifestHash,
      ids.bundle,
      policyHash,
      Buffer.byteLength(bodyCandidate) + Buffer.byteLength(bodyB),
    ],
  );
  await client.query(
    `INSERT INTO content_snapshot_artifacts
      (snapshot_id, artifact_id, logical_id, canonical_path, artifact_type, content_hash, byte_length)
     VALUES
      ($1, $2, 'situation:checkpoint-1', 'content/situations/checkpoint-1.mdx', 'SITUATION', $4, $6),
      ($1, $3, 'practice:checkpoint-1', 'content/practices/checkpoint-1.json', 'PRACTICE', $5, $7)`,
    [
      ids.candidateSnapshot,
      ids.artifactA,
      ids.artifactB,
      bodyCandidateHash,
      bodyBHash,
      Buffer.byteLength(bodyCandidate),
      Buffer.byteLength(bodyB),
    ],
  );
  await client.query(
    `UPDATE publication_requests
     SET candidate_content_snapshot_id = $2,
         candidate_content_snapshot_hash = $3,
         updated_at = clock_timestamp()
     WHERE id = $1`,
    [ids.request, ids.candidateSnapshot, candidateManifestHash],
  );
  await client.query(
    `UPDATE database_publications
     SET candidate_snapshot_id = $2, state = 'SNAPSHOT_MATERIALIZED', updated_at = clock_timestamp()
     WHERE id = $1`,
    [ids.databasePublication, ids.candidateSnapshot],
  );
  await client.query(
    `UPDATE content_snapshots
     SET validation_state = 'VALIDATED', verified_at = clock_timestamp()
     WHERE id = $1`,
    [ids.candidateSnapshot],
  );
  for (const state of ["SNAPSHOT_VALIDATED", "CANDIDATE_AVAILABLE"])
    await client.query(
      `UPDATE database_publications SET state = $2::"PublicationSagaState", updated_at = clock_timestamp() WHERE id = $1`,
      [ids.databasePublication, state],
    );
  await client.query(
    `UPDATE publication_targets
     SET candidate_snapshot_id = $2, candidate_publication_request_id = $3,
         current_database_publication_id = $4, generation = 2,
         updated_at = clock_timestamp()
     WHERE id = $1`,
    [ids.target, ids.candidateSnapshot, ids.request, ids.databasePublication],
  );
  await client.query(
    `UPDATE publication_requests SET target_generation = 2, updated_at = clock_timestamp() WHERE id = $1`,
    [ids.request],
  );

  const firstEvent = await client.query<{ event_sequence: string }>(
    `SELECT * FROM append_publication_event($1, NULL, $2, 'candidate.available', 'CANDIDATE_AVAILABLE', $3::jsonb)`,
    [
      ids.request,
      ids.target,
      JSON.stringify({ snapshotHash: candidateManifestHash }),
    ],
  );
  const replayEvent = await client.query<{ event_sequence: string }>(
    `SELECT * FROM append_publication_event($1, NULL, $2, 'candidate.available', 'CANDIDATE_AVAILABLE', $3::jsonb)`,
    [
      ids.request,
      ids.target,
      JSON.stringify({ snapshotHash: candidateManifestHash }),
    ],
  );
  if (
    firstEvent.rows[0]?.event_sequence !== "1" ||
    replayEvent.rows[0]?.event_sequence !== "1"
  )
    throw new Error("Publication event idempotency/replay sequence failed.");
  await expectRejected("event idempotency evidence mismatch", () =>
    client.query(
      `SELECT * FROM append_publication_event($1, NULL, $2, 'candidate.available', 'FAILED', '{}'::jsonb)`,
      [ids.request, ids.target],
    ),
  );

  const exchangeHash = hash("checkpoint-1-exchange-token");
  const cookieHash = hash("checkpoint-1-cookie-token");
  await client.query(
    `INSERT INTO candidate_authorizations
      (id, publication_request_id, target_id, snapshot_id, snapshot_hash,
       reviewer_id, exchange_token_hash, audience, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
       'https://leadership.example.test', clock_timestamp() + interval '5 minutes')`,
    [
      ids.candidateAuthorization,
      ids.request,
      ids.target,
      ids.candidateSnapshot,
      candidateManifestHash,
      ids.reviewer,
      exchangeHash,
    ],
  );
  await client.query(
    `UPDATE candidate_authorizations
     SET cookie_token_hash = $2, exchanged_at = clock_timestamp()
     WHERE id = $1`,
    [ids.candidateAuthorization, cookieHash],
  );
  await expectRejected("candidate exchange replay", () =>
    client.query(
      `UPDATE candidate_authorizations
       SET cookie_token_hash = $2, exchanged_at = clock_timestamp()
       WHERE id = $1`,
      [ids.candidateAuthorization, hash("replayed-cookie")],
    ),
  );
  const expiredAuthorization = randomUUID();
  await expectRejected("expired candidate authorization", () =>
    client.query(
      `INSERT INTO candidate_authorizations
        (id, publication_request_id, target_id, snapshot_id, snapshot_hash,
         reviewer_id, exchange_token_hash, audience, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
         'https://leadership.example.test', clock_timestamp() - interval '1 second')`,
      [
        expiredAuthorization,
        ids.request,
        ids.target,
        ids.candidateSnapshot,
        candidateManifestHash,
        ids.reviewer,
        hash("expired-exchange"),
      ],
    ),
  );

  await client.query("SET LOCAL ROLE leadership_content_reader");
  const publicRows = await client.query(
    `SELECT * FROM leadership_read_official_snapshot_v2('leadership-production')`,
  );
  const deniedCandidate = await client.query(
    `SELECT * FROM leadership_read_candidate_snapshot_v2(
       'leadership-production', $1, $2, 'https://leadership.example.test')`,
    [hash("wrong-cookie"), ids.reviewer],
  );
  const candidateRows = await client.query(
    `SELECT * FROM leadership_read_candidate_snapshot_v2(
       'leadership-production', $1, $2, 'https://leadership.example.test')`,
    [cookieHash, ids.reviewer],
  );
  if (
    publicRows.rowCount !== 2 ||
    deniedCandidate.rowCount !== 0 ||
    candidateRows.rowCount !== 2
  )
    throw new Error("Leadership official/candidate isolation contract failed.");
  await expectRejected("Leadership direct snapshot table read", () =>
    client.query(`SELECT * FROM content_snapshots LIMIT 1`),
  );
  await client.query("RESET ROLE");
  await client.query(
    `UPDATE candidate_authorizations
     SET revoked_at = clock_timestamp()
     WHERE id = $1`,
    [ids.candidateAuthorization],
  );
  await client.query("SET LOCAL ROLE leadership_content_reader");
  const revokedCandidate = await client.query(
    `SELECT * FROM leadership_read_candidate_snapshot_v2(
       'leadership-production', $1, $2, 'https://leadership.example.test')`,
    [cookieHash, ids.reviewer],
  );
  if (revokedCandidate.rowCount !== 0)
    throw new Error("Revoked candidate authorization remained readable.");
  await client.query("RESET ROLE");

  await client.query(
    `INSERT INTO leadership_observation_receipts
      (id, target_id, database_publication_id, snapshot_id, snapshot_hash,
       observation_kind, cache_source, health_result,
       application_release_identity, route_probe_hash, attestation_key_id,
       receipt_digest, observed_at)
     VALUES ($1, $2, $3, $4, $5, 'CANDIDATE', 'DATABASE', 'HEALTHY',
       'checkpoint-app-release', $6, 'checkpoint-key', $7, clock_timestamp())`,
    [
      ids.candidateReceipt,
      ids.target,
      ids.databasePublication,
      ids.candidateSnapshot,
      candidateManifestHash,
      hash("candidate-route-probe"),
      hash("candidate-receipt"),
    ],
  );
  for (const state of ["CANDIDATE_VERIFIED", "AWAITING_CONFIRMATION"])
    await client.query(
      `UPDATE database_publications SET state = $2::"PublicationSagaState", updated_at = clock_timestamp() WHERE id = $1`,
      [ids.databasePublication, state],
    );

  const confirmedAt = new Date();
  await expectRejected("confirmation for an undisplayed hash", () =>
    client.query(
      `INSERT INTO publication_confirmations
        (id, publication_request_id, target_id, snapshot_id, snapshot_hash,
         approval_id, confirmed_by_id, session_id, validation_policy_hash,
         target_generation, recent_authentication_at, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2, $10, $11)`,
      [
        randomUUID(),
        ids.request,
        ids.target,
        ids.candidateSnapshot,
        hash("wrong-snapshot"),
        ids.approval,
        ids.reviewer,
        ids.session,
        policyHash,
        reauthenticatedAt,
        confirmedAt,
      ],
    ),
  );
  await client.query(
    `INSERT INTO publication_confirmations
      (id, publication_request_id, target_id, snapshot_id, snapshot_hash,
       approval_id, confirmed_by_id, session_id, validation_policy_hash,
       target_generation, recent_authentication_at, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2, $10, $11)`,
    [
      ids.confirmation,
      ids.request,
      ids.target,
      ids.candidateSnapshot,
      candidateManifestHash,
      ids.approval,
      ids.reviewer,
      ids.session,
      policyHash,
      reauthenticatedAt,
      confirmedAt,
    ],
  );
  await client.query(
    `UPDATE database_publications
     SET confirmation_id = $2, resulting_official_snapshot_id = $3,
         state = 'OFFICIAL_POINTER_COMMITTED', updated_at = clock_timestamp()
     WHERE id = $1`,
    [ids.databasePublication, ids.confirmation, ids.candidateSnapshot],
  );
  await client.query(
    `UPDATE publication_targets
     SET official_snapshot_id = $2, candidate_snapshot_id = NULL,
         candidate_publication_request_id = NULL,
         generation = 3, updated_at = clock_timestamp()
     WHERE id = $1`,
    [ids.target, ids.candidateSnapshot],
  );

  await client.query(
    `INSERT INTO leadership_observation_receipts
      (id, target_id, database_publication_id, snapshot_id, snapshot_hash,
       observation_kind, cache_source, health_result,
       application_release_identity, route_probe_hash, attestation_key_id,
       receipt_digest, observed_at)
     VALUES ($1, $2, $3, $4, $5, 'OFFICIAL', 'DATABASE', 'HEALTHY',
       'checkpoint-app-release', $6, 'checkpoint-key', $7, clock_timestamp())`,
    [
      ids.officialReceipt,
      ids.target,
      ids.databasePublication,
      ids.candidateSnapshot,
      candidateManifestHash,
      hash("official-route-probe"),
      hash("official-receipt"),
    ],
  );
  await client.query(
    `UPDATE database_publications
     SET health_receipt_id = $2, state = 'LIVE_VERIFIED', updated_at = clock_timestamp()
     WHERE id = $1`,
    [ids.databasePublication, ids.officialReceipt],
  );
  await client.query(
    `UPDATE database_publications
     SET state = 'RECONCILED', terminal_outcome = 'PUBLISHED', updated_at = clock_timestamp()
     WHERE id = $1`,
    [ids.databasePublication],
  );
  await expectRejected("Leadership receipt mutation", () =>
    client.query(
      `UPDATE leadership_observation_receipts SET health_result = 'UNHEALTHY' WHERE id = $1`,
      [ids.officialReceipt],
    ),
  );
  await expectRejected("publication event mutation", () =>
    client.query(
      `UPDATE publication_events SET event_type = 'FAILED' WHERE publication_request_id = $1`,
      [ids.request],
    ),
  );

  const privilegeChecks = await client.query<{
    leadership_table_read: boolean;
    leadership_function_execute: boolean;
    materializer_target_update: boolean;
    materializer_candidate_authorization_update: boolean;
    materializer_situation_update: boolean;
    materializer_checkout_read: boolean;
    materializer_checkout_update: boolean;
    materializer_checkout_resource_read: boolean;
    materializer_checkout_resource_update: boolean;
    materializer_bundle_update: boolean;
    materializer_draft_update: boolean;
    materializer_artifact_update: boolean;
    materializer_blob_update: boolean;
    materializer_confirmation_insert: boolean;
    materializer_user_read: boolean;
    ai_target_update: boolean;
    ai_receipt_insert: boolean;
    web_target_update: boolean;
    web_confirmation_insert: boolean;
    web_recovery_lock_execute: boolean;
    operations_session_read: boolean;
  }>(`
    SELECT
      has_table_privilege('leadership_content_reader', 'content_snapshots', 'SELECT') AS leadership_table_read,
      has_function_privilege('leadership_content_reader', 'leadership_read_official_snapshot_v2(text)', 'EXECUTE') AS leadership_function_execute,
      has_table_privilege('situation_studio_materializer', 'publication_targets', 'UPDATE') AS materializer_target_update,
      has_table_privilege('situation_studio_materializer', 'candidate_authorizations', 'UPDATE') AS materializer_candidate_authorization_update,
      has_table_privilege('situation_studio_materializer', 'situations', 'UPDATE') AS materializer_situation_update,
      has_table_privilege('situation_studio_materializer', 'situation_checkouts', 'SELECT') AS materializer_checkout_read,
      has_table_privilege('situation_studio_materializer', 'situation_checkouts', 'UPDATE') AS materializer_checkout_update,
      has_table_privilege('situation_studio_materializer', 'checkout_resources', 'SELECT') AS materializer_checkout_resource_read,
      has_table_privilege('situation_studio_materializer', 'checkout_resources', 'UPDATE') AS materializer_checkout_resource_update,
      has_table_privilege('situation_studio_materializer', 'proposed_bundles', 'UPDATE') AS materializer_bundle_update,
      has_table_privilege('situation_studio_materializer', 'drafts', 'UPDATE') AS materializer_draft_update,
      has_table_privilege('situation_studio_materializer', 'artifacts', 'UPDATE') AS materializer_artifact_update,
      has_table_privilege('situation_studio_materializer', 'content_blobs', 'UPDATE') AS materializer_blob_update,
      has_table_privilege('situation_studio_materializer', 'publication_confirmations', 'INSERT') AS materializer_confirmation_insert,
      has_table_privilege('situation_studio_materializer', 'users', 'SELECT') AS materializer_user_read,
      has_table_privilege('situation_studio_ai', 'publication_targets', 'UPDATE') AS ai_target_update,
      has_table_privilege('situation_studio_ai', 'leadership_observation_receipts', 'INSERT') AS ai_receipt_insert,
      has_table_privilege('situation_studio_web', 'publication_targets', 'UPDATE') AS web_target_update,
      has_table_privilege('situation_studio_web', 'publication_confirmations', 'INSERT') AS web_confirmation_insert,
      has_function_privilege('situation_studio_web', 'lock_publication_target_for_review(text)', 'EXECUTE') AS web_recovery_lock_execute,
      has_table_privilege('situation_studio_operations', 'sessions', 'SELECT') AS operations_session_read
  `);
  const grants = privilegeChecks.rows[0];
  if (
    !grants ||
    grants.leadership_table_read ||
    !grants.leadership_function_execute ||
    !grants.materializer_target_update ||
    !grants.materializer_candidate_authorization_update ||
    grants.materializer_situation_update ||
    !grants.materializer_checkout_read ||
    !grants.materializer_checkout_update ||
    !grants.materializer_checkout_resource_read ||
    !grants.materializer_checkout_resource_update ||
    !grants.materializer_bundle_update ||
    !grants.materializer_draft_update ||
    grants.materializer_artifact_update ||
    grants.materializer_blob_update ||
    grants.materializer_confirmation_insert ||
    grants.materializer_user_read ||
    grants.ai_target_update ||
    grants.ai_receipt_insert ||
    grants.web_target_update ||
    !grants.web_confirmation_insert ||
    !grants.web_recovery_lock_execute ||
    grants.operations_session_read
  )
    throw new Error(`Least-privilege matrix failed: ${JSON.stringify(grants)}`);

  const fenceBeforeRelease = await client.query<{ fence: string }>(
    `SELECT fence::text AS fence FROM situations WHERE id = $1`,
    [ids.situation],
  );
  await client.query("SET LOCAL ROLE situation_studio_materializer");
  await expectRejected("materializer direct situation mutation", () =>
    client.query(`UPDATE situations SET fence = fence + 1 WHERE id = $1`, [
      ids.situation,
    ]),
  );
  const releasedCheckout = await client.query(
    `UPDATE situation_checkouts
     SET released_at = clock_timestamp(),
         release_reason = 'database publication reconciled'
     WHERE id = $1 AND released_at IS NULL`,
    [ids.checkout],
  );
  await client.query("RESET ROLE");
  if (releasedCheckout.rowCount !== 1)
    throw new Error("Materializer could not release the publication checkout.");
  const fenceAfterRelease = await client.query<{ fence: string }>(
    `SELECT fence::text AS fence FROM situations WHERE id = $1`,
    [ids.situation],
  );
  if (
    BigInt(fenceAfterRelease.rows[0]?.fence ?? "-1") !==
    BigInt(fenceBeforeRelease.rows[0]?.fence ?? "-1") + 1n
  )
    throw new Error(
      "Checkout release did not advance the situation fence through the trigger boundary.",
    );

  await client.query("SET LOCAL ROLE situation_studio_web");
  const webRecoveryLock = await client.query<{ target_id: string }>(
    `SELECT lock_publication_target_for_review($1)::text AS target_id`,
    ["leadership-production"],
  );
  await client.query("RESET ROLE");
  if (webRecoveryLock.rows[0]?.target_id !== ids.target)
    throw new Error("Web recovery lock did not return the exact target.");

  const activeIndexes = await client.query<{ indexdef: string }>(`
    SELECT indexdef FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname IN (
        'publication_requests_one_active_target_idx',
        'rollback_requests_one_active_target_idx'
      )
  `);
  if (
    activeIndexes.rowCount !== 2 ||
    activeIndexes.rows.some(
      ({ indexdef }) =>
        !indexdef.includes("SNAPSHOT_MATERIALIZED") ||
        !indexdef.includes("CANDIDATE_AVAILABLE") ||
        !indexdef.includes("OFFICIAL_POINTER_COMMITTED") ||
        !indexdef.includes("RESTORING_PREVIOUS") ||
        !indexdef.includes("RECONCILIATION_REQUIRED"),
    )
  )
    throw new Error("Active-target indexes do not cover every database state.");

  process.stdout.write(
    JSON.stringify({
      database: new URL(databaseUrl).pathname.slice(1),
      schema: "expanded",
      binaryBlobIntegrity: true,
      snapshotImmutability: true,
      officialCandidateIsolation: true,
      candidateAuthorizationLifecycle: true,
      exactConfirmation: true,
      atomicPointerFence: true,
      appendOnlyReplay: true,
      crossTableTargetContention: true,
      leadershipFunctionBoundary: true,
      leastPrivilege: true,
    }) + "\n",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
