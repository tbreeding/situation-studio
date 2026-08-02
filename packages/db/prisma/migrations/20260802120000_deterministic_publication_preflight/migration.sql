-- Pin every review and proposal to the exact immutable Studio revision it
-- consumed. Existing rows are backfilled from their already-pinned inputs.
ALTER TABLE "review_jobs"
  ADD COLUMN "input_bundle_hash" CHAR(64);

ALTER TABLE "review_proposals"
  ADD COLUMN "input_bundle_hash" CHAR(64),
  ADD COLUMN "current_revision_id" UUID,
  ADD COLUMN "current_bundle_hash" CHAR(64),
  ADD COLUMN "superseded_at" TIMESTAMPTZ(3),
  ADD COLUMN "superseded_by_revision_id" UUID;

-- The prior release rejects every proposal update. Drop that trigger before
-- deriving historical fences; the migration is transactional, so no runtime
-- observes an unprotected intermediate table.
DROP TRIGGER "review_proposals_immutable_update" ON "review_proposals";

-- These compatibility triggers let the prior web/worker release continue to
-- insert rows during an additive migration-before-cutover deployment. New
-- writers send the fields explicitly; either way PostgreSQL verifies them
-- against the immutable input revision.
CREATE FUNCTION populate_review_job_input_bundle_hash()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_hash CHAR(64);
BEGIN
  SELECT revision."bundle_hash"
    INTO expected_hash
    FROM "draft_revisions" AS revision
    JOIN "drafts" AS draft ON draft."id" = revision."draft_id"
   WHERE revision."id" = NEW."input_revision_id"
     AND draft."situation_id" = NEW."situation_id";
  IF expected_hash IS NULL THEN
    RAISE EXCEPTION 'review job input revision is unavailable'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."input_bundle_hash" IS NULL THEN
    NEW."input_bundle_hash" := expected_hash;
  ELSIF NEW."input_bundle_hash" IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION 'review job input bundle hash is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "review_jobs_populate_input_bundle_hash"
BEFORE INSERT ON "review_jobs"
FOR EACH ROW EXECUTE FUNCTION populate_review_job_input_bundle_hash();

CREATE FUNCTION enforce_review_job_input_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."situation_id" IS DISTINCT FROM OLD."situation_id"
     OR NEW."input_revision_id" IS DISTINCT FROM OLD."input_revision_id"
     OR NEW."input_bundle_hash" IS DISTINCT FROM OLD."input_bundle_hash"
     OR NEW."checkout_id" IS DISTINCT FROM OLD."checkout_id"
     OR NEW."checkout_fence" IS DISTINCT FROM OLD."checkout_fence"
     OR NEW."context_hash" IS DISTINCT FROM OLD."context_hash"
     OR NEW."contract_version" IS DISTINCT FROM OLD."contract_version"
     OR NEW."policy_version" IS DISTINCT FROM OLD."policy_version"
     OR NEW."queued_at" IS DISTINCT FROM OLD."queued_at"
  THEN
    RAISE EXCEPTION 'review job input identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION populate_review_proposal_revision_fences()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_input_hash CHAR(64);
  expected_current_hash CHAR(64);
  expected_input_revision UUID;
BEGIN
  SELECT job."input_revision_id", job."input_bundle_hash"
    INTO expected_input_revision, expected_input_hash
    FROM "review_jobs" AS job
    JOIN "draft_revisions" AS revision
      ON revision."id" = job."input_revision_id"
    JOIN "drafts" AS draft ON draft."id" = revision."draft_id"
   WHERE job."id" = NEW."job_id"
     AND draft."situation_id" = job."situation_id";
  IF expected_input_revision IS NULL OR expected_input_hash IS NULL THEN
    RAISE EXCEPTION 'review proposal input revision is unavailable'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."input_revision_id" IS DISTINCT FROM expected_input_revision THEN
    RAISE EXCEPTION 'review proposal input revision differs from its job'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."input_bundle_hash" IS NULL THEN
    NEW."input_bundle_hash" := expected_input_hash;
  ELSIF NEW."input_bundle_hash" IS DISTINCT FROM expected_input_hash THEN
    RAISE EXCEPTION 'review proposal input bundle hash is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."current_revision_id" IS NULL THEN
    NEW."current_revision_id" := NEW."input_revision_id";
  END IF;
  SELECT revision."bundle_hash"
    INTO expected_current_hash
    FROM "draft_revisions" AS revision
    JOIN "drafts" AS draft ON draft."id" = revision."draft_id"
    JOIN "review_jobs" AS job
      ON job."id" = NEW."job_id"
     AND job."situation_id" = draft."situation_id"
   WHERE revision."id" = NEW."current_revision_id";
  IF expected_current_hash IS NULL THEN
    RAISE EXCEPTION 'review proposal current revision fence is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."current_bundle_hash" IS NULL THEN
    NEW."current_bundle_hash" := expected_current_hash;
  ELSIF NEW."current_bundle_hash" IS DISTINCT FROM expected_current_hash THEN
    RAISE EXCEPTION 'review proposal current bundle hash is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF (NEW."superseded_at" IS NULL) <>
     (NEW."superseded_by_revision_id" IS NULL) THEN
    RAISE EXCEPTION 'review proposal supersession fields must be paired'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "review_proposals_populate_revision_fences"
