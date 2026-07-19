-- Keep every nonterminal publication state mutually exclusive per target,
-- including across publication and rollback request tables.

DROP INDEX IF EXISTS "publication_requests_one_active_target_idx";

CREATE UNIQUE INDEX "publication_requests_one_active_target_idx"
  ON "publication_requests" ("target_environment")
  WHERE "state" IN (
    'REQUESTED', 'SNAPSHOT_MATERIALIZED', 'SNAPSHOT_VALIDATED',
    'CANDIDATE_AVAILABLE', 'CANDIDATE_VERIFIED',
    'WORKTREE_READY', 'APPLIED', 'VALIDATED', 'COMMITTED', 'PUSHED',
    'PREVIEW_BUILT', 'PREVIEW_VERIFIED', 'AWAITING_CONFIRMATION',
    'OFFICIAL_POINTER_COMMITTED', 'RESTORING_PREVIOUS', 'CUTOVER',
    'LIVE_VERIFIED', 'RECONCILIATION_REQUIRED'
  );

CREATE UNIQUE INDEX "rollback_requests_one_active_target_idx"
  ON "rollback_requests" ("target_environment")
  WHERE "state" IN (
    'REQUESTED', 'SNAPSHOT_MATERIALIZED', 'SNAPSHOT_VALIDATED',
    'CANDIDATE_AVAILABLE', 'CANDIDATE_VERIFIED',
    'WORKTREE_READY', 'APPLIED', 'VALIDATED', 'COMMITTED', 'PUSHED',
    'PREVIEW_BUILT', 'PREVIEW_VERIFIED', 'AWAITING_CONFIRMATION',
    'OFFICIAL_POINTER_COMMITTED', 'RESTORING_PREVIOUS', 'CUTOVER',
    'LIVE_VERIFIED', 'RECONCILIATION_REQUIRED'
  );

CREATE OR REPLACE FUNCTION database_request_state_is_active(
  request_state "PublicationSagaState"
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT request_state IN (
    'REQUESTED', 'SNAPSHOT_MATERIALIZED', 'SNAPSHOT_VALIDATED',
    'CANDIDATE_AVAILABLE', 'CANDIDATE_VERIFIED',
    'WORKTREE_READY', 'APPLIED', 'VALIDATED', 'COMMITTED', 'PUSHED',
    'PREVIEW_BUILT', 'PREVIEW_VERIFIED', 'AWAITING_CONFIRMATION',
    'OFFICIAL_POINTER_COMMITTED', 'RESTORING_PREVIOUS', 'CUTOVER',
    'LIVE_VERIFIED', 'RECONCILIATION_REQUIRED'
  )
$$;

CREATE OR REPLACE FUNCTION enforce_cross_table_active_target()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."publication_target_id" IS NULL
    OR NOT database_request_state_is_active(NEW."state")
  THEN
    RETURN NEW;
  END IF;

  -- This lock serializes publication-versus-rollback inserts because a unique
  -- index cannot span two tables.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW."publication_target_id"::text, 0)
  );

  IF TG_TABLE_NAME = 'publication_requests' THEN
    IF EXISTS (
      SELECT 1
      FROM "rollback_requests" request
      WHERE request."publication_target_id" = NEW."publication_target_id"
        AND database_request_state_is_active(request."state")
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'DATABASE_UNIQUE_TARGET: an active rollback already owns this publication target';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM "publication_requests" request
      WHERE request."publication_target_id" = NEW."publication_target_id"
        AND database_request_state_is_active(request."state")
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'DATABASE_UNIQUE_TARGET: an active publication already owns this publication target';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "database_publication_active_target_guard"
  BEFORE INSERT OR UPDATE OF "publication_target_id", "state"
  ON "publication_requests"
  FOR EACH ROW EXECUTE FUNCTION enforce_cross_table_active_target();

CREATE TRIGGER "database_rollback_active_target_guard"
  BEFORE INSERT OR UPDATE OF "publication_target_id", "state"
  ON "rollback_requests"
  FOR EACH ROW EXECUTE FUNCTION enforce_cross_table_active_target();

REVOKE ALL ON FUNCTION enforce_cross_table_active_target() FROM PUBLIC;
