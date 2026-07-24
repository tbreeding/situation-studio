-- CreateEnum
CREATE TYPE "UserState" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "UserRoleCode" AS ENUM ('EDITOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "ThrottleKeyKind" AS ENUM ('USERNAME', 'IP');

-- CreateEnum
CREATE TYPE "ResetTokenState" AS ENUM ('ACTIVE', 'CONSUMED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SituationVisibility" AS ENUM ('PUBLIC', 'RETIRED', 'UNPUBLISHED');

-- CreateEnum
CREATE TYPE "DraftLineageState" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('SITUATION', 'GUIDE', 'PRACTICE', 'SOURCE', 'LESSON_PLAN', 'PREPARATION_PROMPT', 'PROMOTION');

-- CreateEnum
CREATE TYPE "ArtifactVisibility" AS ENUM ('GLOBAL', 'SITUATION_SCOPED', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ContentEncoding" AS ENUM ('UTF8', 'BINARY');

-- CreateEnum
CREATE TYPE "ReviewJobState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewStepState" AS ENUM ('PENDING', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgentFailureClass" AS ENUM ('PROVIDER_CAPACITY', 'PROVIDER_TRANSIENT', 'PROVIDER_AUTH', 'OUTPUT_INVALID', 'APPLICATION', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProposalChangeState" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ProposalTargetKind" AS ENUM ('SECTION', 'METADATA', 'SCOPED_VARIANT', 'RELATIONSHIP');

-- CreateEnum
CREATE TYPE "PublicationJobState" AS ENUM ('REQUESTED', 'ASSEMBLING', 'NEEDS_REFRESH', 'PROMOTING', 'VERIFYING', 'SUCCEEDED', 'RESTORED', 'RECOVERY_REQUIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProductionSourceKind" AS ENUM ('BOOTSTRAP_IMPORT', 'EXTERNAL_IMPORT', 'MANUAL', 'AGENT_ASSISTED', 'RESTORE', 'CREATE', 'RETIRE');

-- CreateEnum
CREATE TYPE "PublicationEventKind" AS ENUM ('REQUESTED', 'POINTER_OBSERVED', 'REBASED', 'CONFLICTED', 'SNAPSHOT_BUILT', 'VALIDATED', 'RELEASE_INSERTED', 'POINTER_ADVANCED', 'VERIFIED', 'RESTORE_STARTED', 'RESTORED', 'RECOVERY_REQUIRED', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "BackupState" AS ENUM ('QUEUED', 'RUNNING', 'VERIFIED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "password_hash" VARCHAR(512) NOT NULL,
    "password_version" INTEGER NOT NULL DEFAULT 1,
    "state" "UserState" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(3),
    "deactivated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role_assignments" (
    "user_id" UUID NOT NULL,
    "role" "UserRoleCode" NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_assignments_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "csrf_hash" CHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "password_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(200),
    "ip_hash" CHAR(64),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_throttles" (
    "id" UUID NOT NULL,
    "key_kind" "ThrottleKeyKind" NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "blocked_until" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "login_throttles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "state" "ResetTokenState" NOT NULL DEFAULT 'ACTIVE',
    "created_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "situations" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "visibility" "SituationVisibility" NOT NULL DEFAULT 'UNPUBLISHED',
    "fence" BIGINT NOT NULL DEFAULT 0,
    "production_bundle_hash" CHAR(64),
    "production_release_id" UUID,
    "production_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "situations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "situation_checkouts" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "holder_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "fence" BIGINT NOT NULL,
    "acquired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),
    "release_reason" VARCHAR(240),
    "forced_by_id" UUID,
    "force_reason" VARCHAR(500),
    "resulting_draft_hash" CHAR(64),

    CONSTRAINT "situation_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_blobs" (
    "hash" CHAR(64) NOT NULL,
    "encoding" "ContentEncoding" NOT NULL DEFAULT 'UTF8',
    "media_type" VARCHAR(120) NOT NULL,
    "byte_length" INTEGER NOT NULL,
    "text_body" TEXT,
    "binary_body" BYTEA,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_blobs_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "drafts" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "lineage" INTEGER NOT NULL DEFAULT 1,
    "state" "DraftLineageState" NOT NULL DEFAULT 'ACTIVE',
    "base_production_version_id" UUID,
    "base_release_id" UUID,
    "base_manifest_hash" CHAR(64),
    "base_pointer_generation" BIGINT,
    "base_bundle_hash" CHAR(64),
    "rebase_release_id" UUID,
    "conflicted_at" TIMESTAMPTZ(3),
    "current_revision_number" INTEGER NOT NULL DEFAULT 0,
    "current_bundle_hash" CHAR(64),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_revisions" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "parent_id" UUID,
    "bundle_hash" CHAR(64) NOT NULL,
    "bundle_manifest" JSONB NOT NULL,
    "contract_version" VARCHAR(100) NOT NULL,
    "validation_policy" VARCHAR(100) NOT NULL,
    "actor_id" UUID NOT NULL,
    "named_checkpoint" VARCHAR(160),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_revision_artifacts" (
    "revision_id" UUID NOT NULL,
    "logical_id" VARCHAR(240) NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "visibility" "ArtifactVisibility" NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "position" INTEGER NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "draft_revision_artifacts_pkey" PRIMARY KEY ("revision_id","logical_id")
);

-- CreateTable
CREATE TABLE "scoped_artifact_variants" (
    "id" UUID NOT NULL,
    "owner_situation_id" UUID NOT NULL,
    "logical_id" VARCHAR(240) NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "visibility" "ArtifactVisibility" NOT NULL,
    "forked_from_logical_id" VARCHAR(240) NOT NULL,
    "forked_from_content_hash" CHAR(64) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scoped_artifact_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leadership_release_observations" (
    "id" UUID NOT NULL,
    "release_id" UUID NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "pointer_generation" BIGINT,
    "state" VARCHAR(40) NOT NULL,
    "source_kind" VARCHAR(80) NOT NULL,
    "manifest" JSONB NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),

    CONSTRAINT "leadership_release_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leadership_sync_cursors" (
    "id" VARCHAR(40) NOT NULL DEFAULT 'official',
    "last_release_id" UUID,
    "last_manifest_hash" CHAR(64),
    "last_pointer_generation" BIGINT,
    "last_successful_at" TIMESTAMPTZ(3),
    "last_error_code" VARCHAR(100),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "leadership_sync_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_situation_versions" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "bundle_hash" CHAR(64) NOT NULL,
    "bundle_manifest" JSONB NOT NULL,
    "contract_version" VARCHAR(100) NOT NULL,
    "validation_policy" VARCHAR(100) NOT NULL,
    "source_kind" "ProductionSourceKind" NOT NULL,
    "actor_id" UUID,
    "production_at" TIMESTAMPTZ(3) NOT NULL,
    "change_summary" VARCHAR(1000) NOT NULL,
    "editor_note" VARCHAR(1000),
    "restoration_parent_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_situation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_version_artifacts" (
    "version_id" UUID NOT NULL,
    "logical_id" VARCHAR(240) NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "visibility" "ArtifactVisibility" NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "position" INTEGER NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "production_version_artifacts_pkey" PRIMARY KEY ("version_id","logical_id")
);

-- CreateTable
CREATE TABLE "review_jobs" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "input_revision_id" UUID NOT NULL,
    "checkout_id" UUID NOT NULL,
    "checkout_fence" BIGINT NOT NULL,
    "fence" BIGINT NOT NULL DEFAULT 1,
    "state" "ReviewJobState" NOT NULL DEFAULT 'QUEUED',
    "context_hash" CHAR(64) NOT NULL,
    "contract_version" VARCHAR(100) NOT NULL,
    "policy_version" VARCHAR(100) NOT NULL,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancellation_reason" VARCHAR(500),
    "failure_code" VARCHAR(100),

    CONSTRAINT "review_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_steps" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "role_code" VARCHAR(100) NOT NULL,
    "dependencies" JSONB NOT NULL,
    "state" "ReviewStepState" NOT NULL DEFAULT 'PENDING',
    "output_hash" CHAR(64),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "review_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "requested_provider" VARCHAR(40) NOT NULL,
    "resolved_provider" VARCHAR(40),
    "requested_model" VARCHAR(120) NOT NULL,
    "resolved_model" VARCHAR(120),
    "reasoning_effort" VARCHAR(30) NOT NULL,
    "evidence_hash" CHAR(64) NOT NULL,
    "structured_output" JSONB,
    "output_hash" CHAR(64),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "usage_estimated" BOOLEAN,
    "failure_class" "AgentFailureClass",
    "retryable" BOOLEAN,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_proposals" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "input_revision_id" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "findings" JSONB NOT NULL,
    "proposal_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_changes" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "target_kind" "ProposalTargetKind" NOT NULL,
    "target_key" VARCHAR(240) NOT NULL,
    "before_hash" CHAR(64),
    "after_body" TEXT NOT NULL,
    "after_hash" CHAR(64) NOT NULL,
    "rationale" TEXT NOT NULL,
    "state" "ProposalChangeState" NOT NULL DEFAULT 'PENDING',
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_id" UUID,
    "applied_revision_id" UUID,

    CONSTRAINT "proposal_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_jobs" (
    "id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "target_revision_id" UUID NOT NULL,
    "checkout_id" UUID NOT NULL,
    "checkout_fence" BIGINT NOT NULL,
    "source_kind" "ProductionSourceKind" NOT NULL,
    "state" "PublicationJobState" NOT NULL DEFAULT 'REQUESTED',
    "target_bundle_hash" CHAR(64) NOT NULL,
    "base_bundle_hash" CHAR(64),
    "expected_pointer_generation" BIGINT,
    "observed_release_id" UUID,
    "leadership_release_id" UUID,
    "leadership_manifest_hash" CHAR(64),
    "previous_release_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "failure_code" VARCHAR(100),

    CONSTRAINT "publication_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_attempts" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "reconciled_state" JSONB,
    "failure_code" VARCHAR(100),

    CONSTRAINT "publication_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_events" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" "PublicationEventKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publication_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_receipts" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "expected_release_id" UUID NOT NULL,
    "expected_manifest_hash" CHAR(64) NOT NULL,
    "observed_database_release_id" UUID NOT NULL,
    "observed_database_hash" CHAR(64) NOT NULL,
    "observed_runtime_release_id" UUID NOT NULL,
    "observed_runtime_hash" CHAR(64) NOT NULL,
    "pointer_generation" BIGINT NOT NULL,
    "verified_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(100) NOT NULL,
    "subject_type" VARCHAR(80) NOT NULL,
    "subject_id" VARCHAR(160) NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_receipts" (
    "id" UUID NOT NULL,
    "publication_job_id" UUID,
    "state" "BackupState" NOT NULL DEFAULT 'QUEUED',
    "destination_id" VARCHAR(120) NOT NULL,
    "object_key" VARCHAR(500),
    "checksum" CHAR(64),
    "encrypted" BOOLEAN NOT NULL DEFAULT true,
    "byte_length" BIGINT,
    "started_at" TIMESTAMPTZ(3),
    "verified_at" TIMESTAMPTZ(3),
    "failure_code" VARCHAR(100),
    "restore_drill_at" TIMESTAMPTZ(3),
    "restore_drill_result" VARCHAR(120),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_state_username_idx" ON "users"("state", "username");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_expiry_idx" ON "sessions"("user_id", "absolute_expires_at");

-- CreateIndex
CREATE INDEX "login_throttles_blocked_idx" ON "login_throttles"("blocked_until");

-- CreateIndex
CREATE UNIQUE INDEX "login_throttles_key_key" ON "login_throttles"("key_kind", "key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_subject_idx" ON "password_reset_tokens"("user_id", "state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "situations_slug_key" ON "situations"("slug");

-- CreateIndex
CREATE INDEX "situations_inventory_idx" ON "situations"("visibility", "title");

-- CreateIndex
CREATE INDEX "checkouts_holder_active_idx" ON "situation_checkouts"("holder_id", "released_at");

-- CreateIndex
CREATE INDEX "checkouts_situation_active_idx" ON "situation_checkouts"("situation_id", "released_at");

-- CreateIndex
CREATE INDEX "drafts_situation_state_idx" ON "drafts"("situation_id", "state");

-- CreateIndex
CREATE INDEX "draft_revisions_timeline_idx" ON "draft_revisions"("draft_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "draft_revisions_number_key" ON "draft_revisions"("draft_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "draft_revision_artifact_position_key" ON "draft_revision_artifacts"("revision_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "scoped_artifact_variants_logical_id_key" ON "scoped_artifact_variants"("logical_id");

-- CreateIndex
CREATE INDEX "scoped_variants_owner_kind_idx" ON "scoped_artifact_variants"("owner_situation_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "leadership_release_observations_release_id_key" ON "leadership_release_observations"("release_id");

-- CreateIndex
CREATE INDEX "leadership_observations_time_idx" ON "leadership_release_observations"("observed_at");

-- CreateIndex
CREATE INDEX "production_versions_timeline_idx" ON "production_situation_versions"("situation_id", "production_at");

-- CreateIndex
CREATE UNIQUE INDEX "production_versions_bundle_key" ON "production_situation_versions"("situation_id", "bundle_hash");

-- CreateIndex
CREATE UNIQUE INDEX "production_version_artifact_position_key" ON "production_version_artifacts"("version_id", "position");

-- CreateIndex
CREATE INDEX "review_jobs_queue_idx" ON "review_jobs"("state", "queued_at");

-- CreateIndex
CREATE INDEX "review_jobs_situation_state_idx" ON "review_jobs"("situation_id", "state");

-- CreateIndex
CREATE INDEX "review_steps_ready_idx" ON "review_steps"("job_id", "state", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "review_steps_ordinal_key" ON "review_steps"("job_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "review_steps_role_key" ON "review_steps"("job_id", "role_code");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_attempt_key" ON "agent_runs"("step_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "review_proposals_job_id_key" ON "review_proposals"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_proposals_proposal_hash_key" ON "review_proposals"("proposal_hash");

-- CreateIndex
CREATE UNIQUE INDEX "proposal_changes_position_key" ON "proposal_changes"("proposal_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "publication_jobs_publication_id_key" ON "publication_jobs"("publication_id");

-- CreateIndex
CREATE UNIQUE INDEX "publication_jobs_leadership_release_id_key" ON "publication_jobs"("leadership_release_id");

-- CreateIndex
CREATE INDEX "publication_jobs_queue_idx" ON "publication_jobs"("state", "created_at");

-- CreateIndex
CREATE INDEX "publication_jobs_situation_idx" ON "publication_jobs"("situation_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "publication_attempts_attempt_key" ON "publication_attempts"("job_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "publication_events_sequence_key" ON "publication_events"("job_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "verification_receipts_job_id_key" ON "verification_receipts"("job_id");

-- CreateIndex
CREATE INDEX "audit_subject_time_idx" ON "audit_events"("subject_type", "subject_id", "occurred_at");

-- CreateIndex
CREATE INDEX "backup_receipts_state_time_idx" ON "backup_receipts"("state", "created_at");

-- AddForeignKey
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_checkouts" ADD CONSTRAINT "situation_checkouts_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_checkouts" ADD CONSTRAINT "situation_checkouts_holder_id_fkey" FOREIGN KEY ("holder_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_checkouts" ADD CONSTRAINT "situation_checkouts_forced_by_id_fkey" FOREIGN KEY ("forced_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_checkouts" ADD CONSTRAINT "situation_checkouts_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_base_production_version_id_fkey" FOREIGN KEY ("base_production_version_id") REFERENCES "production_situation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "draft_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_revision_artifacts" ADD CONSTRAINT "draft_revision_artifacts_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "draft_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_revision_artifacts" ADD CONSTRAINT "draft_revision_artifacts_content_hash_fkey" FOREIGN KEY ("content_hash") REFERENCES "content_blobs"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoped_artifact_variants" ADD CONSTRAINT "scoped_artifact_variants_owner_situation_id_fkey" FOREIGN KEY ("owner_situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scoped_artifact_variants" ADD CONSTRAINT "scoped_artifact_variants_content_hash_fkey" FOREIGN KEY ("content_hash") REFERENCES "content_blobs"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_situation_versions" ADD CONSTRAINT "production_situation_versions_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_situation_versions" ADD CONSTRAINT "production_situation_versions_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "leadership_release_observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_situation_versions" ADD CONSTRAINT "production_situation_versions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_situation_versions" ADD CONSTRAINT "production_situation_versions_restoration_parent_id_fkey" FOREIGN KEY ("restoration_parent_id") REFERENCES "production_situation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_version_artifacts" ADD CONSTRAINT "production_version_artifacts_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "production_situation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_version_artifacts" ADD CONSTRAINT "production_version_artifacts_content_hash_fkey" FOREIGN KEY ("content_hash") REFERENCES "content_blobs"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_jobs" ADD CONSTRAINT "review_jobs_input_revision_id_fkey" FOREIGN KEY ("input_revision_id") REFERENCES "draft_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_steps" ADD CONSTRAINT "review_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "review_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "review_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_proposals" ADD CONSTRAINT "review_proposals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "review_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_changes" ADD CONSTRAINT "proposal_changes_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "review_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_target_revision_id_fkey" FOREIGN KEY ("target_revision_id") REFERENCES "draft_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "publication_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_events" ADD CONSTRAINT "publication_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "publication_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_receipts" ADD CONSTRAINT "verification_receipts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "publication_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_receipts" ADD CONSTRAINT "backup_receipts_publication_job_id_fkey" FOREIGN KEY ("publication_job_id") REFERENCES "publication_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One durable owner, lineage, review, and publication at a time. These
-- predicates are the final concurrency boundary; application checks only make
-- the errors friendlier.
CREATE UNIQUE INDEX "situation_checkouts_one_active_per_situation"
  ON "situation_checkouts" ("situation_id")
  WHERE "released_at" IS NULL;

CREATE UNIQUE INDEX "drafts_one_active_per_situation"
  ON "drafts" ("situation_id")
  WHERE "state" = 'ACTIVE';

CREATE UNIQUE INDEX "review_jobs_one_active_per_situation"
  ON "review_jobs" ("situation_id")
  WHERE "state" IN ('QUEUED', 'RUNNING');

CREATE UNIQUE INDEX "review_jobs_one_running_globally"
  ON "review_jobs" ((true))
  WHERE "state" = 'RUNNING';

CREATE UNIQUE INDEX "publication_jobs_one_active_per_situation"
  ON "publication_jobs" ("situation_id")
  WHERE "state" IN ('REQUESTED', 'ASSEMBLING', 'PROMOTING', 'VERIFYING');

CREATE UNIQUE INDEX "publication_jobs_one_pointer_transaction"
  ON "publication_jobs" ((true))
  WHERE "state" IN ('PROMOTING', 'VERIFYING');

ALTER TABLE "content_blobs"
  ADD CONSTRAINT "content_blobs_exactly_one_body"
  CHECK (
    ("encoding" = 'UTF8' AND "text_body" IS NOT NULL AND "binary_body" IS NULL)
    OR
    ("encoding" = 'BINARY' AND "binary_body" IS NOT NULL AND "text_body" IS NULL)
  ),
  ADD CONSTRAINT "content_blobs_nonnegative_length"
  CHECK ("byte_length" >= 0);

ALTER TABLE "scoped_artifact_variants"
  ADD CONSTRAINT "scoped_variants_visibility"
  CHECK ("visibility" IN ('SITUATION_SCOPED', 'INTERNAL'));

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_expiry_order"
  CHECK ("created_at" < "idle_expires_at" AND "idle_expires_at" <= "absolute_expires_at");

ALTER TABLE "situation_checkouts"
  ADD CONSTRAINT "checkouts_force_provenance"
  CHECK (
    ("forced_by_id" IS NULL AND "force_reason" IS NULL)
    OR
    ("forced_by_id" IS NOT NULL AND length(trim("force_reason")) >= 3)
  );

CREATE OR REPLACE FUNCTION studio_reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "content_blobs_immutable_update"
BEFORE UPDATE OR DELETE ON "content_blobs"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE TRIGGER "production_versions_immutable_update"
BEFORE UPDATE OR DELETE ON "production_situation_versions"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE TRIGGER "production_version_artifacts_immutable_update"
BEFORE UPDATE OR DELETE ON "production_version_artifacts"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE TRIGGER "draft_revisions_immutable_update"
BEFORE UPDATE OR DELETE ON "draft_revisions"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE TRIGGER "draft_revision_artifacts_immutable_update"
BEFORE UPDATE OR DELETE ON "draft_revision_artifacts"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE TRIGGER "review_proposals_immutable_update"
BEFORE UPDATE OR DELETE ON "review_proposals"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE TRIGGER "leadership_observations_immutable_update"
BEFORE UPDATE OR DELETE ON "leadership_release_observations"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();