BEFORE INSERT ON "review_proposals"
FOR EACH ROW EXECUTE FUNCTION populate_review_proposal_revision_fences();

UPDATE "review_jobs" AS job
SET "input_bundle_hash" = revision."bundle_hash"
FROM "draft_revisions" AS revision
WHERE revision."id" = job."input_revision_id";

CREATE TRIGGER "review_jobs_input_identity_immutable"
BEFORE UPDATE ON "review_jobs"
FOR EACH ROW EXECUTE FUNCTION enforce_review_job_input_identity();

-- Retained proposals may already have accepted changes. Their actionable
-- fence is the newest accepted applied revision, not necessarily the original
-- review input. If the checkout's draft moved beyond that accepted chain,
-- preserve the evidence but mark it explicitly superseded.
WITH derived_proposal_fences AS (
  SELECT proposal."id" AS proposal_id,
         input_revision."bundle_hash" AS input_bundle_hash,
         COALESCE(applied_revision."id", input_revision."id") AS decision_revision_id,
         COALESCE(applied_revision."bundle_hash", input_revision."bundle_hash") AS decision_bundle_hash,
         workspace_revision."id" AS workspace_revision_id
    FROM "review_proposals" AS proposal
    JOIN "review_jobs" AS job ON job."id" = proposal."job_id"
    JOIN "draft_revisions" AS input_revision
      ON input_revision."id" = proposal."input_revision_id"
    JOIN "situation_checkouts" AS checkout ON checkout."id" = job."checkout_id"
    JOIN "drafts" AS workspace_draft ON workspace_draft."id" = checkout."draft_id"
    LEFT JOIN "draft_revisions" AS workspace_revision
      ON workspace_revision."draft_id" = workspace_draft."id"
     AND workspace_revision."revision" = workspace_draft."current_revision_number"
    LEFT JOIN LATERAL (
      SELECT revision."id", revision."bundle_hash"
        FROM "proposal_changes" AS change
        JOIN "draft_revisions" AS revision
          ON revision."id" = change."applied_revision_id"
       WHERE change."proposal_id" = proposal."id"
         AND change."state" = 'ACCEPTED'
         AND change."applied_revision_id" IS NOT NULL
       ORDER BY revision."revision" DESC, revision."created_at" DESC, revision."id" DESC
       LIMIT 1
    ) AS applied_revision ON true
)
UPDATE "review_proposals" AS proposal
   SET "input_bundle_hash" = derived."input_bundle_hash",
       "current_revision_id" = derived."decision_revision_id",
       "current_bundle_hash" = derived."decision_bundle_hash",
       "superseded_at" = CASE
         WHEN derived."workspace_revision_id" IS NOT NULL
          AND derived."workspace_revision_id" IS DISTINCT FROM derived."decision_revision_id"
         THEN CURRENT_TIMESTAMP
         ELSE NULL
       END,
       "superseded_by_revision_id" = CASE
         WHEN derived."workspace_revision_id" IS NOT NULL
          AND derived."workspace_revision_id" IS DISTINCT FROM derived."decision_revision_id"
         THEN derived."workspace_revision_id"
         ELSE NULL
       END
  FROM derived_proposal_fences AS derived
 WHERE proposal."id" = derived."proposal_id";

ALTER TABLE "review_jobs"
  ALTER COLUMN "input_bundle_hash" SET NOT NULL;

