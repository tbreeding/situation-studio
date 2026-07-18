-- CreateEnum
CREATE TYPE "IdentityType" AS ENUM ('HUMAN', 'SERVICE', 'AI');

-- CreateEnum
CREATE TYPE "UserState" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ThrottleKeyKind" AS ENUM ('USERNAME', 'IP');

-- CreateEnum
CREATE TYPE "TokenKind" AS ENUM ('ACTIVATION', 'RESET');

-- CreateEnum
CREATE TYPE "SituationLifecycle" AS ENUM ('UNPUBLISHED', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PublicationState" AS ENUM ('NEVER_PUBLISHED', 'STAGED', 'PUBLISHED', 'ROLLED_BACK', 'RETIRED');

-- CreateEnum
CREATE TYPE "DraftState" AS ENUM ('DISCOVERY', 'DRAFTING', 'READY_FOR_AI_REVIEW', 'AI_REVIEW_QUEUED', 'AI_REVIEW_RUNNING', 'PROPOSAL_READY', 'HUMAN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "CheckoutMode" AS ENUM ('DISCOVERY', 'EDITING', 'AI_QUEUED', 'AI_RUNNING', 'HUMAN_REVIEW', 'APPROVED', 'PUBLISHING', 'ARCHIVING', 'RESTORING');

-- CreateEnum
CREATE TYPE "CheckoutCustody" AS ENUM ('USER', 'AI_JOB', 'PUBLISHER');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('SITUATION', 'GUIDE', 'PRACTICE', 'LESSON_PLAN', 'PREPARATION_PROMPT', 'TOOL', 'SOURCE', 'AUTHOR', 'ROUTE', 'VALIDATOR');

-- CreateEnum
CREATE TYPE "ArtifactEdgeType" AS ENUM ('EMBEDS_PRACTICE', 'TAUGHT_BY_LESSON', 'PREPARES_WITH', 'CITES_SOURCE', 'LINKS_TO', 'CONSUMED_BY_ROUTE', 'VALIDATED_BY');

-- CreateEnum
CREATE TYPE "SnapshotKind" AS ENUM ('LEGACY_IMPORT', 'STUDIO_PUBLICATION', 'EXTERNAL_REPOSITORY_VERSION');

-- CreateEnum
CREATE TYPE "VersionSourceKind" AS ENUM ('LEGACY_IMPORT', 'MANUAL_DRAFT', 'AI_PROPOSAL', 'PUBLICATION', 'EXTERNAL_REPOSITORY_VERSION', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "ChangeKind" AS ENUM ('ADD', 'MODIFY', 'DELETE', 'NO_CHANGE');

-- CreateEnum
CREATE TYPE "ConversationKind" AS ENUM ('NEW_SITUATION', 'FOCUSED_REVISION');

-- CreateEnum
CREATE TYPE "ConversationState" AS ENUM ('OPEN', 'WAITING', 'READY', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "BriefFieldState" AS ENUM ('CONFIRMED_FACT', 'USER_ACCEPTED_ASSUMPTION', 'DELIBERATE_UNKNOWN', 'UNRESOLVED_BLOCKER');

-- CreateEnum
CREATE TYPE "AiJobState" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_CAPACITY', 'RETRY_SCHEDULED', 'CANCELLING', 'CANCELLED', 'SUCCEEDED', 'INCOMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "WorkflowStepState" AS ENUM ('PENDING', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProviderState" AS ENUM ('ENABLED', 'PAUSED', 'AUTH_FAILED', 'CAPACITY_WAIT', 'UNHEALTHY');

-- CreateEnum
CREATE TYPE "FailureClass" AS ENUM ('PROVIDER_CAPACITY_EXHAUSTED', 'PROVIDER_TRANSIENT', 'PROVIDER_AUTH_CONFIG', 'MODEL_OUTPUT_INVALID', 'APPLICATION_FAILURE', 'WORKSPACE_SECURITY_FAILURE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BundleState" AS ENUM ('DRAFT', 'PROPOSAL_READY', 'HUMAN_REVIEW', 'APPROVED', 'STALE', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "ValidationState" AS ENUM ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PublicationSagaState" AS ENUM ('REQUESTED', 'WORKTREE_READY', 'APPLIED', 'VALIDATED', 'COMMITTED', 'PUSHED', 'PREVIEW_BUILT', 'PREVIEW_VERIFIED', 'AWAITING_CONFIRMATION', 'CUTOVER', 'LIVE_VERIFIED', 'RECONCILED', 'FAILED_PREVIEW', 'AUTO_ROLLED_BACK', 'RECONCILIATION_REQUIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "password_hash" VARCHAR(512),
    "identity_type" "IdentityType" NOT NULL DEFAULT 'HUMAN',
    "state" "UserState" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "password_version" INTEGER NOT NULL DEFAULT 1,
    "last_login_at" TIMESTAMPTZ(3),
    "deactivated_at" TIMESTAMPTZ(3),
    "deactivated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "system_managed" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "description" VARCHAR(300) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "granted_by_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "user_permission_grants" (
    "user_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "granted_by_id" UUID NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permission_grants_pkey" PRIMARY KEY ("user_id","permission_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "user_id" UUID NOT NULL,
    "password_version" INTEGER NOT NULL,
    "csrf_secret_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "reauthenticated_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(200),
    "ip_hash" CHAR(64),
    "user_agent_class" VARCHAR(80),

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
CREATE TABLE "activation_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "kind" "TokenKind" NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "activation_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_snapshots" (
    "id" UUID NOT NULL,
    "commit_sha" CHAR(40) NOT NULL,
    "manifest" JSONB NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "parser_version" VARCHAR(80) NOT NULL,
    "import_kind" "SnapshotKind" NOT NULL,
    "validation_state" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "situations" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "title" VARCHAR(240) NOT NULL,
    "lifecycle" "SituationLifecycle" NOT NULL DEFAULT 'UNPUBLISHED',
    "publication_state" "PublicationState" NOT NULL DEFAULT 'NEVER_PUBLISHED',
    "current_publication_id" UUID,
    "previous_lifecycle" "SituationLifecycle",
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_id" UUID,
    "archive_reason" VARCHAR(500),
    "fence" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "situations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_blobs" (
    "hash" CHAR(64) NOT NULL,
    "body" TEXT NOT NULL,
    "byte_length" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_blobs_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "logical_id" VARCHAR(200) NOT NULL,
    "type" "ArtifactType" NOT NULL,
    "canonical_path" VARCHAR(500) NOT NULL,
    "primary_situation_id" UUID,
    "repository_snapshot_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact_edges" (
    "id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "target_id" UUID NOT NULL,
    "edge_type" "ArtifactEdgeType" NOT NULL,
    "evidence" VARCHAR(500) NOT NULL,

    CONSTRAINT "artifact_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "situation_versions" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "source_kind" "VersionSourceKind" NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "bundle_hash" CHAR(64),
    "actor_id" UUID,
    "ai_job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "situation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "version_artifacts" (
    "version_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "type" "ArtifactType" NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "change_kind" "ChangeKind" NOT NULL,

    CONSTRAINT "version_artifacts_pkey" PRIMARY KEY ("version_id","artifact_id")
);

-- CreateTable
CREATE TABLE "drafts" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "base_version_id" UUID,
    "base_snapshot_id" UUID NOT NULL,
    "current_revision" INTEGER NOT NULL DEFAULT 0,
    "state" "DraftState" NOT NULL DEFAULT 'DRAFTING',
    "stale_reason" VARCHAR(500),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_revisions" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "parent_revision_id" UUID,
    "manifest_hash" CHAR(64) NOT NULL,
    "actor_id" UUID NOT NULL,
    "client_mutation_id" UUID,
    "named_checkpoint" VARCHAR(160),
    "material_change" BOOLEAN NOT NULL DEFAULT true,
    "semantic_change" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_artifacts" (
    "revision_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "type" "ArtifactType" NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "change_kind" "ChangeKind" NOT NULL,

    CONSTRAINT "draft_artifacts_pkey" PRIMARY KEY ("revision_id","artifact_id")
);

-- CreateTable
CREATE TABLE "situation_checkouts" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "holder_user_id" UUID,
    "mode" "CheckoutMode" NOT NULL,
    "custody" "CheckoutCustody" NOT NULL DEFAULT 'USER',
    "custody_reference" UUID,
    "draft_id" UUID,
    "fencing_token" BIGINT NOT NULL,
    "acquired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "release_reason" VARCHAR(500),
    "transfer_reason" VARCHAR(500),

    CONSTRAINT "situation_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkout_resources" (
    "id" UUID NOT NULL,
    "checkout_id" UUID NOT NULL,
    "artifact_id" UUID,
    "situation_id" UUID,
    "resource_key" VARCHAR(260) NOT NULL,
    "purpose" VARCHAR(120) NOT NULL,
    "acquired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),

    CONSTRAINT "checkout_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "kind" "ConversationKind" NOT NULL,
    "state" "ConversationState" NOT NULL DEFAULT 'OPEN',
    "owner_id" UUID NOT NULL,
    "current_brief_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" "MessageRole" NOT NULL,
    "body" TEXT NOT NULL,
    "body_hash" CHAR(64) NOT NULL,
    "actor_id" UUID,
    "agent_run_id" UUID,
    "sensitive_disposition" VARCHAR(30) NOT NULL DEFAULT 'CLEAR',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_understanding_briefs" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "canonical_fields" JSONB NOT NULL,
    "field_states" JSONB NOT NULL,
    "source_sequence" INTEGER NOT NULL,
    "readiness" JSONB NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_understanding_briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief_confirmations" (
    "id" UUID NOT NULL,
    "brief_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "permission_snapshot" JSONB NOT NULL,
    "accepted_unknowns" JSONB NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidated_at" TIMESTAMPTZ(3),
    "invalidation_reason" VARCHAR(500),

    CONSTRAINT "brief_confirmations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_accounts" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "state" "ProviderState" NOT NULL DEFAULT 'PAUSED',
    "credential_mode" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_jobs" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(50) NOT NULL,
    "owner_id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "input_bundle_hash" CHAR(64) NOT NULL,
    "brief_hash" CHAR(64),
    "graph_hash" CHAR(64) NOT NULL,
    "workflow_version" VARCHAR(80) NOT NULL,
    "model_policy_version" VARCHAR(80) NOT NULL,
    "state" "AiJobState" NOT NULL DEFAULT 'QUEUED',
    "stage" VARCHAR(100) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "queue_sequence" BIGSERIAL NOT NULL,
    "run_nonce" VARCHAR(80) NOT NULL DEFAULT 'default',
    "idempotency_key" VARCHAR(120) NOT NULL,
    "cancellation_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_steps" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "role" VARCHAR(100) NOT NULL,
    "stage" VARCHAR(100) NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "dependency_ids" JSONB NOT NULL,
    "input_hash" CHAR(64) NOT NULL,
    "state" "WorkflowStepState" NOT NULL DEFAULT 'PENDING',
    "fencing_token" BIGINT NOT NULL DEFAULT 0,
    "selected_run_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "provider_account_id" UUID NOT NULL,
    "requested_model" VARCHAR(100) NOT NULL,
    "resolved_model" VARCHAR(160),
    "effort" VARCHAR(20) NOT NULL,
    "adapter_version" VARCHAR(80) NOT NULL,
    "cli_version" VARCHAR(80),
    "input_hash" CHAR(64) NOT NULL,
    "output_hash" CHAR(64),
    "normalized_output" JSONB,
    "redacted_raw_output" TEXT,
    "failure_class" "FailureClass",
    "failure_evidence" JSONB,
    "usage" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposed_bundles" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "parent_bundle_id" UUID,
    "revision" INTEGER NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "brief_id" UUID,
    "ai_job_id" UUID,
    "base_commit" CHAR(40) NOT NULL,
    "base_manifest_hash" CHAR(64) NOT NULL,
    "brief_hash" CHAR(64),
    "graph_hash" CHAR(64) NOT NULL,
    "canonical_hash" CHAR(64) NOT NULL,
    "manifest" JSONB NOT NULL,
    "decision_ledger" JSONB,
    "contradiction_matrix" JSONB,
    "state" "BundleState" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposed_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_artifacts" (
    "bundle_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "type" "ArtifactType" NOT NULL,
    "base_hash" CHAR(64),
    "candidate_hash" CHAR(64) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "change_kind" "ChangeKind" NOT NULL,
    "no_change_rationale" VARCHAR(1000),

    CONSTRAINT "bundle_artifacts_pkey" PRIMARY KEY ("bundle_id","artifact_id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "artifact_id" UUID,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "anchor" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    "resolved_by_id" UUID,
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_runs" (
    "id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "bundle_hash" CHAR(64) NOT NULL,
    "validator" VARCHAR(100) NOT NULL,
    "version" VARCHAR(80) NOT NULL,
    "environment_hash" CHAR(64) NOT NULL,
    "state" "ValidationState" NOT NULL DEFAULT 'QUEUED',
    "summary" VARCHAR(1000),
    "output_hash" CHAR(64),
    "approval_sensitive" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "validation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "bundle_hash" CHAR(64) NOT NULL,
    "base_commit" CHAR(40) NOT NULL,
    "validation_policy_hash" CHAR(64) NOT NULL,
    "approved_by_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "permission_snapshot" JSONB NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidated_at" TIMESTAMPTZ(3),
    "invalidation_reason" VARCHAR(500),

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_requests" (
    "id" UUID NOT NULL,
    "publication_uuid" UUID NOT NULL,
    "idempotency_key" VARCHAR(120) NOT NULL,
    "target_environment" VARCHAR(50) NOT NULL,
    "bundle_id" UUID NOT NULL,
    "bundle_hash" CHAR(64) NOT NULL,
    "approval_id" UUID NOT NULL,
    "base_commit" CHAR(40) NOT NULL,
    "state" "PublicationSagaState" NOT NULL DEFAULT 'REQUESTED',
    "current_step" VARCHAR(80) NOT NULL DEFAULT 'REQUESTED',
    "requested_by_id" UUID NOT NULL,
    "final_confirmed_at" TIMESTAMPTZ(3),
    "error_class" VARCHAR(100),
    "reconciliation_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "publication_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_steps" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "step" VARCHAR(80) NOT NULL,
    "attempt" INTEGER NOT NULL,
    "fence" BIGINT NOT NULL,
    "external_id" VARCHAR(300),
    "state" VARCHAR(30) NOT NULL,
    "input_hash" CHAR(64) NOT NULL,
    "output_hash" CHAR(64),
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "publication_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publications" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "bundle_id" UUID,
    "request_id" UUID,
    "version_id" UUID,
    "kind" "SnapshotKind" NOT NULL,
    "commit_sha" CHAR(40) NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "release_id" VARCHAR(200) NOT NULL,
    "preview_release_id" VARCHAR(200),
    "previous_publication_id" UUID,
    "published_by_id" UUID,
    "cutover_at" TIMESTAMPTZ(3),
    "health_state" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archive_records" (
    "id" UUID NOT NULL,
    "situation_id" UUID NOT NULL,
    "action" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "actor_id" UUID NOT NULL,
    "previous_lifecycle" "SituationLifecycle" NOT NULL,
    "result_lifecycle" "SituationLifecycle" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archive_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "actor_type" "IdentityType" NOT NULL,
    "actor_id" UUID,
    "permission_snapshot" JSONB,
    "action" VARCHAR(120) NOT NULL,
    "target_type" VARCHAR(60) NOT NULL,
    "target_id" VARCHAR(120),
    "target_version" VARCHAR(120),
    "request_id" UUID,
    "correlation_id" UUID NOT NULL,
    "ip_hash" CHAR(64),
    "user_agent_class" VARCHAR(80),
    "before_metadata" JSONB,
    "after_metadata" JSONB,
    "outcome" VARCHAR(30) NOT NULL,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "route" VARCHAR(160) NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_ref" VARCHAR(160),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_incidents" (
    "id" UUID NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "state" VARCHAR(30) NOT NULL,
    "evidence" JSONB,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,

    CONSTRAINT "system_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_state_username_idx" ON "users"("state", "username");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_expiry_idx" ON "sessions"("user_id", "absolute_expires_at");

-- CreateIndex
CREATE INDEX "login_throttles_blocked_until_idx" ON "login_throttles"("blocked_until");

-- CreateIndex
CREATE UNIQUE INDEX "login_throttles_key_kind_key_hash_key" ON "login_throttles"("key_kind", "key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "activation_tokens_token_hash_key" ON "activation_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "activation_tokens_subject_idx" ON "activation_tokens"("user_id", "kind", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "repository_snapshots_commit_sha_key" ON "repository_snapshots"("commit_sha");

-- CreateIndex
CREATE UNIQUE INDEX "situations_slug_key" ON "situations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "situations_current_publication_id_key" ON "situations"("current_publication_id");

-- CreateIndex
CREATE INDEX "situations_inventory_idx" ON "situations"("lifecycle", "publication_state", "title");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_logical_id_key" ON "artifacts"("logical_id");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_canonical_path_key" ON "artifacts"("canonical_path");

-- CreateIndex
CREATE INDEX "artifacts_type_active_idx" ON "artifacts"("type", "active");

-- CreateIndex
CREATE INDEX "artifact_edges_target_idx" ON "artifact_edges"("target_id", "edge_type");

-- CreateIndex
CREATE UNIQUE INDEX "artifact_edges_snapshot_id_source_id_target_id_edge_type_key" ON "artifact_edges"("snapshot_id", "source_id", "target_id", "edge_type");

-- CreateIndex
CREATE INDEX "situation_versions_timeline_idx" ON "situation_versions"("situation_id", "created_at");

-- CreateIndex
CREATE INDEX "drafts_situation_active_idx" ON "drafts"("situation_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "draft_revisions_draft_id_revision_key" ON "draft_revisions"("draft_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "draft_revisions_draft_id_client_mutation_id_key" ON "draft_revisions"("draft_id", "client_mutation_id");

-- CreateIndex
CREATE INDEX "checkouts_situation_active_idx" ON "situation_checkouts"("situation_id", "released_at");

-- CreateIndex
CREATE INDEX "checkouts_holder_active_idx" ON "situation_checkouts"("holder_user_id", "released_at");

-- CreateIndex
CREATE INDEX "checkout_resources_active_idx" ON "checkout_resources"("resource_key", "released_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_current_brief_id_key" ON "conversations"("current_brief_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_conversation_id_sequence_key" ON "conversation_messages"("conversation_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "shared_understanding_briefs_conversation_id_hash_key" ON "shared_understanding_briefs"("conversation_id", "hash");

-- CreateIndex
CREATE INDEX "brief_confirmations_valid_idx" ON "brief_confirmations"("brief_id", "invalidated_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_accounts_provider_label_key" ON "provider_accounts"("provider", "label");

-- CreateIndex
CREATE INDEX "ai_jobs_queue_idx" ON "ai_jobs"("state", "priority", "queue_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "ai_jobs_owner_id_idempotency_key_key" ON "ai_jobs"("owner_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "ai_jobs_situation_id_input_bundle_hash_brief_hash_workflow__key" ON "ai_jobs"("situation_id", "input_bundle_hash", "brief_hash", "workflow_version", "model_policy_version", "run_nonce");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_selected_run_id_key" ON "workflow_steps"("selected_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_steps_job_id_role_round_input_hash_key" ON "workflow_steps"("job_id", "role", "round", "input_hash");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_step_id_attempt_key" ON "agent_runs"("step_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "proposed_bundles_canonical_hash_key" ON "proposed_bundles"("canonical_hash");

-- CreateIndex
CREATE UNIQUE INDEX "proposed_bundles_situation_id_revision_key" ON "proposed_bundles"("situation_id", "revision");

-- CreateIndex
CREATE INDEX "comments_blocking_idx" ON "comments"("bundle_id", "status", "blocking");

-- CreateIndex
CREATE UNIQUE INDEX "validation_runs_bundle_id_validator_version_environment_has_key" ON "validation_runs"("bundle_id", "validator", "version", "environment_hash");

-- CreateIndex
CREATE INDEX "approvals_valid_idx" ON "approvals"("bundle_id", "invalidated_at");

-- CreateIndex
CREATE UNIQUE INDEX "publication_requests_publication_uuid_key" ON "publication_requests"("publication_uuid");

-- CreateIndex
CREATE INDEX "publication_requests_active_idx" ON "publication_requests"("target_environment", "state");

-- CreateIndex
CREATE UNIQUE INDEX "publication_requests_requested_by_id_idempotency_key_key" ON "publication_requests"("requested_by_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "publication_requests_target_environment_bundle_hash_key" ON "publication_requests"("target_environment", "bundle_hash");

-- CreateIndex
CREATE UNIQUE INDEX "publication_steps_request_id_step_attempt_key" ON "publication_steps"("request_id", "step", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "publications_request_id_key" ON "publications"("request_id");

-- CreateIndex
CREATE INDEX "publications_timeline_idx" ON "publications"("situation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "publications_commit_sha_situation_id_key" ON "publications"("commit_sha", "situation_id");

-- CreateIndex
CREATE INDEX "audit_events_actor_idx" ON "audit_events"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_target_idx" ON "audit_events"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_created_idx" ON "audit_events"("created_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_actor_id_route_key_key" ON "idempotency_keys"("actor_id", "route", "key");

-- CreateIndex
CREATE INDEX "system_incidents_open_idx" ON "system_incidents"("state", "severity", "detected_at");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_grants" ADD CONSTRAINT "user_permission_grants_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_tokens" ADD CONSTRAINT "activation_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activation_tokens" ADD CONSTRAINT "activation_tokens_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situations" ADD CONSTRAINT "situations_current_publication_id_fkey" FOREIGN KEY ("current_publication_id") REFERENCES "publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_primary_situation_id_fkey" FOREIGN KEY ("primary_situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_repository_snapshot_id_fkey" FOREIGN KEY ("repository_snapshot_id") REFERENCES "repository_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_edges" ADD CONSTRAINT "artifact_edges_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "repository_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_edges" ADD CONSTRAINT "artifact_edges_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_edges" ADD CONSTRAINT "artifact_edges_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_versions" ADD CONSTRAINT "situation_versions_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_versions" ADD CONSTRAINT "situation_versions_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "repository_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "version_artifacts" ADD CONSTRAINT "version_artifacts_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "situation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "version_artifacts" ADD CONSTRAINT "version_artifacts_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "version_artifacts" ADD CONSTRAINT "version_artifacts_content_hash_fkey" FOREIGN KEY ("content_hash") REFERENCES "content_blobs"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_base_version_id_fkey" FOREIGN KEY ("base_version_id") REFERENCES "situation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_base_snapshot_id_fkey" FOREIGN KEY ("base_snapshot_id") REFERENCES "repository_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_revisions" ADD CONSTRAINT "draft_revisions_parent_revision_id_fkey" FOREIGN KEY ("parent_revision_id") REFERENCES "draft_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_artifacts" ADD CONSTRAINT "draft_artifacts_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "draft_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_artifacts" ADD CONSTRAINT "draft_artifacts_content_hash_fkey" FOREIGN KEY ("content_hash") REFERENCES "content_blobs"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_checkouts" ADD CONSTRAINT "situation_checkouts_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_checkouts" ADD CONSTRAINT "situation_checkouts_holder_user_id_fkey" FOREIGN KEY ("holder_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "situation_checkouts" ADD CONSTRAINT "situation_checkouts_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_resources" ADD CONSTRAINT "checkout_resources_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "situation_checkouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_resources" ADD CONSTRAINT "checkout_resources_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_current_brief_id_fkey" FOREIGN KEY ("current_brief_id") REFERENCES "shared_understanding_briefs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_understanding_briefs" ADD CONSTRAINT "shared_understanding_briefs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_confirmations" ADD CONSTRAINT "brief_confirmations_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "shared_understanding_briefs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ai_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_selected_run_id_fkey" FOREIGN KEY ("selected_run_id") REFERENCES "agent_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "workflow_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_provider_account_id_fkey" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_bundles" ADD CONSTRAINT "proposed_bundles_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_bundles" ADD CONSTRAINT "proposed_bundles_parent_bundle_id_fkey" FOREIGN KEY ("parent_bundle_id") REFERENCES "proposed_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_bundles" ADD CONSTRAINT "proposed_bundles_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "repository_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_bundles" ADD CONSTRAINT "proposed_bundles_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_bundles" ADD CONSTRAINT "proposed_bundles_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "shared_understanding_briefs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_bundles" ADD CONSTRAINT "proposed_bundles_ai_job_id_fkey" FOREIGN KEY ("ai_job_id") REFERENCES "ai_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_artifacts" ADD CONSTRAINT "bundle_artifacts_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "proposed_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_artifacts" ADD CONSTRAINT "bundle_artifacts_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bundle_artifacts" ADD CONSTRAINT "bundle_artifacts_content_hash_fkey" FOREIGN KEY ("content_hash") REFERENCES "content_blobs"("hash") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "proposed_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "proposed_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "proposed_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "proposed_bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_requests" ADD CONSTRAINT "publication_requests_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_steps" ADD CONSTRAINT "publication_steps_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "publication_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "publication_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "archive_records" ADD CONSTRAINT "archive_records_situation_id_fkey" FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
