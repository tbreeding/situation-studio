ALTER TABLE "review_jobs"
  ADD COLUMN "retry_not_before" TIMESTAMPTZ(3);

ALTER TABLE "agent_runs"
  ADD COLUMN "provider_attempts" JSONB;

ALTER TABLE "agent_runs"
  ADD CONSTRAINT "agent_runs_provider_attempts_bounded"
  CHECK (
    "provider_attempts" IS NULL
    OR (
      jsonb_typeof("provider_attempts") = 'array'
      AND jsonb_array_length("provider_attempts") <= 2
      AND octet_length("provider_attempts"::text) <= 4096
    )
  );

CREATE INDEX "review_jobs_retry_schedule_idx"
ON "review_jobs"("state", "retry_not_before", "queued_at");
