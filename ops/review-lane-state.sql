BEGIN TRANSACTION READ ONLY;

WITH active_checkouts AS (
  SELECT checkout.id
    FROM situation_checkouts checkout
   WHERE checkout.released_at IS NULL
),
active_jobs AS (
  SELECT job.id,
         job.queued_at,
         job.lane_owner
    FROM review_jobs job
    JOIN active_checkouts checkout
      ON checkout.id = job.checkout_id
)
SELECT jsonb_build_object(
  'jobs', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      job.id,
      job.queued_at,
      job.lane_owner
    ) ORDER BY job.id)
      FROM active_jobs job
  ), '[]'::jsonb),
  'laneOwnerId', (
    SELECT job.id
      FROM active_jobs job
     WHERE job.lane_owner
  )
)::text;

COMMIT;