ALTER TABLE "review_proposals"
  ALTER COLUMN "input_bundle_hash" SET NOT NULL,
  ALTER COLUMN "current_revision_id" SET NOT NULL,
  ALTER COLUMN "current_bundle_hash" SET NOT NULL;

ALTER TABLE "review_proposals"
  ADD CONSTRAINT "review_proposals_current_revision_id_fkey"
  FOREIGN KEY ("current_revision_id") REFERENCES "draft_revisions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "review_proposals_superseded_by_revision_id_fkey"
  FOREIGN KEY ("superseded_by_revision_id") REFERENCES "draft_revisions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "review_proposals_current_revision_idx"
  ON "review_proposals"("current_revision_id", "current_bundle_hash");
CREATE INDEX "review_proposals_superseded_idx"
  ON "review_proposals"("superseded_at");

-- Proposal evidence remains immutable. Only its exact current-revision fence
-- and one-way supersession marker may advance as accepted changes create a
-- new authoritative revision.
CREATE FUNCTION enforce_review_proposal_fence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_revision_is_valid BOOLEAN;
  superseding_revision_is_valid BOOLEAN;
BEGIN
  IF TG_OP <> 'UPDATE'
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."job_id" IS DISTINCT FROM OLD."job_id"
     OR NEW."input_revision_id" IS DISTINCT FROM OLD."input_revision_id"
     OR NEW."input_bundle_hash" IS DISTINCT FROM OLD."input_bundle_hash"
     OR NEW."summary" IS DISTINCT FROM OLD."summary"
     OR NEW."findings" IS DISTINCT FROM OLD."findings"
     OR NEW."proposal_hash" IS DISTINCT FROM OLD."proposal_hash"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."superseded_at" IS NOT NULL AND NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at")
     OR (OLD."superseded_by_revision_id" IS NOT NULL AND NEW."superseded_by_revision_id" IS DISTINCT FROM OLD."superseded_by_revision_id")
     OR ((NEW."superseded_at" IS NULL) <> (NEW."superseded_by_revision_id" IS NULL))
     OR (OLD."superseded_at" IS NOT NULL AND (
       NEW."current_revision_id" IS DISTINCT FROM OLD."current_revision_id"
       OR NEW."current_bundle_hash" IS DISTINCT FROM OLD."current_bundle_hash"
     ))
  THEN
    RAISE EXCEPTION 'review_proposals immutable evidence changed'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM "draft_revisions" AS revision
      JOIN "drafts" AS draft ON draft."id" = revision."draft_id"
      JOIN "review_jobs" AS job
        ON job."id" = NEW."job_id"
       AND job."situation_id" = draft."situation_id"
     WHERE revision."id" = NEW."current_revision_id"
       AND revision."bundle_hash" = NEW."current_bundle_hash"
  ) INTO current_revision_is_valid;

  IF NOT current_revision_is_valid THEN
    RAISE EXCEPTION 'review proposal current revision fence is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."current_revision_id" IS DISTINCT FROM OLD."current_revision_id" THEN
    IF OLD."superseded_at" IS NOT NULL OR NEW."superseded_at" IS NOT NULL THEN
      RAISE EXCEPTION 'a superseded proposal cannot advance'
        USING ERRCODE = '55000';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM "draft_revisions" AS revision
        JOIN "drafts" AS draft ON draft."id" = revision."draft_id"
       WHERE revision."id" = NEW."current_revision_id"
         AND revision."parent_id" = OLD."current_revision_id"
         AND draft."current_revision_number" = revision."revision"
         AND draft."current_bundle_hash" = revision."bundle_hash"
    ) THEN
      RAISE EXCEPTION 'review proposal revision advances must follow parentage'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."superseded_by_revision_id" IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM "draft_revisions" AS revision
        JOIN "drafts" AS draft ON draft."id" = revision."draft_id"
        JOIN "review_jobs" AS job
          ON job."id" = NEW."job_id"
         AND job."situation_id" = draft."situation_id"
       WHERE revision."id" = NEW."superseded_by_revision_id"
         AND draft."current_revision_number" = revision."revision"
         AND draft."current_bundle_hash" = revision."bundle_hash"
    ) INTO superseding_revision_is_valid;
    IF NOT superseding_revision_is_valid THEN
      RAISE EXCEPTION 'review proposal superseding revision is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "review_proposals_fenced_update"
BEFORE UPDATE OR DELETE ON "review_proposals"
FOR EACH ROW EXECUTE FUNCTION enforce_review_proposal_fence_mutation();

