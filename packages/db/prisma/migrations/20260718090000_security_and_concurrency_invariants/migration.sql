-- Invariants that Prisma cannot express. All names are stable and test-addressable.

ALTER TABLE "users"
  ADD CONSTRAINT "users_username_normalized_check"
    CHECK ("username" = lower(btrim("username")) AND "username" ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'),
  ADD CONSTRAINT "users_display_name_nonempty_check"
    CHECK (char_length(btrim("display_name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT "users_identity_password_check"
    CHECK (("identity_type" = 'HUMAN' AND ("state" = 'PENDING_ACTIVATION' OR "password_hash" LIKE '$argon2id$%')) OR ("identity_type" <> 'HUMAN' AND "password_hash" IS NULL));

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_token_hash_check" CHECK ("token_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "sessions_csrf_hash_check" CHECK ("csrf_secret_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "sessions_expiry_check" CHECK ("idle_expires_at" > "created_at" AND "absolute_expires_at" >= "idle_expires_at");

ALTER TABLE "situations"
  ADD CONSTRAINT "situations_slug_normalized_check" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

ALTER TABLE "repository_snapshots"
  ADD CONSTRAINT "repository_snapshots_commit_check" CHECK ("commit_sha" ~ '^[a-f0-9]{40}$'),
  ADD CONSTRAINT "repository_snapshots_manifest_hash_check" CHECK ("manifest_hash" ~ '^[a-f0-9]{64}$');

ALTER TABLE "content_blobs"
  ADD CONSTRAINT "content_blobs_hash_check" CHECK ("hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "content_blobs_length_check" CHECK ("byte_length" >= 0);

ALTER TABLE "checkout_resources"
  ADD CONSTRAINT "checkout_resources_one_subject_check"
    CHECK ((("artifact_id" IS NOT NULL)::int + ("situation_id" IS NOT NULL)::int) = 1);

ALTER TABLE "bundle_artifacts"
  ADD CONSTRAINT "bundle_artifacts_no_change_rationale_check"
    CHECK ("change_kind" <> 'NO_CHANGE' OR char_length(btrim("no_change_rationale")) > 0);

CREATE UNIQUE INDEX "drafts_one_active_per_situation_idx"
  ON "drafts" ("situation_id") WHERE "active" = true;

CREATE UNIQUE INDEX "situation_checkouts_one_unreleased_idx"
  ON "situation_checkouts" ("situation_id") WHERE "released_at" IS NULL;

CREATE UNIQUE INDEX "checkout_resources_one_unreleased_key_idx"
  ON "checkout_resources" ("resource_key") WHERE "released_at" IS NULL;

CREATE UNIQUE INDEX "ai_jobs_one_running_full_review_idx"
  ON "ai_jobs" ((1)) WHERE "kind" = 'FULL_REVIEW' AND "state" = 'RUNNING';

CREATE UNIQUE INDEX "publication_requests_one_active_target_idx"
  ON "publication_requests" ("target_environment")
  WHERE "state" IN ('REQUESTED', 'WORKTREE_READY', 'APPLIED', 'VALIDATED', 'COMMITTED', 'PUSHED', 'PREVIEW_BUILT', 'PREVIEW_VERIFIED', 'AWAITING_CONFIRMATION', 'CUTOVER', 'LIVE_VERIFIED', 'RECONCILIATION_REQUIRED');

CREATE OR REPLACE FUNCTION prevent_row_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_row_change();

CREATE TRIGGER "conversation_messages_append_only"
  BEFORE UPDATE OR DELETE ON "conversation_messages"
  FOR EACH ROW EXECUTE FUNCTION prevent_row_change();

CREATE TRIGGER "draft_revisions_append_only"
  BEFORE UPDATE OR DELETE ON "draft_revisions"
  FOR EACH ROW EXECUTE FUNCTION prevent_row_change();

CREATE TRIGGER "archive_records_append_only"
  BEFORE UPDATE OR DELETE ON "archive_records"
  FOR EACH ROW EXECUTE FUNCTION prevent_row_change();

CREATE TRIGGER "publications_append_only"
  BEFORE UPDATE OR DELETE ON "publications"
  FOR EACH ROW EXECUTE FUNCTION prevent_row_change();

CREATE OR REPLACE FUNCTION enforce_human_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_type "IdentityType";
BEGIN
  SELECT "identity_type" INTO actor_type FROM "users" WHERE "id" = NEW."approved_by_id" FOR KEY SHARE;
  IF actor_type IS DISTINCT FROM 'HUMAN' THEN
    RAISE EXCEPTION 'only a human identity can approve a bundle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "approvals_human_actor"
  BEFORE INSERT ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION enforce_human_approval();

CREATE OR REPLACE FUNCTION protect_approval_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'approvals are append-only'; END IF;
  IF NEW."id" <> OLD."id"
    OR NEW."bundle_id" <> OLD."bundle_id"
    OR NEW."bundle_hash" <> OLD."bundle_hash"
    OR NEW."base_commit" <> OLD."base_commit"
    OR NEW."validation_policy_hash" <> OLD."validation_policy_hash"
    OR NEW."approved_by_id" <> OLD."approved_by_id"
    OR NEW."session_id" <> OLD."session_id"
    OR NEW."permission_snapshot" <> OLD."permission_snapshot"
    OR NEW."approved_at" <> OLD."approved_at"
  THEN RAISE EXCEPTION 'approval evidence is immutable'; END IF;
  IF OLD."invalidated_at" IS NOT NULL AND (NEW."invalidated_at" IS DISTINCT FROM OLD."invalidated_at" OR NEW."invalidation_reason" IS DISTINCT FROM OLD."invalidation_reason")
  THEN RAISE EXCEPTION 'approval invalidation is immutable once recorded'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "approvals_protect_evidence"
  BEFORE UPDATE OR DELETE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION protect_approval_immutability();

CREATE OR REPLACE FUNCTION enforce_human_brief_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_type "IdentityType";
BEGIN
  SELECT "identity_type" INTO actor_type FROM "users" WHERE "id" = NEW."actor_id" FOR KEY SHARE;
  IF actor_type IS DISTINCT FROM 'HUMAN' THEN
    RAISE EXCEPTION 'only a human identity can confirm shared understanding';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "brief_confirmations_human_actor"
  BEFORE INSERT ON "brief_confirmations"
  FOR EACH ROW EXECUTE FUNCTION enforce_human_brief_confirmation();

CREATE OR REPLACE FUNCTION fence_checkout_release()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."released_at" IS NULL AND NEW."released_at" IS NOT NULL THEN
    UPDATE "situations" SET "fence" = "fence" + 1, "updated_at" = now() WHERE "id" = OLD."situation_id";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "situation_checkouts_release_fence"
  AFTER UPDATE OF "released_at" ON "situation_checkouts"
  FOR EACH ROW EXECUTE FUNCTION fence_checkout_release();
