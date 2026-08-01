ALTER TABLE "review_jobs"
  ADD COLUMN "lane_owner" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "failure_reason_code" VARCHAR(100),
  ADD COLUMN "failure_phase" VARCHAR(40),
  ADD COLUMN "failure_stage_ordinal" INTEGER,
  ADD COLUMN "failure_stage_role" VARCHAR(100);

ALTER TABLE "review_jobs"
  ADD CONSTRAINT "review_jobs_failure_stage_ordinal_bounded"
  CHECK (
    "failure_stage_ordinal" IS NULL
    OR "failure_stage_ordinal" BETWEEN 1 AND 24
  );

-- Retry scheduling previously rewrote queued_at. Restore its original meaning
-- from the immutable enqueue audit so focused work keeps its original order.
UPDATE "review_jobs" AS job
SET "queued_at" = original."occurred_at"
FROM (
  SELECT "subject_id", min("occurred_at") AS "occurred_at"
  FROM "audit_events"
  WHERE "subject_type" = 'REVIEW_JOB'
    AND "action" = 'REVIEW_QUEUED'
  GROUP BY "subject_id"
) AS original
WHERE original."subject_id" = job."id"::text;

-- Preserve an already-running review as the focused lane owner during deploy.
WITH focused AS (
  SELECT job."id"
  FROM "review_jobs" AS job
  JOIN "situation_checkouts" AS checkout
    ON checkout."id" = job."checkout_id"
   AND checkout."fence" = job."checkout_fence"
   AND checkout."released_at" IS NULL
  WHERE job."state" = 'RUNNING'
  ORDER BY job."started_at" NULLS LAST, job."queued_at", job."id"
  LIMIT 1
)
UPDATE "review_jobs" AS job
SET "lane_owner" = true
FROM focused
WHERE job."id" = focused."id";

CREATE UNIQUE INDEX "review_jobs_one_lane_owner"
  ON "review_jobs" ((true))
  WHERE "lane_owner" = true;

CREATE INDEX "review_jobs_lane_queue_idx"
  ON "review_jobs" ("lane_owner", "state", "queued_at");
