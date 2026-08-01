BEGIN TRANSACTION READ ONLY;

SELECT count(*) FILTER (
         WHERE job.state IN ('REQUESTED', 'ASSEMBLING', 'PROMOTING', 'VERIFYING')
       )::text
       || '|'
       || count(*) FILTER (WHERE job.state = 'RECOVERY_REQUIRED')::text
       || '|'
       || (
         SELECT count(*)::text
           FROM publication_attempts attempt
          WHERE attempt.finished_at IS NULL
       )
  FROM publication_jobs job;

COMMIT;
