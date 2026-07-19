-- A rollback selects an already validated immutable snapshot. Publication
-- candidates still have to be newly materialized and validated. Keep the
-- shared state machine while making that intentional distinction explicit.
DO $migration$
DECLARE
  definition text;
  prior_fragment text := $prior$
  IF NEW."state" = 'SNAPSHOT_MATERIALIZED' THEN
    IF OLD."candidate_snapshot_id" IS NOT NULL
      OR NEW."candidate_snapshot_id" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "content_snapshots"
        WHERE "id" = NEW."candidate_snapshot_id"
          AND "validation_state" = 'MATERIALIZING'
      )
    THEN RAISE EXCEPTION 'materialized publication requires a new materializing snapshot'; END IF;
$prior$;
  next_fragment text := $next$
  IF NEW."state" = 'SNAPSHOT_MATERIALIZED' THEN
    IF OLD."candidate_snapshot_id" IS NOT NULL
      OR NEW."candidate_snapshot_id" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "content_snapshots"
        WHERE "id" = NEW."candidate_snapshot_id"
          AND "validation_state" = CASE
            WHEN NEW."rollback_request_id" IS NULL
              THEN 'MATERIALIZING'::"ContentSnapshotValidationState"
            ELSE 'VALIDATED'::"ContentSnapshotValidationState"
          END
      )
    THEN RAISE EXCEPTION 'publication candidate snapshot has the wrong materialization state'; END IF;
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
