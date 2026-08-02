BEGIN TRANSACTION READ ONLY;

WITH active_checkouts AS (
  SELECT checkout.id
    FROM situation_checkouts checkout
   WHERE checkout.released_at IS NULL
),
original_queue AS (
  SELECT event.subject_id,
         min(event.occurred_at) AS occurred_at
    FROM audit_events event
   WHERE event.subject_type = 'REVIEW_JOB'
     AND event.action = 'REVIEW_QUEUED'
   GROUP BY event.subject_id
),
normalized_jobs AS (
  SELECT job.id,
         job.state,
         job.started_at,
         COALESCE(original.occurred_at, job.queued_at) AS queued_at
    FROM review_jobs job
    JOIN active_checkouts checkout
      ON checkout.id = job.checkout_id
    LEFT JOIN original_queue original
      ON original.subject_id = job.id::text
),
focused AS (
  SELECT job.id
    FROM normalized_jobs job
   WHERE job.state = 'RUNNING'
   ORDER BY job.started_at NULLS LAST, job.queued_at, job.id
   LIMIT 1
)
SELECT jsonb_build_object(
  'jobs', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      job.id,
      job.queued_at,
      COALESCE(job.id = (SELECT focused.id FROM focused), false)
    ) ORDER BY job.id)
      FROM normalized_jobs job
  ), '[]'::jsonb),
  'laneOwnerId', (SELECT focused.id FROM focused)
)::text;

COMMIT;
