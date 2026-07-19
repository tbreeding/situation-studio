-- Database-native rollback identifies immutable snapshots directly. Legacy
-- Git-era rollback identities remain nullable and readable for history.
ALTER TABLE "rollback_requests"
  ALTER COLUMN "situation_id" DROP NOT NULL,
  ALTER COLUMN "target_publication_id" DROP NOT NULL,
  ALTER COLUMN "expected_current_publication_id" DROP NOT NULL,
  ADD COLUMN "expected_current_content_snapshot_id" UUID,
  ADD COLUMN "expected_current_content_snapshot_hash" CHAR(64),
  ADD CONSTRAINT "rollback_requests_expected_snapshot_pair_check"
    CHECK (num_nonnulls("expected_current_content_snapshot_id", "expected_current_content_snapshot_hash") IN (0, 2)),
  ADD CONSTRAINT "rollback_requests_expected_snapshot_hash_check"
    CHECK ("expected_current_content_snapshot_hash" IS NULL OR "expected_current_content_snapshot_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "rollback_requests_expected_current_content_snapshot_id_fkey"
    FOREIGN KEY ("expected_current_content_snapshot_id") REFERENCES "content_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION protect_database_rollback_request()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_row record;
  selected_hash char(64);
  current_hash char(64);
  requester_type "IdentityType";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'database rollback requests cannot be deleted';
  END IF;
  IF NEW."publication_target_id" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO target_row FROM "publication_targets"
      WHERE "id" = NEW."publication_target_id" FOR UPDATE;
    SELECT "manifest_hash" INTO selected_hash FROM "content_snapshots"
      WHERE "id" = NEW."target_content_snapshot_id" AND "validation_state" = 'VALIDATED'
      FOR KEY SHARE;
    SELECT "manifest_hash" INTO current_hash FROM "content_snapshots"
      WHERE "id" = NEW."expected_current_content_snapshot_id" AND "validation_state" = 'VALIDATED'
      FOR KEY SHARE;
    SELECT "identity_type" INTO requester_type FROM "users"
      WHERE "id" = NEW."requested_by_id" FOR KEY SHARE;
    IF target_row."official_snapshot_id" IS DISTINCT FROM NEW."expected_current_content_snapshot_id"
      OR current_hash IS DISTINCT FROM NEW."expected_current_content_snapshot_hash"
      OR selected_hash IS DISTINCT FROM NEW."target_content_snapshot_hash"
      OR NEW."target_content_snapshot_id" = NEW."expected_current_content_snapshot_id"
      OR requester_type IS DISTINCT FROM 'HUMAN'
    THEN RAISE EXCEPTION 'database rollback request does not identify an exact prior snapshot'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id"
    OR NEW."rollback_uuid" <> OLD."rollback_uuid"
    OR NEW."idempotency_key" <> OLD."idempotency_key"
    OR NEW."target_environment" <> OLD."target_environment"
    OR NEW."publication_target_id" IS DISTINCT FROM OLD."publication_target_id"
    OR NEW."target_content_snapshot_id" IS DISTINCT FROM OLD."target_content_snapshot_id"
    OR NEW."target_content_snapshot_hash" IS DISTINCT FROM OLD."target_content_snapshot_hash"
    OR NEW."expected_current_content_snapshot_id" IS DISTINCT FROM OLD."expected_current_content_snapshot_id"
    OR NEW."expected_current_content_snapshot_hash" IS DISTINCT FROM OLD."expected_current_content_snapshot_hash"
    OR NEW."situation_id" IS DISTINCT FROM OLD."situation_id"
    OR NEW."target_publication_id" IS DISTINCT FROM OLD."target_publication_id"
    OR NEW."expected_current_publication_id" IS DISTINCT FROM OLD."expected_current_publication_id"
    OR NEW."requested_by_id" <> OLD."requested_by_id"
    OR NEW."reason" <> OLD."reason"
    OR NEW."created_at" <> OLD."created_at"
  THEN RAISE EXCEPTION 'database rollback request identity is immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "database_rollback_requests_protect"
  BEFORE INSERT OR UPDATE OR DELETE ON "rollback_requests"
  FOR EACH ROW EXECUTE FUNCTION protect_database_rollback_request();

DO $migration$
DECLARE
  definition text;
  prior_fragment text := $prior$
        AND request."expected_current_publication_id" IS NOT NULL
        AND request."target_content_snapshot_id" IS NOT NULL
$prior$;
  next_fragment text := $next$
        AND request."expected_current_content_snapshot_id" = NEW."previous_official_snapshot_id"
        AND request."expected_current_content_snapshot_hash" = (
          SELECT "manifest_hash" FROM "content_snapshots"
          WHERE "id" = NEW."previous_official_snapshot_id"
        )
        AND request."target_content_snapshot_id" IS NOT NULL
$next$;
BEGIN
  SELECT pg_get_functiondef('protect_database_publication()'::regprocedure)
  INTO definition;
  IF strpos(definition, prior_fragment) = 0 THEN
    RAISE EXCEPTION 'protect_database_publication definition did not match the expected expand migration';
  END IF;
  EXECUTE replace(definition, prior_fragment, next_fragment);
END;
$migration$;
