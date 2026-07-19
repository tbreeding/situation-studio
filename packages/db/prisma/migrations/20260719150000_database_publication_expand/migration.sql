-- Checkpoint 1 expand migration for database-authoritative content publication.
-- This migration is additive. Git-era publication columns and records are
-- intentionally retained without reinterpretation.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "ContentSnapshotValidationState" AS ENUM (
  'MATERIALIZING',
  'VALIDATED',
  'REJECTED'
);

CREATE TYPE "DatabasePublicationOutcome" AS ENUM (
  'PUBLISHED',
  'PREVIOUS_VERSION_RESTORED',
  'FAILED_BEFORE_CONFIRMATION',
  'RECONCILIATION_REQUIRED'
);

CREATE TYPE "LeadershipObservationKind" AS ENUM (
  'CANDIDATE',
  'OFFICIAL',
  'RESTORATION'
);

CREATE TYPE "LeadershipCacheSource" AS ENUM (
  'DATABASE',
  'LAST_KNOWN_GOOD'
);

CREATE TYPE "LeadershipHealthResult" AS ENUM (
  'HEALTHY',
  'DEGRADED',
  'UNHEALTHY'
);

ALTER TYPE "PublicationSagaState" ADD VALUE 'SNAPSHOT_MATERIALIZED';
ALTER TYPE "PublicationSagaState" ADD VALUE 'SNAPSHOT_VALIDATED';
ALTER TYPE "PublicationSagaState" ADD VALUE 'CANDIDATE_AVAILABLE';
ALTER TYPE "PublicationSagaState" ADD VALUE 'CANDIDATE_VERIFIED';
ALTER TYPE "PublicationSagaState" ADD VALUE 'OFFICIAL_POINTER_COMMITTED';
ALTER TYPE "PublicationSagaState" ADD VALUE 'RESTORING_PREVIOUS';

ALTER TABLE "proposed_bundles"
  ADD COLUMN "base_content_snapshot_id" UUID;

ALTER TABLE "approvals"
  ADD COLUMN "base_content_snapshot_id" UUID,
  ADD COLUMN "base_content_snapshot_hash" CHAR(64);

ALTER TABLE "publication_requests"
  ADD COLUMN "publication_target_id" UUID,
  ADD COLUMN "base_content_snapshot_id" UUID,
  ADD COLUMN "base_content_snapshot_hash" CHAR(64),
  ADD COLUMN "candidate_content_snapshot_id" UUID,
  ADD COLUMN "candidate_content_snapshot_hash" CHAR(64),
  ADD COLUMN "target_generation" BIGINT;

ALTER TABLE "publications"
  ADD COLUMN "content_snapshot_id" UUID;

ALTER TABLE "rollback_requests"
  ADD COLUMN "publication_target_id" UUID,
  ADD COLUMN "target_content_snapshot_id" UUID,
  ADD COLUMN "target_content_snapshot_hash" CHAR(64);