-- The prior web release records an accepted change's applied revision but
-- does not know the new proposal fence columns. Advance that fence from the
-- same durable fact during a rolling cutover. The new web release performs an
-- equivalent explicit update; repeating the same identity is harmless.
CREATE FUNCTION advance_review_proposal_from_applied_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."state" = 'ACCEPTED'
     AND NEW."applied_revision_id" IS NOT NULL
     AND (
       OLD."state" IS DISTINCT FROM NEW."state"
       OR OLD."applied_revision_id" IS DISTINCT FROM NEW."applied_revision_id"
     )
  THEN
    UPDATE "review_proposals" AS proposal
       SET "current_revision_id" = revision."id",
           "current_bundle_hash" = revision."bundle_hash"
      FROM "draft_revisions" AS revision
     WHERE proposal."id" = NEW."proposal_id"
       AND revision."id" = NEW."applied_revision_id"
       AND proposal."superseded_at" IS NULL
       AND proposal."current_revision_id" IN (
         revision."id",
         revision."parent_id"
       );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "proposal_changes_advance_review_fence"
AFTER UPDATE OF "state", "applied_revision_id" ON "proposal_changes"
FOR EACH ROW EXECUTE FUNCTION advance_review_proposal_from_applied_change();

-- A passed preflight owns the publication/release IDs and all exact candidate
-- bytes before a queue row exists. Nothing in the publisher may recompile or
-- rebase this identity in place.
CREATE TABLE "publication_preflight_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "publication_id" UUID NOT NULL,
  "release_id" UUID NOT NULL,
  "situation_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "checkout_id" UUID NOT NULL,
  "checkout_fence" BIGINT NOT NULL,
  "revision_bundle_hash" CHAR(64) NOT NULL,
  "candidate_hash" CHAR(64) NOT NULL,
  "base_release_id" UUID NOT NULL,
  "base_manifest_hash" CHAR(64) NOT NULL,
  "expected_pointer_generation" BIGINT NOT NULL,
  "contract_identity" JSONB NOT NULL,
  "contract_digest" CHAR(64) NOT NULL,
  "validation_result" VARCHAR(40) NOT NULL,
  "diagnostics" JSONB NOT NULL,
  "route_expectations" JSONB NOT NULL,
  "source_kind" "ProductionSourceKind" NOT NULL,
  "manifest_hash" CHAR(64) NOT NULL,
  "manifest_body" TEXT NOT NULL,
  "artifact_count" INTEGER NOT NULL,
  "edge_count" INTEGER NOT NULL,
  "total_byte_length" BIGINT NOT NULL,
  "compiled_projection" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sealed_at" TIMESTAMPTZ(3),
  CONSTRAINT "publication_preflight_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_preflight_validation_passed"
    CHECK ("validation_result" = 'PASSED'),
  CONSTRAINT "publication_preflight_artifact_count_nonnegative"
    CHECK ("artifact_count" >= 1),
  CONSTRAINT "publication_preflight_edge_count_nonnegative"
    CHECK ("edge_count" >= 0),
  CONSTRAINT "publication_preflight_total_bytes_nonnegative"
    CHECK ("total_byte_length" >= 0)
);

CREATE UNIQUE INDEX "publication_preflight_receipts_publication_id_key"
  ON "publication_preflight_receipts"("publication_id");
CREATE UNIQUE INDEX "publication_preflight_receipts_release_id_key"
  ON "publication_preflight_receipts"("release_id");
CREATE UNIQUE INDEX "publication_preflight_receipts_candidate_hash_key"
  ON "publication_preflight_receipts"("candidate_hash");
CREATE INDEX "publication_preflight_revision_idx"
  ON "publication_preflight_receipts"
    ("revision_id", "revision_bundle_hash", "created_at");
CREATE INDEX "publication_preflight_situation_idx"
  ON "publication_preflight_receipts"("situation_id", "created_at");

