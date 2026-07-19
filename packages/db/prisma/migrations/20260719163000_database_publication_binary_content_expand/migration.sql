-- Checkpoint 2 additive support for managed binary source assets. Text blobs
-- retain their existing representation; binary blobs use binary_body while
-- the required legacy body column remains the empty-string compatibility value.
ALTER TYPE "ArtifactType" ADD VALUE IF NOT EXISTS 'ASSET';

CREATE TYPE "ContentEncoding" AS ENUM ('UTF8', 'BINARY');

ALTER TABLE "content_blobs"
  ADD COLUMN "encoding" "ContentEncoding" NOT NULL DEFAULT 'UTF8',
  ADD COLUMN "binary_body" bytea;

ALTER TABLE "content_blobs"
  DROP CONSTRAINT "content_blobs_exact_byte_length_check",
  DROP CONSTRAINT "content_blobs_digest_matches_check",
  ADD CONSTRAINT "content_blobs_encoding_body_check"
    CHECK (
      (
        "encoding" = 'UTF8'
        AND "binary_body" IS NULL
        AND "byte_length" = octet_length(convert_to("body", 'UTF8'))
        AND "hash" = encode(digest(convert_to("body", 'UTF8'), 'sha256'), 'hex')
      )
      OR
      (
        "encoding" = 'BINARY'
        AND "body" = ''
        AND "binary_body" IS NOT NULL
        AND "byte_length" = octet_length("binary_body")
        AND "hash" = encode(digest("binary_body", 'sha256'), 'hex')
      )
    ) NOT VALID;

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
          OR (
            blob."encoding" = 'UTF8'
            AND (
              blob."binary_body" IS NOT NULL
              OR blob."byte_length" <> octet_length(convert_to(blob."body", 'UTF8'))
              OR blob."hash" <> encode(digest(convert_to(blob."body", 'UTF8'), 'sha256'), 'hex')
            )
          )
          OR (
            blob."encoding" = 'BINARY'
            AND (
              blob."body" <> ''
              OR blob."binary_body" IS NULL
              OR blob."byte_length" <> octet_length(blob."binary_body")
              OR blob."hash" <> encode(digest(blob."binary_body", 'sha256'), 'hex')
            )
          )
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
  SELECT "byte_length", "body", "encoding", "binary_body" INTO expected_blob
    FROM "content_blobs" WHERE "hash" = NEW."content_hash" FOR KEY SHARE;
  IF NOT FOUND
    OR expected_blob."byte_length" <> NEW."byte_length"
    OR (
      expected_blob."encoding" = 'UTF8'
      AND (
        expected_blob."binary_body" IS NOT NULL
        OR NEW."byte_length" <> octet_length(convert_to(expected_blob."body", 'UTF8'))
        OR NEW."content_hash" <> encode(digest(convert_to(expected_blob."body", 'UTF8'), 'sha256'), 'hex')
      )
    )
    OR (
      expected_blob."encoding" = 'BINARY'
      AND (
        expected_blob."body" <> ''
        OR expected_blob."binary_body" IS NULL
        OR NEW."byte_length" <> octet_length(expected_blob."binary_body")
        OR NEW."content_hash" <> encode(digest(expected_blob."binary_body", 'sha256'), 'hex')
      )
    )
  THEN
    RAISE EXCEPTION 'snapshot artifact content does not match immutable blob';
  END IF;
  RETURN NEW;
END;
$$;