CREATE TABLE "content_snapshots" (
  "id" UUID NOT NULL,
  "parent_snapshot_id" UUID,
  "manifest" TEXT NOT NULL,
  "manifest_hash" CHAR(64) NOT NULL,
  "source_bundle_id" UUID,
  "validation_policy_hash" CHAR(64) NOT NULL,
  "validation_state" "ContentSnapshotValidationState" NOT NULL DEFAULT 'MATERIALIZING',
  "artifact_count" INTEGER NOT NULL,
  "total_byte_length" BIGINT NOT NULL,
  "verified_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_snapshots_manifest_hash_shape_check"
    CHECK ("manifest_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "content_snapshots_validation_policy_hash_check"
    CHECK ("validation_policy_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "content_snapshots_counts_check"
    CHECK ("artifact_count" >= 0 AND "total_byte_length" >= 0),
  CONSTRAINT "content_snapshots_parent_not_self_check"
    CHECK ("parent_snapshot_id" IS NULL OR "parent_snapshot_id" <> "id")
);

CREATE TABLE "content_snapshot_artifacts" (
  "snapshot_id" UUID NOT NULL,
  "artifact_id" UUID NOT NULL,
  "logical_id" VARCHAR(200) NOT NULL,
  "canonical_path" VARCHAR(500) NOT NULL,
  "artifact_type" "ArtifactType" NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "byte_length" INTEGER NOT NULL,
  CONSTRAINT "content_snapshot_artifacts_pkey" PRIMARY KEY ("snapshot_id", "artifact_id"),
  CONSTRAINT "content_snapshot_artifacts_content_hash_check"
    CHECK ("content_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "content_snapshot_artifacts_byte_length_check"
    CHECK ("byte_length" >= 0),
  CONSTRAINT "content_snapshot_artifacts_path_check"
    CHECK (
      "canonical_path" = btrim("canonical_path")
      AND "canonical_path" !~ '(^|/)\.\.(/|$)'
      AND "canonical_path" !~ '^/'
      AND "canonical_path" !~ E'\\\\'
    )
);

CREATE TABLE "content_snapshot_edges" (
  "id" UUID NOT NULL,
  "snapshot_id" UUID NOT NULL,
  "source_artifact_id" UUID NOT NULL,
  "target_artifact_id" UUID NOT NULL,
  "edge_type" "ArtifactEdgeType" NOT NULL,
  "evidence" VARCHAR(500) NOT NULL,
  CONSTRAINT "content_snapshot_edges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_snapshot_edges_no_self_check"
    CHECK ("source_artifact_id" <> "target_artifact_id"),
  CONSTRAINT "content_snapshot_edges_evidence_check"
    CHECK (char_length(btrim("evidence")) BETWEEN 1 AND 500)
);

CREATE TABLE "publication_targets" (
  "id" UUID NOT NULL,
  "code" VARCHAR(50) NOT NULL,
  "official_snapshot_id" UUID,
  "candidate_snapshot_id" UUID,
  "candidate_publication_request_id" UUID,
  "candidate_rollback_request_id" UUID,
  "current_database_publication_id" UUID,
  "generation" BIGINT NOT NULL DEFAULT 0,
  "bootstrapped_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "publication_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_targets_code_check"
    CHECK ("code" ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'),
  CONSTRAINT "publication_targets_generation_check" CHECK ("generation" >= 0),
  CONSTRAINT "publication_targets_bootstrap_official_check"
    CHECK ("bootstrapped_at" IS NULL OR "official_snapshot_id" IS NOT NULL),
  CONSTRAINT "publication_targets_candidate_identity_check"
    CHECK (
      ("candidate_snapshot_id" IS NULL
        AND "candidate_publication_request_id" IS NULL
        AND "candidate_rollback_request_id" IS NULL)
      OR
      ("candidate_snapshot_id" IS NOT NULL
        AND num_nonnulls(
          "candidate_publication_request_id",
          "candidate_rollback_request_id"
        ) = 1)
    ),
  CONSTRAINT "publication_targets_candidate_differs_check"
    CHECK (
      "candidate_snapshot_id" IS NULL
      OR "candidate_snapshot_id" IS DISTINCT FROM "official_snapshot_id"
    )
);

CREATE TABLE "database_publications" (
  "id" UUID NOT NULL,
  "publication_uuid" UUID NOT NULL,
  "publication_request_id" UUID,
  "rollback_request_id" UUID,
  "target_id" UUID NOT NULL,
  "bundle_id" UUID,
  "approval_id" UUID,
  "candidate_snapshot_id" UUID,
  "previous_official_snapshot_id" UUID NOT NULL,
  "resulting_official_snapshot_id" UUID,
  "publisher_identity_id" UUID NOT NULL,
  "confirmation_id" UUID,
  "health_receipt_id" UUID,
  "state" "PublicationSagaState" NOT NULL DEFAULT 'REQUESTED',
  "terminal_outcome" "DatabasePublicationOutcome",
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "database_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "database_publications_request_kind_check"
    CHECK (
      ("publication_request_id" IS NOT NULL
        AND "rollback_request_id" IS NULL
        AND "bundle_id" IS NOT NULL
        AND "approval_id" IS NOT NULL)
      OR
      ("publication_request_id" IS NULL
        AND "rollback_request_id" IS NOT NULL
        AND "bundle_id" IS NULL
        AND "approval_id" IS NULL)
    ),
  CONSTRAINT "database_publications_result_check"
    CHECK (
      "resulting_official_snapshot_id" IS NULL
      OR ("candidate_snapshot_id" IS NOT NULL
        AND "resulting_official_snapshot_id" = "candidate_snapshot_id")
    ),
  CONSTRAINT "database_publications_distinct_base_check"
    CHECK (
      "candidate_snapshot_id" IS NULL
      OR "candidate_snapshot_id" <> "previous_official_snapshot_id"
    ),
  CONSTRAINT "database_publications_terminal_check"
    CHECK (
      ("terminal_outcome" IS NULL
        AND "state" NOT IN ('RECONCILED', 'AUTO_ROLLED_BACK'))
      OR
      ("terminal_outcome" = 'PUBLISHED' AND "state" = 'RECONCILED')
      OR
      ("terminal_outcome" = 'PREVIOUS_VERSION_RESTORED' AND "state" = 'AUTO_ROLLED_BACK')
      OR
      ("terminal_outcome" = 'FAILED_BEFORE_CONFIRMATION' AND "state" = 'FAILED_PREVIEW')
      OR
      ("terminal_outcome" = 'RECONCILIATION_REQUIRED' AND "state" = 'RECONCILIATION_REQUIRED')
    )
);

CREATE TABLE "publication_events" (
  "id" UUID NOT NULL,
  "publication_request_id" UUID,
  "rollback_request_id" UUID,
  "target_id" UUID NOT NULL,
  "sequence" BIGINT NOT NULL,
  "event_key" VARCHAR(120) NOT NULL,
  "event_type" VARCHAR(80) NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publication_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_events_one_request_check"
    CHECK (num_nonnulls("publication_request_id", "rollback_request_id") = 1),
  CONSTRAINT "publication_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "publication_events_key_check"
    CHECK ("event_key" ~ '^[a-z0-9]+(?:[._:-][a-z0-9]+)*$'),
  CONSTRAINT "publication_events_type_check"
    CHECK ("event_type" ~ '^[A-Z][A-Z0-9_]{1,79}$'),
  CONSTRAINT "publication_events_payload_check"
    CHECK (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 16384)
);

CREATE TABLE "publication_confirmations" (
  "id" UUID NOT NULL,
  "publication_request_id" UUID,
  "rollback_request_id" UUID,
  "target_id" UUID NOT NULL,
  "snapshot_id" UUID NOT NULL,
  "snapshot_hash" CHAR(64) NOT NULL,
  "approval_id" UUID,
  "confirmed_by_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "validation_policy_hash" CHAR(64) NOT NULL,
  "target_generation" BIGINT NOT NULL,
  "recent_authentication_at" TIMESTAMPTZ(3) NOT NULL,
  "confirmed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publication_confirmations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_confirmations_request_kind_check"
    CHECK (
      ("publication_request_id" IS NOT NULL
        AND "rollback_request_id" IS NULL
        AND "approval_id" IS NOT NULL)
      OR
      ("publication_request_id" IS NULL
        AND "rollback_request_id" IS NOT NULL
        AND "approval_id" IS NULL)
    ),
  CONSTRAINT "publication_confirmations_hash_check"
    CHECK (
      "snapshot_hash" ~ '^[a-f0-9]{64}$'
      AND "validation_policy_hash" ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "publication_confirmations_recent_auth_check"
    CHECK (
      "recent_authentication_at" <= "confirmed_at"
      AND "recent_authentication_at" >= "confirmed_at" - INTERVAL '15 minutes'
    )
);

CREATE TABLE "candidate_authorizations" (
  "id" UUID NOT NULL,
  "publication_request_id" UUID,
  "rollback_request_id" UUID,
  "target_id" UUID NOT NULL,
  "snapshot_id" UUID NOT NULL,
  "snapshot_hash" CHAR(64) NOT NULL,
  "reviewer_id" UUID NOT NULL,
  "exchange_token_hash" CHAR(64) NOT NULL,
  "cookie_token_hash" CHAR(64),
  "audience" VARCHAR(120) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "exchanged_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "candidate_authorizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "candidate_authorizations_one_request_check"
    CHECK (num_nonnulls("publication_request_id", "rollback_request_id") = 1),
  CONSTRAINT "candidate_authorizations_hash_check"
    CHECK (
      "snapshot_hash" ~ '^[a-f0-9]{64}$'
      AND "exchange_token_hash" ~ '^[a-f0-9]{64}$'
      AND ("cookie_token_hash" IS NULL OR "cookie_token_hash" ~ '^[a-f0-9]{64}$')
    ),
  CONSTRAINT "candidate_authorizations_expiry_check"
    CHECK (
      "expires_at" > "created_at"
      AND ("exchanged_at" IS NULL OR "exchanged_at" BETWEEN "created_at" AND "expires_at")
      AND ("revoked_at" IS NULL OR "revoked_at" >= "created_at")
    ),
  CONSTRAINT "candidate_authorizations_exchange_pair_check"
    CHECK (("cookie_token_hash" IS NULL) = ("exchanged_at" IS NULL)),
  CONSTRAINT "candidate_authorizations_audience_check"
    CHECK ("audience" ~ '^https://[a-z0-9.-]+(?::[0-9]+)?$')
);

CREATE TABLE "leadership_observation_receipts" (
  "id" UUID NOT NULL,
  "target_id" UUID NOT NULL,
  "database_publication_id" UUID,
  "snapshot_id" UUID NOT NULL,
  "snapshot_hash" CHAR(64) NOT NULL,
  "observation_kind" "LeadershipObservationKind" NOT NULL,
  "cache_source" "LeadershipCacheSource" NOT NULL,
  "health_result" "LeadershipHealthResult" NOT NULL,
  "application_release_identity" VARCHAR(200) NOT NULL,
  "route_probe_hash" CHAR(64) NOT NULL,
  "attestation_key_id" VARCHAR(100) NOT NULL,
  "receipt_digest" CHAR(64) NOT NULL,
  "observed_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "leadership_observation_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "leadership_observation_receipts_hash_check"
    CHECK (
      "snapshot_hash" ~ '^[a-f0-9]{64}$'
      AND "route_probe_hash" ~ '^[a-f0-9]{64}$'
      AND "receipt_digest" ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "leadership_observation_receipts_release_check"
    CHECK (char_length(btrim("application_release_identity")) BETWEEN 1 AND 200),
  CONSTRAINT "leadership_observation_receipts_key_check"
    CHECK ("attestation_key_id" ~ '^[a-zA-Z0-9._:-]{1,100}$')
);

CREATE UNIQUE INDEX "content_snapshots_manifest_hash_key"
  ON "content_snapshots"("manifest_hash");
CREATE INDEX "content_snapshots_parent_idx"
  ON "content_snapshots"("parent_snapshot_id");
CREATE INDEX "content_snapshots_validation_idx"
  ON "content_snapshots"("validation_state", "created_at");

CREATE UNIQUE INDEX "content_snapshot_artifacts_logical_id_key"
  ON "content_snapshot_artifacts"("snapshot_id", "logical_id");
CREATE UNIQUE INDEX "content_snapshot_artifacts_path_key"
  ON "content_snapshot_artifacts"("snapshot_id", "canonical_path");
CREATE INDEX "content_snapshot_artifacts_type_idx"
  ON "content_snapshot_artifacts"("snapshot_id", "artifact_type");

CREATE UNIQUE INDEX "content_snapshot_edges_identity_key"
  ON "content_snapshot_edges"(
    "snapshot_id", "source_artifact_id", "target_artifact_id", "edge_type"
  );
CREATE INDEX "content_snapshot_edges_target_idx"
  ON "content_snapshot_edges"("snapshot_id", "target_artifact_id", "edge_type");

CREATE UNIQUE INDEX "publication_targets_code_key"
  ON "publication_targets"("code");
CREATE UNIQUE INDEX "publication_targets_candidate_publication_request_id_key"
  ON "publication_targets"("candidate_publication_request_id");
CREATE UNIQUE INDEX "publication_targets_candidate_rollback_request_id_key"
  ON "publication_targets"("candidate_rollback_request_id");

CREATE UNIQUE INDEX "database_publications_publication_uuid_key"
  ON "database_publications"("publication_uuid");
CREATE UNIQUE INDEX "database_publications_publication_request_id_key"
  ON "database_publications"("publication_request_id");
CREATE UNIQUE INDEX "database_publications_rollback_request_id_key"
  ON "database_publications"("rollback_request_id");
CREATE UNIQUE INDEX "database_publications_confirmation_id_key"
  ON "database_publications"("confirmation_id");
CREATE UNIQUE INDEX "database_publications_health_receipt_id_key"
  ON "database_publications"("health_receipt_id");
CREATE INDEX "database_publications_target_state_idx"
  ON "database_publications"("target_id", "state");
CREATE INDEX "database_publications_created_idx"
  ON "database_publications"("created_at");

CREATE UNIQUE INDEX "publication_events_request_sequence_key"
  ON "publication_events"("publication_request_id", "sequence");
CREATE UNIQUE INDEX "publication_events_request_event_key"
  ON "publication_events"("publication_request_id", "event_key");
CREATE UNIQUE INDEX "publication_events_rollback_sequence_key"
  ON "publication_events"("rollback_request_id", "sequence");
CREATE UNIQUE INDEX "publication_events_rollback_event_key"
  ON "publication_events"("rollback_request_id", "event_key");
CREATE INDEX "publication_events_target_created_idx"
  ON "publication_events"("target_id", "created_at");

CREATE UNIQUE INDEX "publication_confirmations_publication_request_key"
  ON "publication_confirmations"("publication_request_id");
CREATE UNIQUE INDEX "publication_confirmations_rollback_request_key"
  ON "publication_confirmations"("rollback_request_id");
CREATE INDEX "publication_confirmations_target_idx"
  ON "publication_confirmations"("target_id", "confirmed_at");

CREATE UNIQUE INDEX "candidate_authorizations_exchange_token_hash_key"
  ON "candidate_authorizations"("exchange_token_hash");
CREATE UNIQUE INDEX "candidate_authorizations_cookie_token_hash_key"
  ON "candidate_authorizations"("cookie_token_hash");
CREATE INDEX "candidate_authorizations_lookup_idx"
  ON "candidate_authorizations"("target_id", "snapshot_id", "expires_at");
CREATE INDEX "candidate_authorizations_reviewer_idx"
  ON "candidate_authorizations"("reviewer_id", "expires_at");

CREATE UNIQUE INDEX "leadership_observation_receipts_receipt_digest_key"
  ON "leadership_observation_receipts"("receipt_digest");
CREATE INDEX "leadership_observations_snapshot_idx"
  ON "leadership_observation_receipts"("target_id", "snapshot_id", "observed_at");
CREATE INDEX "leadership_observations_publication_idx"
  ON "leadership_observation_receipts"(
    "database_publication_id", "observation_kind", "health_result"
  );

ALTER TABLE "content_snapshots"
  ADD CONSTRAINT "content_snapshots_parent_snapshot_id_fkey"
    FOREIGN KEY ("parent_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "content_snapshots_source_bundle_id_fkey"
    FOREIGN KEY ("source_bundle_id") REFERENCES "proposed_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "content_snapshot_artifacts"
  ADD CONSTRAINT "content_snapshot_artifacts_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "content_snapshot_artifacts_artifact_id_fkey"
    FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "content_snapshot_artifacts_content_hash_fkey"
    FOREIGN KEY ("content_hash") REFERENCES "content_blobs"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "content_snapshot_edges"
  ADD CONSTRAINT "content_snapshot_edges_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "content_snapshot_edges_snapshot_id_source_artifact_id_fkey"
    FOREIGN KEY ("snapshot_id", "source_artifact_id")
    REFERENCES "content_snapshot_artifacts"("snapshot_id", "artifact_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "content_snapshot_edges_snapshot_id_target_artifact_id_fkey"
    FOREIGN KEY ("snapshot_id", "target_artifact_id")
    REFERENCES "content_snapshot_artifacts"("snapshot_id", "artifact_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publication_targets"
  ADD CONSTRAINT "publication_targets_official_snapshot_id_fkey"
    FOREIGN KEY ("official_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_targets_candidate_snapshot_id_fkey"
    FOREIGN KEY ("candidate_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_targets_candidate_publication_request_id_fkey"
    FOREIGN KEY ("candidate_publication_request_id") REFERENCES "publication_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_targets_candidate_rollback_request_id_fkey"
    FOREIGN KEY ("candidate_rollback_request_id") REFERENCES "rollback_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "database_publications"
  ADD CONSTRAINT "database_publications_publication_request_id_fkey"
    FOREIGN KEY ("publication_request_id") REFERENCES "publication_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "database_publications_rollback_request_id_fkey"
    FOREIGN KEY ("rollback_request_id") REFERENCES "rollback_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "database_publications_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "publication_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "database_publications_bundle_id_fkey"
    FOREIGN KEY ("bundle_id") REFERENCES "proposed_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "database_publications_approval_id_fkey"
    FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "database_publications_candidate_snapshot_id_fkey"
    FOREIGN KEY ("candidate_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "database_publications_previous_official_snapshot_id_fkey"
    FOREIGN KEY ("previous_official_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "database_publications_resulting_official_snapshot_id_fkey"
    FOREIGN KEY ("resulting_official_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "database_publications_publisher_identity_id_fkey"
    FOREIGN KEY ("publisher_identity_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publication_events"
  ADD CONSTRAINT "publication_events_publication_request_id_fkey"
    FOREIGN KEY ("publication_request_id") REFERENCES "publication_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_events_rollback_request_id_fkey"
    FOREIGN KEY ("rollback_request_id") REFERENCES "rollback_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_events_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "publication_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publication_confirmations"
  ADD CONSTRAINT "publication_confirmations_publication_request_id_fkey"
    FOREIGN KEY ("publication_request_id") REFERENCES "publication_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_confirmations_rollback_request_id_fkey"
    FOREIGN KEY ("rollback_request_id") REFERENCES "rollback_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_confirmations_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "publication_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_confirmations_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_confirmations_approval_id_fkey"
    FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_confirmations_confirmed_by_id_fkey"
    FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_confirmations_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "candidate_authorizations"
  ADD CONSTRAINT "candidate_authorizations_publication_request_id_fkey"
    FOREIGN KEY ("publication_request_id") REFERENCES "publication_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "candidate_authorizations_rollback_request_id_fkey"
    FOREIGN KEY ("rollback_request_id") REFERENCES "rollback_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "candidate_authorizations_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "publication_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "candidate_authorizations_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "candidate_authorizations_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "leadership_observation_receipts"
  ADD CONSTRAINT "leadership_observation_receipts_target_id_fkey"
    FOREIGN KEY ("target_id") REFERENCES "publication_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "leadership_observation_receipts_database_publication_id_fkey"
    FOREIGN KEY ("database_publication_id") REFERENCES "database_publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "leadership_observation_receipts_snapshot_id_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "database_publications"
  ADD CONSTRAINT "database_publications_confirmation_id_fkey"
    FOREIGN KEY ("confirmation_id") REFERENCES "publication_confirmations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "database_publications_health_receipt_id_fkey"
    FOREIGN KEY ("health_receipt_id") REFERENCES "leadership_observation_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publication_targets"
  ADD CONSTRAINT "publication_targets_current_database_publication_id_fkey"
    FOREIGN KEY ("current_database_publication_id") REFERENCES "database_publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "proposed_bundles"
  ADD CONSTRAINT "proposed_bundles_base_content_snapshot_id_fkey"
    FOREIGN KEY ("base_content_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "approvals"
  ADD CONSTRAINT "approvals_base_content_snapshot_id_fkey"
    FOREIGN KEY ("base_content_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "approvals_base_content_snapshot_pair_check"
    CHECK (("base_content_snapshot_id" IS NULL) = ("base_content_snapshot_hash" IS NULL)),
  ADD CONSTRAINT "approvals_base_content_snapshot_hash_check"
    CHECK ("base_content_snapshot_hash" IS NULL OR "base_content_snapshot_hash" ~ '^[a-f0-9]{64}$');

ALTER TABLE "publication_requests"
  ADD CONSTRAINT "publication_requests_publication_target_id_fkey"
    FOREIGN KEY ("publication_target_id") REFERENCES "publication_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_requests_base_content_snapshot_id_fkey"
    FOREIGN KEY ("base_content_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_requests_candidate_content_snapshot_id_fkey"
    FOREIGN KEY ("candidate_content_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_requests_base_content_snapshot_pair_check"
    CHECK (("base_content_snapshot_id" IS NULL) = ("base_content_snapshot_hash" IS NULL)),
  ADD CONSTRAINT "publication_requests_candidate_content_snapshot_pair_check"
    CHECK (("candidate_content_snapshot_id" IS NULL) = ("candidate_content_snapshot_hash" IS NULL)),
  ADD CONSTRAINT "publication_requests_content_snapshot_hash_check"
    CHECK (
      ("base_content_snapshot_hash" IS NULL OR "base_content_snapshot_hash" ~ '^[a-f0-9]{64}$')
      AND ("candidate_content_snapshot_hash" IS NULL OR "candidate_content_snapshot_hash" ~ '^[a-f0-9]{64}$')
    );

ALTER TABLE "publications"
  ADD CONSTRAINT "publications_content_snapshot_id_fkey"
    FOREIGN KEY ("content_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rollback_requests"
  ADD CONSTRAINT "rollback_requests_publication_target_id_fkey"
    FOREIGN KEY ("publication_target_id") REFERENCES "publication_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "rollback_requests_target_content_snapshot_id_fkey"
    FOREIGN KEY ("target_content_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "rollback_requests_target_content_snapshot_pair_check"
    CHECK (("target_content_snapshot_id" IS NULL) = ("target_content_snapshot_hash" IS NULL)),
  ADD CONSTRAINT "rollback_requests_target_content_snapshot_hash_check"
    CHECK ("target_content_snapshot_hash" IS NULL OR "target_content_snapshot_hash" ~ '^[a-f0-9]{64}$');

-- Existing blobs are verified during Checkpoint 2 backfill; NOT VALID makes
-- this expansion safe while enforcing exact bytes for every new row.
ALTER TABLE "content_blobs"
  ADD CONSTRAINT "content_blobs_exact_byte_length_check"
    CHECK ("byte_length" = octet_length(convert_to("body", 'UTF8'))) NOT VALID,
  ADD CONSTRAINT "content_blobs_digest_matches_check"
    CHECK (
      "hash" = encode(digest(convert_to("body", 'UTF8'), 'sha256'), 'hex')
    ) NOT VALID;

CREATE OR REPLACE FUNCTION protect_content_blob_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'content_blobs are immutable';
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'content_blobs are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "content_blobs_immutable"
  BEFORE UPDATE OR DELETE ON "content_blobs"
  FOR EACH ROW EXECUTE FUNCTION protect_content_blob_immutability();

CREATE OR REPLACE FUNCTION protect_content_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_count bigint;
  actual_bytes bigint;
  manifest_json jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'content_snapshots are immutable';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."validation_state" <> 'MATERIALIZING' OR NEW."verified_at" IS NOT NULL THEN
      RAISE EXCEPTION 'new content snapshots must begin MATERIALIZING';
    END IF;
    BEGIN
      manifest_json := NEW."manifest"::jsonb;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'content snapshot manifest is not valid JSON';
    END;
    IF jsonb_typeof(manifest_json) <> 'object' THEN
      RAISE EXCEPTION 'content snapshot manifest must be a JSON object';
    END IF;
    IF encode(digest(convert_to(NEW."manifest", 'UTF8'), 'sha256'), 'hex') <> NEW."manifest_hash" THEN
      RAISE EXCEPTION 'content snapshot manifest hash mismatch';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
    OR NEW."parent_snapshot_id" IS DISTINCT FROM OLD."parent_snapshot_id"
    OR NEW."manifest" <> OLD."manifest"
    OR NEW."manifest_hash" <> OLD."manifest_hash"
    OR NEW."source_bundle_id" IS DISTINCT FROM OLD."source_bundle_id"
    OR NEW."validation_policy_hash" <> OLD."validation_policy_hash"
    OR NEW."artifact_count" <> OLD."artifact_count"
    OR NEW."total_byte_length" <> OLD."total_byte_length"
    OR NEW."created_at" <> OLD."created_at"
  THEN
    RAISE EXCEPTION 'content snapshot identity is immutable';
  END IF;

  IF OLD."validation_state" <> 'MATERIALIZING' THEN
    RAISE EXCEPTION 'finalized content snapshots are immutable';
  END IF;
  IF NEW."validation_state" NOT IN ('VALIDATED', 'REJECTED') THEN
    RAISE EXCEPTION 'invalid content snapshot validation transition';
  END IF;

  IF NEW."validation_state" = 'VALIDATED' THEN
    IF NEW."verified_at" IS NULL THEN
      RAISE EXCEPTION 'validated content snapshot requires verified_at';
    END IF;
    SELECT count(*), COALESCE(sum("byte_length"), 0)
      INTO actual_count, actual_bytes
      FROM "content_snapshot_artifacts"
      WHERE "snapshot_id" = NEW."id";
    IF actual_count <> NEW."artifact_count" OR actual_bytes <> NEW."total_byte_length" THEN
      RAISE EXCEPTION 'content snapshot manifest totals do not match membership';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "content_snapshot_artifacts" member
      JOIN "content_blobs" blob ON blob."hash" = member."content_hash"
      WHERE member."snapshot_id" = NEW."id"
        AND (
          member."byte_length" <> blob."byte_length"
          OR blob."byte_length" <> octet_length(convert_to(blob."body", 'UTF8'))
          OR blob."hash" <> encode(digest(convert_to(blob."body", 'UTF8'), 'sha256'), 'hex')
        )
    ) THEN
      RAISE EXCEPTION 'content snapshot contains an invalid content blob';
    END IF;
  ELSIF NEW."verified_at" IS NOT NULL THEN
    RAISE EXCEPTION 'rejected content snapshot cannot be verified';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "content_snapshots_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "content_snapshots"
  FOR EACH ROW EXECUTE FUNCTION protect_content_snapshot();

CREATE OR REPLACE FUNCTION protect_content_snapshot_artifact()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot_state "ContentSnapshotValidationState";
  expected_artifact record;
  expected_blob record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'content snapshot artifacts are immutable';
  END IF;
  SELECT "validation_state" INTO snapshot_state
    FROM "content_snapshots" WHERE "id" = NEW."snapshot_id" FOR KEY SHARE;
  IF snapshot_state IS DISTINCT FROM 'MATERIALIZING' THEN
    RAISE EXCEPTION 'content snapshot membership is finalized';
  END IF;
  SELECT "logical_id", "canonical_path", "type"
    INTO expected_artifact
    FROM "artifacts" WHERE "id" = NEW."artifact_id" FOR KEY SHARE;
  IF NOT FOUND
    OR expected_artifact."logical_id" <> NEW."logical_id"
    OR expected_artifact."canonical_path" <> NEW."canonical_path"
    OR expected_artifact."type" <> NEW."artifact_type"
  THEN
    RAISE EXCEPTION 'snapshot artifact identity does not match managed artifact';
  END IF;
  SELECT "byte_length", "body" INTO expected_blob
    FROM "content_blobs" WHERE "hash" = NEW."content_hash" FOR KEY SHARE;
  IF NOT FOUND
    OR expected_blob."byte_length" <> NEW."byte_length"
    OR NEW."byte_length" <> octet_length(convert_to(expected_blob."body", 'UTF8'))
    OR NEW."content_hash" <> encode(digest(convert_to(expected_blob."body", 'UTF8'), 'sha256'), 'hex')
  THEN
    RAISE EXCEPTION 'snapshot artifact content does not match immutable blob';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "content_snapshot_artifacts_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "content_snapshot_artifacts"
  FOR EACH ROW EXECUTE FUNCTION protect_content_snapshot_artifact();

CREATE OR REPLACE FUNCTION protect_content_snapshot_edge()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot_state "ContentSnapshotValidationState";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'content snapshot edges are immutable';
  END IF;
  SELECT "validation_state" INTO snapshot_state
    FROM "content_snapshots" WHERE "id" = NEW."snapshot_id" FOR KEY SHARE;
  IF snapshot_state IS DISTINCT FROM 'MATERIALIZING' THEN
    RAISE EXCEPTION 'content snapshot graph is finalized';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "content_snapshot_edges_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "content_snapshot_edges"
  FOR EACH ROW EXECUTE FUNCTION protect_content_snapshot_edge();

CREATE OR REPLACE FUNCTION protect_approval_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approvals are append-only'; END IF;
  IF NEW."id" <> OLD."id"
    OR NEW."bundle_id" <> OLD."bundle_id"
    OR NEW."bundle_hash" <> OLD."bundle_hash"
    OR NEW."base_commit" <> OLD."base_commit"
    OR NEW."base_content_snapshot_id" IS DISTINCT FROM OLD."base_content_snapshot_id"
    OR NEW."base_content_snapshot_hash" IS DISTINCT FROM OLD."base_content_snapshot_hash"
    OR NEW."validation_policy_hash" <> OLD."validation_policy_hash"
    OR NEW."approved_by_id" <> OLD."approved_by_id"
    OR NEW."repository_reviewer_id" IS DISTINCT FROM OLD."repository_reviewer_id"
    OR NEW."content_review_date" IS DISTINCT FROM OLD."content_review_date"
    OR NEW."session_id" <> OLD."session_id"
    OR NEW."permission_snapshot" <> OLD."permission_snapshot"
    OR NEW."approved_at" <> OLD."approved_at"
  THEN RAISE EXCEPTION 'approval evidence is immutable'; END IF;
  IF OLD."invalidated_at" IS NOT NULL AND (
    NEW."invalidated_at" IS DISTINCT FROM OLD."invalidated_at"
    OR NEW."invalidation_reason" IS DISTINCT FROM OLD."invalidation_reason"
  ) THEN RAISE EXCEPTION 'approval invalidation is immutable once recorded'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_publication_request_snapshot_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."publication_target_id" IS DISTINCT FROM OLD."publication_target_id"
    AND OLD."publication_target_id" IS NOT NULL
  THEN RAISE EXCEPTION 'publication target identity is immutable once set'; END IF;
  IF NEW."base_content_snapshot_id" IS DISTINCT FROM OLD."base_content_snapshot_id"
    AND OLD."base_content_snapshot_id" IS NOT NULL
  THEN RAISE EXCEPTION 'publication base snapshot is immutable once set'; END IF;
  IF NEW."base_content_snapshot_hash" IS DISTINCT FROM OLD."base_content_snapshot_hash"
    AND OLD."base_content_snapshot_hash" IS NOT NULL
  THEN RAISE EXCEPTION 'publication base snapshot hash is immutable once set'; END IF;
  IF NEW."candidate_content_snapshot_id" IS DISTINCT FROM OLD."candidate_content_snapshot_id"
    AND OLD."candidate_content_snapshot_id" IS NOT NULL
  THEN RAISE EXCEPTION 'publication candidate snapshot is immutable once set'; END IF;
  IF NEW."candidate_content_snapshot_hash" IS DISTINCT FROM OLD."candidate_content_snapshot_hash"
    AND OLD."candidate_content_snapshot_hash" IS NOT NULL
  THEN RAISE EXCEPTION 'publication candidate snapshot hash is immutable once set'; END IF;
  IF NEW."target_generation" IS DISTINCT FROM OLD."target_generation"
    AND OLD."target_generation" IS NOT NULL
  THEN RAISE EXCEPTION 'publication target generation is immutable once set'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "publication_requests_snapshot_identity"
  BEFORE UPDATE ON "publication_requests"
  FOR EACH ROW EXECUTE FUNCTION protect_publication_request_snapshot_identity();

CREATE OR REPLACE FUNCTION protect_database_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  publisher_type "IdentityType";
  prior_target record;
  matching_receipt boolean;
  matching_confirmation boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'database publications cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'REQUESTED'
      OR NEW."candidate_snapshot_id" IS NOT NULL
      OR NEW."resulting_official_snapshot_id" IS NOT NULL
      OR NEW."confirmation_id" IS NOT NULL
      OR NEW."health_receipt_id" IS NOT NULL
      OR NEW."terminal_outcome" IS NOT NULL
    THEN
      RAISE EXCEPTION 'database publication must begin REQUESTED without derived evidence';
    END IF;
    SELECT "identity_type" INTO publisher_type
      FROM "users" WHERE "id" = NEW."publisher_identity_id" FOR KEY SHARE;
    IF publisher_type IS NULL OR publisher_type = 'AI' THEN
      RAISE EXCEPTION 'AI identities cannot publish content';
    END IF;
    SELECT "official_snapshot_id", "bootstrapped_at" INTO prior_target
      FROM "publication_targets" WHERE "id" = NEW."target_id" FOR KEY SHARE;
    IF prior_target."bootstrapped_at" IS NULL
      OR prior_target."official_snapshot_id" IS DISTINCT FROM NEW."previous_official_snapshot_id"
    THEN
      RAISE EXCEPTION 'database publication base is not the official snapshot';
    END IF;
    IF NEW."publication_request_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM "publication_requests" request
      JOIN "approvals" approval ON approval."id" = NEW."approval_id"
      WHERE request."id" = NEW."publication_request_id"
        AND request."publication_target_id" = NEW."target_id"
        AND request."bundle_id" = NEW."bundle_id"
        AND request."approval_id" = NEW."approval_id"
        AND request."base_content_snapshot_id" = NEW."previous_official_snapshot_id"
        AND request."base_content_snapshot_hash" = (
          SELECT "manifest_hash" FROM "content_snapshots"
          WHERE "id" = NEW."previous_official_snapshot_id"
        )
        AND approval."bundle_id" = NEW."bundle_id"
        AND approval."bundle_hash" = request."bundle_hash"
        AND approval."base_content_snapshot_id" = NEW."previous_official_snapshot_id"
        AND approval."base_content_snapshot_hash" = request."base_content_snapshot_hash"
        AND approval."invalidated_at" IS NULL
    ) THEN
      RAISE EXCEPTION 'database publication request, bundle, approval, and base do not match';
    END IF;
    IF NEW."rollback_request_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "rollback_requests" request
      WHERE request."id" = NEW."rollback_request_id"
        AND request."publication_target_id" = NEW."target_id"
        AND request."expected_current_publication_id" IS NOT NULL
        AND request."target_content_snapshot_id" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'database rollback request and target do not match';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
    OR NEW."publication_uuid" <> OLD."publication_uuid"
    OR NEW."publication_request_id" IS DISTINCT FROM OLD."publication_request_id"
    OR NEW."rollback_request_id" IS DISTINCT FROM OLD."rollback_request_id"
    OR NEW."target_id" <> OLD."target_id"
    OR NEW."bundle_id" IS DISTINCT FROM OLD."bundle_id"
    OR NEW."approval_id" IS DISTINCT FROM OLD."approval_id"
    OR NEW."previous_official_snapshot_id" <> OLD."previous_official_snapshot_id"
    OR NEW."publisher_identity_id" <> OLD."publisher_identity_id"
    OR NEW."created_at" <> OLD."created_at"
  THEN
    RAISE EXCEPTION 'database publication identity is immutable';
  END IF;
  IF OLD."candidate_snapshot_id" IS NOT NULL
    AND NEW."candidate_snapshot_id" IS DISTINCT FROM OLD."candidate_snapshot_id"
  THEN RAISE EXCEPTION 'database publication candidate is immutable once set'; END IF;
  IF OLD."resulting_official_snapshot_id" IS NOT NULL
    AND NEW."resulting_official_snapshot_id" IS DISTINCT FROM OLD."resulting_official_snapshot_id"
  THEN RAISE EXCEPTION 'database publication result is immutable once set'; END IF;
  IF OLD."confirmation_id" IS NOT NULL
    AND NEW."confirmation_id" IS DISTINCT FROM OLD."confirmation_id"
  THEN RAISE EXCEPTION 'database publication confirmation is immutable once set'; END IF;
  IF OLD."health_receipt_id" IS NOT NULL
    AND NEW."health_receipt_id" IS DISTINCT FROM OLD."health_receipt_id"
  THEN RAISE EXCEPTION 'database publication health receipt is immutable once set'; END IF;
  IF OLD."terminal_outcome" IS NOT NULL
    AND NEW."terminal_outcome" IS DISTINCT FROM OLD."terminal_outcome"
  THEN RAISE EXCEPTION 'database publication terminal outcome is immutable once set'; END IF;

  IF NOT (
    (OLD."state" = 'REQUESTED' AND NEW."state" IN ('SNAPSHOT_MATERIALIZED', 'FAILED_PREVIEW'))
    OR (OLD."state" = 'SNAPSHOT_MATERIALIZED' AND NEW."state" IN ('SNAPSHOT_VALIDATED', 'FAILED_PREVIEW'))
    OR (OLD."state" = 'SNAPSHOT_VALIDATED' AND NEW."state" IN ('CANDIDATE_AVAILABLE', 'FAILED_PREVIEW'))
    OR (OLD."state" = 'CANDIDATE_AVAILABLE' AND NEW."state" IN ('CANDIDATE_VERIFIED', 'FAILED_PREVIEW'))
    OR (OLD."state" = 'CANDIDATE_VERIFIED' AND NEW."state" IN ('AWAITING_CONFIRMATION', 'FAILED_PREVIEW'))
    OR (OLD."state" = 'AWAITING_CONFIRMATION' AND NEW."state" IN ('OFFICIAL_POINTER_COMMITTED', 'FAILED_PREVIEW'))
    OR (OLD."state" = 'OFFICIAL_POINTER_COMMITTED' AND NEW."state" IN ('LIVE_VERIFIED', 'RESTORING_PREVIOUS', 'RECONCILIATION_REQUIRED'))
    OR (OLD."state" = 'LIVE_VERIFIED' AND NEW."state" IN ('RECONCILED', 'RESTORING_PREVIOUS', 'RECONCILIATION_REQUIRED'))
    OR (OLD."state" = 'RESTORING_PREVIOUS' AND NEW."state" IN ('AUTO_ROLLED_BACK', 'RECONCILIATION_REQUIRED'))
    OR (OLD."state" = NEW."state")
  ) THEN
    RAISE EXCEPTION 'invalid database publication transition from % to %', OLD."state", NEW."state";
  END IF;

  IF NEW."state" = 'SNAPSHOT_MATERIALIZED' THEN
    IF OLD."candidate_snapshot_id" IS NOT NULL
      OR NEW."candidate_snapshot_id" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "content_snapshots"
        WHERE "id" = NEW."candidate_snapshot_id"
          AND "validation_state" = 'MATERIALIZING'
      )
    THEN RAISE EXCEPTION 'materialized publication requires a new materializing snapshot'; END IF;
  ELSIF NEW."candidate_snapshot_id" IS NULL
    AND NEW."state" NOT IN ('REQUESTED', 'FAILED_PREVIEW')
  THEN
    RAISE EXCEPTION 'publication state requires a candidate snapshot';
  END IF;

  IF NEW."state" IN (
    'SNAPSHOT_VALIDATED', 'CANDIDATE_AVAILABLE', 'CANDIDATE_VERIFIED',
    'AWAITING_CONFIRMATION', 'OFFICIAL_POINTER_COMMITTED', 'LIVE_VERIFIED',
    'RECONCILED', 'RESTORING_PREVIOUS', 'AUTO_ROLLED_BACK'
  ) AND NOT EXISTS (
    SELECT 1 FROM "content_snapshots"
    WHERE "id" = NEW."candidate_snapshot_id" AND "validation_state" = 'VALIDATED'
  ) THEN
    RAISE EXCEPTION 'publication candidate snapshot is not validated';
  END IF;

  IF NEW."state" = 'CANDIDATE_VERIFIED' AND OLD."state" <> NEW."state" THEN
    SELECT EXISTS (
      SELECT 1 FROM "leadership_observation_receipts"
      WHERE "database_publication_id" = NEW."id"
        AND "snapshot_id" = NEW."candidate_snapshot_id"
        AND "observation_kind" = 'CANDIDATE'
        AND "health_result" = 'HEALTHY'
    ) INTO matching_receipt;
    IF NOT matching_receipt THEN
      RAISE EXCEPTION 'candidate verification requires a matching Leadership receipt';
    END IF;
  END IF;

  IF NEW."state" = 'OFFICIAL_POINTER_COMMITTED' AND OLD."state" <> NEW."state" THEN
    SELECT EXISTS (
      SELECT 1 FROM "publication_confirmations" confirmation
      WHERE confirmation."id" = NEW."confirmation_id"
        AND confirmation."target_id" = NEW."target_id"
        AND confirmation."snapshot_id" = NEW."candidate_snapshot_id"
        AND confirmation."snapshot_hash" = (
          SELECT "manifest_hash" FROM "content_snapshots"
          WHERE "id" = NEW."candidate_snapshot_id"
        )
        AND confirmation."publication_request_id" IS NOT DISTINCT FROM NEW."publication_request_id"
        AND confirmation."rollback_request_id" IS NOT DISTINCT FROM NEW."rollback_request_id"
    ) INTO matching_confirmation;
    IF NOT matching_confirmation
      OR NEW."resulting_official_snapshot_id" IS DISTINCT FROM NEW."candidate_snapshot_id"
    THEN RAISE EXCEPTION 'official pointer commit requires the exact candidate confirmation'; END IF;
  END IF;

  IF NEW."state" = 'LIVE_VERIFIED' AND OLD."state" <> NEW."state" THEN
    SELECT EXISTS (
      SELECT 1 FROM "leadership_observation_receipts"
      WHERE "id" = NEW."health_receipt_id"
        AND "database_publication_id" = NEW."id"
        AND "snapshot_id" = NEW."resulting_official_snapshot_id"
        AND "observation_kind" = 'OFFICIAL'
        AND "health_result" = 'HEALTHY'
    ) INTO matching_receipt;
    IF NOT matching_receipt THEN
      RAISE EXCEPTION 'live verification requires a matching Leadership receipt';
    END IF;
  END IF;

  IF NEW."state" = 'RECONCILED' THEN
    IF OLD."state" <> 'LIVE_VERIFIED' OR NEW."terminal_outcome" <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'reconciliation requires a verified published outcome';
    END IF;
  ELSIF NEW."state" = 'AUTO_ROLLED_BACK' THEN
    SELECT EXISTS (
      SELECT 1 FROM "leadership_observation_receipts"
      WHERE "id" = NEW."health_receipt_id"
        AND "database_publication_id" = NEW."id"
        AND "snapshot_id" = NEW."previous_official_snapshot_id"
        AND "observation_kind" = 'RESTORATION'
        AND "health_result" = 'HEALTHY'
    ) INTO matching_receipt;
    IF OLD."state" <> 'RESTORING_PREVIOUS'
      OR NEW."terminal_outcome" <> 'PREVIOUS_VERSION_RESTORED'
      OR NOT matching_receipt
    THEN RAISE EXCEPTION 'auto rollback requires a verified restoration receipt'; END IF;
  ELSIF NEW."state" = 'FAILED_PREVIEW'
    AND NEW."terminal_outcome" <> 'FAILED_BEFORE_CONFIRMATION'
  THEN RAISE EXCEPTION 'pre-confirmation failure requires a terminal outcome';
  ELSIF NEW."state" = 'RECONCILIATION_REQUIRED'
    AND NEW."terminal_outcome" <> 'RECONCILIATION_REQUIRED'
  THEN RAISE EXCEPTION 'reconciliation state requires a terminal outcome';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "database_publications_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "database_publications"
  FOR EACH ROW EXECUTE FUNCTION protect_database_publication();

CREATE OR REPLACE FUNCTION protect_publication_target()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  official_state "ContentSnapshotValidationState";
  candidate_state "ContentSnapshotValidationState";
  active_publication record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication targets cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."official_snapshot_id" IS NOT NULL
      OR NEW."candidate_snapshot_id" IS NOT NULL
      OR NEW."candidate_publication_request_id" IS NOT NULL
      OR NEW."candidate_rollback_request_id" IS NOT NULL
      OR NEW."current_database_publication_id" IS NOT NULL
      OR NEW."generation" <> 0
      OR NEW."bootstrapped_at" IS NOT NULL
    THEN RAISE EXCEPTION 'publication target must be bootstrapped by a fenced update'; END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id" OR NEW."code" <> OLD."code" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'publication target identity is immutable';
  END IF;
  IF NEW."generation" <> OLD."generation" + 1 THEN
    RAISE EXCEPTION 'publication target generation must increase by exactly one';
  END IF;

  IF OLD."bootstrapped_at" IS NULL THEN
    IF NEW."bootstrapped_at" IS NULL
      OR NEW."official_snapshot_id" IS NULL
      OR NEW."candidate_snapshot_id" IS NOT NULL
    THEN RAISE EXCEPTION 'publication target bootstrap requires one official snapshot'; END IF;
    SELECT "validation_state" INTO official_state
      FROM "content_snapshots" WHERE "id" = NEW."official_snapshot_id" FOR KEY SHARE;
    IF official_state IS DISTINCT FROM 'VALIDATED' THEN
      RAISE EXCEPTION 'official snapshot must be validated';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."bootstrapped_at" IS DISTINCT FROM OLD."bootstrapped_at"
    OR NEW."official_snapshot_id" IS NULL
  THEN RAISE EXCEPTION 'bootstrapped target and official pointer are permanent'; END IF;

  IF NEW."current_database_publication_id" IS NOT NULL THEN
    SELECT * INTO active_publication
      FROM "database_publications"
      WHERE "id" = NEW."current_database_publication_id" FOR KEY SHARE;
    IF NOT FOUND OR active_publication."target_id" <> NEW."id" THEN
      RAISE EXCEPTION 'current database publication does not belong to target';
    END IF;
  END IF;

  IF OLD."candidate_snapshot_id" IS NULL AND NEW."candidate_snapshot_id" IS NOT NULL THEN
    IF NEW."official_snapshot_id" IS DISTINCT FROM OLD."official_snapshot_id"
      OR active_publication."state" <> 'CANDIDATE_AVAILABLE'
      OR active_publication."candidate_snapshot_id" <> NEW."candidate_snapshot_id"
      OR active_publication."previous_official_snapshot_id" <> OLD."official_snapshot_id"
      OR active_publication."publication_request_id" IS DISTINCT FROM NEW."candidate_publication_request_id"
      OR active_publication."rollback_request_id" IS DISTINCT FROM NEW."candidate_rollback_request_id"
    THEN RAISE EXCEPTION 'candidate pointer does not match the active validated publication'; END IF;
    SELECT "validation_state" INTO candidate_state
      FROM "content_snapshots" WHERE "id" = NEW."candidate_snapshot_id" FOR KEY SHARE;
    IF candidate_state IS DISTINCT FROM 'VALIDATED' THEN
      RAISE EXCEPTION 'candidate snapshot must be validated';
    END IF;
  ELSIF OLD."candidate_snapshot_id" IS NOT NULL AND NEW."candidate_snapshot_id" IS NULL THEN
    IF NEW."official_snapshot_id" = OLD."official_snapshot_id" THEN
      IF active_publication."state" NOT IN ('FAILED_PREVIEW', 'RECONCILIATION_REQUIRED') THEN
        RAISE EXCEPTION 'candidate can only be cleared after a recorded failure';
      END IF;
    ELSIF NEW."official_snapshot_id" = OLD."candidate_snapshot_id" THEN
      IF active_publication."state" <> 'OFFICIAL_POINTER_COMMITTED'
        OR active_publication."resulting_official_snapshot_id" <> OLD."candidate_snapshot_id"
        OR active_publication."confirmation_id" IS NULL
      THEN RAISE EXCEPTION 'official pointer commit lacks exact confirmation evidence'; END IF;
    ELSE
      RAISE EXCEPTION 'candidate pointer cannot be cleared to an unrelated official snapshot';
    END IF;
  ELSIF OLD."candidate_snapshot_id" IS NOT NULL
    AND NEW."candidate_snapshot_id" IS DISTINCT FROM OLD."candidate_snapshot_id"
  THEN RAISE EXCEPTION 'active candidate cannot be replaced';
  END IF;

  IF OLD."candidate_snapshot_id" IS NULL
    AND NEW."official_snapshot_id" IS DISTINCT FROM OLD."official_snapshot_id"
  THEN
    IF active_publication."state" <> 'RESTORING_PREVIOUS'
      OR active_publication."candidate_snapshot_id" <> OLD."official_snapshot_id"
      OR active_publication."previous_official_snapshot_id" <> NEW."official_snapshot_id"
    THEN RAISE EXCEPTION 'official pointer can only restore the recorded previous snapshot'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "publication_targets_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "publication_targets"
  FOR EACH ROW EXECUTE FUNCTION protect_publication_target();

CREATE OR REPLACE FUNCTION protect_publication_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_type "IdentityType";
  actual_hash char(64);
  target_row record;
  publication_row record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'publication confirmations are append-only';
  END IF;
  SELECT "identity_type" INTO actor_type
    FROM "users" WHERE "id" = NEW."confirmed_by_id" FOR KEY SHARE;
  IF actor_type IS DISTINCT FROM 'HUMAN' THEN
    RAISE EXCEPTION 'only a human identity can confirm publication';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "sessions"
    WHERE "id" = NEW."session_id"
      AND "user_id" = NEW."confirmed_by_id"
      AND "revoked_at" IS NULL
      AND "idle_expires_at" > NEW."confirmed_at"
      AND "absolute_expires_at" > NEW."confirmed_at"
      AND "reauthenticated_at" = NEW."recent_authentication_at"
  ) THEN
    RAISE EXCEPTION 'publication confirmation requires the exact active reauthenticated session';
  END IF;
  SELECT "manifest_hash" INTO actual_hash
    FROM "content_snapshots"
    WHERE "id" = NEW."snapshot_id" AND "validation_state" = 'VALIDATED'
    FOR KEY SHARE;
  IF actual_hash IS DISTINCT FROM NEW."snapshot_hash" THEN
    RAISE EXCEPTION 'confirmation snapshot hash does not match validated candidate';
  END IF;
  SELECT * INTO target_row
    FROM "publication_targets" WHERE "id" = NEW."target_id" FOR UPDATE;
  IF target_row."candidate_snapshot_id" IS DISTINCT FROM NEW."snapshot_id"
    OR target_row."candidate_publication_request_id" IS DISTINCT FROM NEW."publication_request_id"
    OR target_row."candidate_rollback_request_id" IS DISTINCT FROM NEW."rollback_request_id"
    OR target_row."generation" <> NEW."target_generation"
  THEN RAISE EXCEPTION 'confirmation is not for the currently displayed candidate generation'; END IF;
  SELECT * INTO publication_row
    FROM "database_publications"
    WHERE "id" = target_row."current_database_publication_id" FOR KEY SHARE;
  IF publication_row."state" <> 'AWAITING_CONFIRMATION'
    OR publication_row."candidate_snapshot_id" <> NEW."snapshot_id"
    OR publication_row."publication_request_id" IS DISTINCT FROM NEW."publication_request_id"
    OR publication_row."rollback_request_id" IS DISTINCT FROM NEW."rollback_request_id"
  THEN RAISE EXCEPTION 'candidate is not awaiting exact confirmation'; END IF;
  IF NEW."publication_request_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "publication_requests" request
    JOIN "approvals" approval ON approval."id" = request."approval_id"
    WHERE request."id" = NEW."publication_request_id"
      AND request."approval_id" = NEW."approval_id"
      AND request."candidate_content_snapshot_id" = NEW."snapshot_id"
      AND request."candidate_content_snapshot_hash" = NEW."snapshot_hash"
      AND approval."validation_policy_hash" = NEW."validation_policy_hash"
      AND approval."invalidated_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'confirmation approval, policy, and candidate do not match';
  END IF;
  IF NEW."rollback_request_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "rollback_requests"
    WHERE "id" = NEW."rollback_request_id"
      AND "target_content_snapshot_id" = NEW."snapshot_id"
      AND "target_content_snapshot_hash" = NEW."snapshot_hash"
  ) THEN
    RAISE EXCEPTION 'rollback confirmation does not match selected snapshot';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "leadership_observation_receipts"
    WHERE "database_publication_id" = publication_row."id"
      AND "snapshot_id" = NEW."snapshot_id"
      AND "observation_kind" = 'CANDIDATE'
      AND "health_result" = 'HEALTHY'
  ) THEN
    RAISE EXCEPTION 'confirmation requires a matching private candidate observation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "publication_confirmations_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "publication_confirmations"
  FOR EACH ROW EXECUTE FUNCTION protect_publication_confirmation();

CREATE OR REPLACE FUNCTION protect_candidate_authorization()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_type "IdentityType";
  actual_hash char(64);
  target_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'candidate authorizations cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "identity_type" INTO actor_type
      FROM "users" WHERE "id" = NEW."reviewer_id" FOR KEY SHARE;
    IF actor_type IS DISTINCT FROM 'HUMAN' THEN
      RAISE EXCEPTION 'candidate authorization requires a human reviewer';
    END IF;
    SELECT "manifest_hash" INTO actual_hash
      FROM "content_snapshots"
      WHERE "id" = NEW."snapshot_id" AND "validation_state" = 'VALIDATED'
      FOR KEY SHARE;
    SELECT * INTO target_row
      FROM "publication_targets" WHERE "id" = NEW."target_id" FOR KEY SHARE;
    IF actual_hash IS DISTINCT FROM NEW."snapshot_hash"
      OR target_row."candidate_snapshot_id" IS DISTINCT FROM NEW."snapshot_id"
      OR target_row."candidate_publication_request_id" IS DISTINCT FROM NEW."publication_request_id"
      OR target_row."candidate_rollback_request_id" IS DISTINCT FROM NEW."rollback_request_id"
    THEN RAISE EXCEPTION 'authorization does not match the active candidate'; END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
    OR NEW."publication_request_id" IS DISTINCT FROM OLD."publication_request_id"
    OR NEW."rollback_request_id" IS DISTINCT FROM OLD."rollback_request_id"
    OR NEW."target_id" <> OLD."target_id"
    OR NEW."snapshot_id" <> OLD."snapshot_id"
    OR NEW."snapshot_hash" <> OLD."snapshot_hash"
    OR NEW."reviewer_id" <> OLD."reviewer_id"
    OR NEW."exchange_token_hash" <> OLD."exchange_token_hash"
    OR NEW."audience" <> OLD."audience"
    OR NEW."expires_at" <> OLD."expires_at"
    OR NEW."created_at" <> OLD."created_at"
  THEN RAISE EXCEPTION 'candidate authorization identity is immutable'; END IF;
  IF OLD."cookie_token_hash" IS NOT NULL
    AND NEW."cookie_token_hash" IS DISTINCT FROM OLD."cookie_token_hash"
  THEN RAISE EXCEPTION 'candidate cookie binding is immutable once exchanged'; END IF;
  IF OLD."exchanged_at" IS NOT NULL
    AND NEW."exchanged_at" IS DISTINCT FROM OLD."exchanged_at"
  THEN RAISE EXCEPTION 'candidate exchange time is immutable once recorded'; END IF;
  IF OLD."revoked_at" IS NOT NULL
    AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
  THEN RAISE EXCEPTION 'candidate revocation is immutable once recorded'; END IF;
  IF OLD."exchanged_at" IS NULL AND NEW."exchanged_at" IS NOT NULL
    AND (clock_timestamp() >= OLD."expires_at" OR OLD."revoked_at" IS NOT NULL)
  THEN RAISE EXCEPTION 'expired or revoked authorization cannot be exchanged'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "candidate_authorizations_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "candidate_authorizations"
  FOR EACH ROW EXECUTE FUNCTION protect_candidate_authorization();

CREATE OR REPLACE FUNCTION protect_leadership_observation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_hash char(64);
  target_row record;
  publication_row record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Leadership observation receipts are append-only';
  END IF;
  SELECT "manifest_hash" INTO actual_hash
    FROM "content_snapshots"
    WHERE "id" = NEW."snapshot_id" AND "validation_state" = 'VALIDATED'
    FOR KEY SHARE;
  IF actual_hash IS DISTINCT FROM NEW."snapshot_hash" THEN
    RAISE EXCEPTION 'Leadership observation snapshot hash mismatch';
  END IF;
  SELECT * INTO target_row
    FROM "publication_targets" WHERE "id" = NEW."target_id" FOR KEY SHARE;
  IF NEW."database_publication_id" IS NOT NULL THEN
    SELECT * INTO publication_row
      FROM "database_publications"
      WHERE "id" = NEW."database_publication_id" FOR KEY SHARE;
    IF NOT FOUND OR publication_row."target_id" <> NEW."target_id" THEN
      RAISE EXCEPTION 'Leadership observation publication target mismatch';
    END IF;
  END IF;
  IF NEW."observation_kind" = 'CANDIDATE' THEN
    IF NEW."database_publication_id" IS NULL
      OR target_row."candidate_snapshot_id" IS DISTINCT FROM NEW."snapshot_id"
      OR publication_row."candidate_snapshot_id" IS DISTINCT FROM NEW."snapshot_id"
    THEN RAISE EXCEPTION 'candidate observation is not for the private candidate pointer'; END IF;
  ELSE
    IF target_row."official_snapshot_id" IS DISTINCT FROM NEW."snapshot_id" THEN
      RAISE EXCEPTION 'official observation is not for the official pointer';
    END IF;
    IF NEW."observation_kind" = 'RESTORATION'
      AND (
        NEW."database_publication_id" IS NULL
        OR publication_row."state" <> 'RESTORING_PREVIOUS'
        OR publication_row."previous_official_snapshot_id" <> NEW."snapshot_id"
      )
    THEN RAISE EXCEPTION 'restoration observation does not match rollback evidence'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "leadership_observation_receipts_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "leadership_observation_receipts"
  FOR EACH ROW EXECUTE FUNCTION protect_leadership_observation();

CREATE TRIGGER "publication_events_append_only"
  BEFORE UPDATE OR DELETE ON "publication_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_row_change();

CREATE OR REPLACE FUNCTION append_publication_event(
  p_publication_request_id uuid,
  p_rollback_request_id uuid,
  p_target_id uuid,
  p_event_key text,
  p_event_type text,
  p_payload jsonb
)
RETURNS TABLE(event_id uuid, event_sequence bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  next_sequence bigint;
  existing_event record;
  expected_target uuid;
BEGIN
  IF num_nonnulls(p_publication_request_id, p_rollback_request_id) <> 1 THEN
    RAISE EXCEPTION 'exactly one publication request identity is required';
  END IF;
  IF p_publication_request_id IS NOT NULL THEN
    SELECT "publication_target_id" INTO expected_target
      FROM "publication_requests"
      WHERE "id" = p_publication_request_id FOR UPDATE;
  ELSE
    SELECT "publication_target_id" INTO expected_target
      FROM "rollback_requests"
      WHERE "id" = p_rollback_request_id FOR UPDATE;
  END IF;
  IF expected_target IS DISTINCT FROM p_target_id THEN
    RAISE EXCEPTION 'publication event target does not match request';
  END IF;

  SELECT "id", "sequence", "event_type", "payload" INTO existing_event
    FROM "publication_events"
    WHERE "publication_request_id" IS NOT DISTINCT FROM p_publication_request_id
      AND "rollback_request_id" IS NOT DISTINCT FROM p_rollback_request_id
      AND "event_key" = p_event_key;
  IF FOUND THEN
    IF existing_event."event_type" <> p_event_type OR existing_event."payload" <> p_payload THEN
      RAISE EXCEPTION 'publication event idempotency key was reused with different evidence';
    END IF;
    RETURN QUERY SELECT existing_event."id", existing_event."sequence";
    RETURN;
  END IF;

  SELECT COALESCE(max("sequence"), 0) + 1 INTO next_sequence
    FROM "publication_events"
    WHERE "publication_request_id" IS NOT DISTINCT FROM p_publication_request_id
      AND "rollback_request_id" IS NOT DISTINCT FROM p_rollback_request_id;
  event_id := gen_random_uuid();
  event_sequence := next_sequence;
  INSERT INTO "publication_events" (
    "id", "publication_request_id", "rollback_request_id", "target_id",
    "sequence", "event_key", "event_type", "payload"
  ) VALUES (
    event_id, p_publication_request_id, p_rollback_request_id, p_target_id,
    event_sequence, p_event_key, p_event_type, p_payload
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION leadership_read_official_snapshot(p_target_code text)
RETURNS TABLE(
  snapshot_id uuid,
  snapshot_hash char(64),
  canonical_manifest text,
  validation_policy_hash char(64),
  artifact_count integer,
  total_byte_length bigint,
  logical_id varchar(200),
  canonical_path varchar(500),
  artifact_type text,
  content_hash char(64),
  byte_length integer,
  body text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    snapshot."id",
    snapshot."manifest_hash",
    snapshot."manifest",
    snapshot."validation_policy_hash",
    snapshot."artifact_count",
    snapshot."total_byte_length",
    member."logical_id",
    member."canonical_path",
    member."artifact_type"::text,
    member."content_hash",
    member."byte_length",
    blob."body"
  FROM public."publication_targets" target
  JOIN public."content_snapshots" snapshot
    ON snapshot."id" = target."official_snapshot_id"
   AND snapshot."validation_state" = 'VALIDATED'
  JOIN public."content_snapshot_artifacts" member
    ON member."snapshot_id" = snapshot."id"
  JOIN public."content_blobs" blob
    ON blob."hash" = member."content_hash"
  WHERE target."code" = p_target_code
    AND target."bootstrapped_at" IS NOT NULL
  ORDER BY member."canonical_path", member."logical_id";
$$;

CREATE OR REPLACE FUNCTION leadership_read_candidate_snapshot(
  p_target_code text,
  p_cookie_token_hash text,
  p_reviewer_id uuid,
  p_audience text
)
RETURNS TABLE(
  snapshot_id uuid,
  snapshot_hash char(64),
  canonical_manifest text,
  validation_policy_hash char(64),
  artifact_count integer,
  total_byte_length bigint,
  logical_id varchar(200),
  canonical_path varchar(500),
  artifact_type text,
  content_hash char(64),
  byte_length integer,
  body text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    snapshot."id",
    snapshot."manifest_hash",
    snapshot."manifest",
    snapshot."validation_policy_hash",
    snapshot."artifact_count",
    snapshot."total_byte_length",
    member."logical_id",
    member."canonical_path",
    member."artifact_type"::text,
    member."content_hash",
    member."byte_length",
    blob."body"
  FROM public."publication_targets" target
  JOIN public."candidate_authorizations" authz
    ON authz."target_id" = target."id"
   AND authz."snapshot_id" = target."candidate_snapshot_id"
   AND authz."publication_request_id" IS NOT DISTINCT FROM target."candidate_publication_request_id"
   AND authz."rollback_request_id" IS NOT DISTINCT FROM target."candidate_rollback_request_id"
   AND authz."cookie_token_hash" = p_cookie_token_hash
   AND authz."reviewer_id" = p_reviewer_id
   AND authz."audience" = p_audience
   AND authz."exchanged_at" IS NOT NULL
   AND authz."revoked_at" IS NULL
   AND authz."expires_at" > statement_timestamp()
  JOIN public."content_snapshots" snapshot
    ON snapshot."id" = target."candidate_snapshot_id"
   AND snapshot."manifest_hash" = authz."snapshot_hash"
   AND snapshot."validation_state" = 'VALIDATED'
  JOIN public."content_snapshot_artifacts" member
    ON member."snapshot_id" = snapshot."id"
  JOIN public."content_blobs" blob
    ON blob."hash" = member."content_hash"
  WHERE target."code" = p_target_code
    AND p_cookie_token_hash ~ '^[a-f0-9]{64}$'
  ORDER BY member."canonical_path", member."logical_id";
$$;

REVOKE ALL ON FUNCTION append_publication_event(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION leadership_read_official_snapshot(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION leadership_read_candidate_snapshot(text, text, uuid, text) FROM PUBLIC;