ALTER TABLE "publication_preflight_receipts"
  ADD CONSTRAINT "publication_preflight_situation_id_fkey"
  FOREIGN KEY ("situation_id") REFERENCES "situations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_preflight_revision_id_fkey"
  FOREIGN KEY ("revision_id") REFERENCES "draft_revisions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_preflight_checkout_id_fkey"
  FOREIGN KEY ("checkout_id") REFERENCES "situation_checkouts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "publication_candidate_artifacts" (
  "receipt_id" UUID NOT NULL,
  "logical_id" VARCHAR(240) NOT NULL,
  "position" INTEGER NOT NULL,
  "artifact_type" VARCHAR(40) NOT NULL,
  "path" VARCHAR(1000) NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "byte_length" INTEGER NOT NULL,
  "encoding" "ContentEncoding" NOT NULL,
  "media_type" VARCHAR(120) NOT NULL,
  "bytes" BYTEA NOT NULL,
  CONSTRAINT "publication_candidate_artifacts_pkey"
    PRIMARY KEY ("receipt_id", "logical_id"),
  CONSTRAINT "publication_candidate_artifacts_position_nonnegative"
    CHECK ("position" >= 0),
  CONSTRAINT "publication_candidate_artifacts_length_matches"
    CHECK ("byte_length" = octet_length("bytes"))
);

CREATE UNIQUE INDEX "publication_candidate_artifacts_position_key"
  ON "publication_candidate_artifacts"("receipt_id", "position");

ALTER TABLE "publication_candidate_artifacts"
  ADD CONSTRAINT "publication_candidate_artifacts_receipt_id_fkey"
  FOREIGN KEY ("receipt_id") REFERENCES "publication_preflight_receipts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publication_jobs"
  ADD COLUMN "preflight_receipt_id" UUID,
  ADD COLUMN "candidate_hash" CHAR(64),
  ADD COLUMN "legacy_preflight_exempt" BOOLEAN;

-- Only rows which predate this migration may remain receipt-less. New inserts
-- cannot opt themselves into this exemption; the trigger below rejects them.
UPDATE "publication_jobs"
   SET "legacy_preflight_exempt" = TRUE;
ALTER TABLE "publication_jobs"
  ALTER COLUMN "legacy_preflight_exempt" SET DEFAULT FALSE,
  ALTER COLUMN "legacy_preflight_exempt" SET NOT NULL;

CREATE UNIQUE INDEX "publication_jobs_preflight_receipt_id_key"
  ON "publication_jobs"("preflight_receipt_id");

ALTER TABLE "publication_jobs"
  ADD CONSTRAINT "publication_jobs_preflight_receipt_id_fkey"
  FOREIGN KEY ("preflight_receipt_id") REFERENCES "publication_preflight_receipts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "publication_jobs_preflight_identity_pair"
  CHECK (
    (
      "legacy_preflight_exempt" = TRUE
      AND "preflight_receipt_id" IS NULL
      AND "candidate_hash" IS NULL
    )
    OR (
      "legacy_preflight_exempt" = FALSE
      AND "preflight_receipt_id" IS NOT NULL
      AND "candidate_hash" IS NOT NULL
    )
  );

-- Keep the queue row and its immutable receipt as one database-enforced
-- publication identity. Null receipts remain valid only for historical rows
-- created before this additive migration; the new publisher quarantines any
-- such row that is still nonterminal.
CREATE FUNCTION enforce_publication_job_preflight_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt RECORD;
BEGIN
  IF TG_OP = 'INSERT' AND NEW."preflight_receipt_id" IS NULL THEN
    RAISE EXCEPTION 'new publication jobs require a sealed preflight receipt'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."preflight_receipt_id" IS DISTINCT FROM OLD."preflight_receipt_id"
       OR NEW."legacy_preflight_exempt" IS DISTINCT FROM OLD."legacy_preflight_exempt"
    THEN
      RAISE EXCEPTION 'publication job preflight identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD."preflight_receipt_id" IS NOT NULL
       AND (
         NEW."publication_id" IS DISTINCT FROM OLD."publication_id"
         OR NEW."situation_id" IS DISTINCT FROM OLD."situation_id"
         OR NEW."target_revision_id" IS DISTINCT FROM OLD."target_revision_id"
         OR NEW."checkout_id" IS DISTINCT FROM OLD."checkout_id"
         OR NEW."checkout_fence" IS DISTINCT FROM OLD."checkout_fence"
         OR NEW."source_kind" IS DISTINCT FROM OLD."source_kind"
         OR NEW."target_bundle_hash" IS DISTINCT FROM OLD."target_bundle_hash"
         OR NEW."candidate_hash" IS DISTINCT FROM OLD."candidate_hash"
         OR NEW."expected_pointer_generation" IS DISTINCT FROM OLD."expected_pointer_generation"
         OR NEW."previous_release_id" IS DISTINCT FROM OLD."previous_release_id"
       )
    THEN
      RAISE EXCEPTION 'publication job receipt-linked identity is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW."preflight_receipt_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO receipt
    FROM "publication_preflight_receipts"
   WHERE "id" = NEW."preflight_receipt_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication preflight receipt is unavailable'
      USING ERRCODE = '23503';
  END IF;

  IF receipt."sealed_at" IS NULL THEN
    RAISE EXCEPTION 'publication preflight receipt is not sealed'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."publication_id" IS DISTINCT FROM receipt."publication_id"
     OR NEW."situation_id" IS DISTINCT FROM receipt."situation_id"
     OR NEW."target_revision_id" IS DISTINCT FROM receipt."revision_id"
     OR NEW."checkout_id" IS DISTINCT FROM receipt."checkout_id"
     OR NEW."checkout_fence" IS DISTINCT FROM receipt."checkout_fence"
     OR NEW."source_kind" IS DISTINCT FROM receipt."source_kind"
     OR NEW."target_bundle_hash" IS DISTINCT FROM receipt."revision_bundle_hash"
     OR NEW."candidate_hash" IS DISTINCT FROM receipt."candidate_hash"
     OR NEW."expected_pointer_generation" IS DISTINCT FROM receipt."expected_pointer_generation"
     OR NEW."previous_release_id" IS DISTINCT FROM receipt."base_release_id"
     OR NEW."legacy_preflight_exempt" IS DISTINCT FROM FALSE
  THEN
    RAISE EXCEPTION 'publication job identity differs from its preflight receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_jobs_enforce_preflight_identity
BEFORE INSERT OR UPDATE ON "publication_jobs"
FOR EACH ROW EXECUTE FUNCTION enforce_publication_job_preflight_identity();

-- Candidate evidence is assembled and sealed in one transaction. Artifact
-- inserts take a lock on the owning receipt and are allowed only before its
-- one-way seal. Updates and deletes are never allowed.
CREATE FUNCTION enforce_publication_candidate_artifact_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  receipt_sealed_at TIMESTAMPTZ(3);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'publication preflight candidate artifacts are immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT receipt."sealed_at"
    INTO receipt_sealed_at
    FROM "publication_preflight_receipts" AS receipt
   WHERE receipt."id" = NEW."receipt_id"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'publication preflight receipt is unavailable'
      USING ERRCODE = '23503';
  END IF;
  IF receipt_sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'publication preflight receipt is already sealed'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_candidate_artifacts_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "publication_candidate_artifacts"
FOR EACH ROW EXECUTE FUNCTION enforce_publication_candidate_artifact_immutability();

-- A receipt may make exactly one transition: unsealed to sealed. That
-- transition verifies that the immutable artifact set is complete and that
-- its byte accounting matches the compiler output. Every other mutation and
-- all deletes are rejected.
CREATE FUNCTION enforce_publication_preflight_receipt_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actual_artifact_count BIGINT;
  actual_total_byte_length BIGINT;
  minimum_position INTEGER;
  maximum_position INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication preflight receipts are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."sealed_at" IS NOT NULL
     OR NEW."sealed_at" IS NULL
     OR (to_jsonb(NEW) - 'sealed_at') IS DISTINCT FROM
        (to_jsonb(OLD) - 'sealed_at')
  THEN
    RAISE EXCEPTION 'publication preflight receipt may only be sealed once'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*),
         COALESCE(sum(artifact."byte_length"), 0),
         min(artifact."position"),
         max(artifact."position")
    INTO actual_artifact_count,
         actual_total_byte_length,
         minimum_position,
         maximum_position
    FROM "publication_candidate_artifacts" AS artifact
   WHERE artifact."receipt_id" = NEW."id";
  IF actual_artifact_count IS DISTINCT FROM NEW."artifact_count"::BIGINT
     OR actual_total_byte_length IS DISTINCT FROM NEW."total_byte_length"
     OR minimum_position IS DISTINCT FROM 0
     OR maximum_position IS DISTINCT FROM NEW."artifact_count" - 1
  THEN
    RAISE EXCEPTION 'publication preflight artifact set is incomplete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER publication_preflight_receipts_immutable
BEFORE UPDATE OR DELETE ON "publication_preflight_receipts"
FOR EACH ROW EXECUTE FUNCTION enforce_publication_preflight_receipt_immutability();
