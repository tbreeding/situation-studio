ALTER TABLE "publications"
  ADD COLUMN "rollback_request_id" UUID;

CREATE TABLE "rollback_requests" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "rollback_uuid" UUID NOT NULL,
  "idempotency_key" VARCHAR(120) NOT NULL,
  "target_environment" VARCHAR(50) NOT NULL,
  "situation_id" UUID NOT NULL,
  "target_publication_id" UUID NOT NULL,
  "expected_current_publication_id" UUID NOT NULL,
  "requested_by_id" UUID NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "state" "PublicationSagaState" NOT NULL DEFAULT 'REQUESTED',
  "current_step" VARCHAR(80) NOT NULL DEFAULT 'REQUESTED',
  "error_class" VARCHAR(100),
  "reconciliation_reason" VARCHAR(500),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "rollback_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rollback_steps" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "request_id" UUID NOT NULL,
  "step" VARCHAR(80) NOT NULL,
  "attempt" INTEGER NOT NULL,
  "fence" BIGINT NOT NULL,
  "external_id" VARCHAR(300),
  "state" VARCHAR(30) NOT NULL,
  "input_hash" CHAR(64) NOT NULL,
  "output_hash" CHAR(64),
  "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "rollback_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "publications_rollback_request_id_key"
  ON "publications"("rollback_request_id");
CREATE UNIQUE INDEX "rollback_requests_rollback_uuid_key"
  ON "rollback_requests"("rollback_uuid");
CREATE UNIQUE INDEX "rollback_requests_requested_by_id_idempotency_key_key"
  ON "rollback_requests"("requested_by_id", "idempotency_key");
CREATE INDEX "rollback_requests_active_idx"
  ON "rollback_requests"("target_environment", "state");
CREATE UNIQUE INDEX "rollback_steps_request_id_step_attempt_key"
  ON "rollback_steps"("request_id", "step", "attempt");

ALTER TABLE "rollback_requests"
  ADD CONSTRAINT "rollback_requests_situation_id_fkey"
    FOREIGN KEY ("situation_id") REFERENCES "situations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "rollback_requests_target_publication_id_fkey"
    FOREIGN KEY ("target_publication_id") REFERENCES "publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "rollback_requests_expected_current_publication_id_fkey"
    FOREIGN KEY ("expected_current_publication_id") REFERENCES "publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "rollback_requests_requested_by_id_fkey"
    FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rollback_steps"
  ADD CONSTRAINT "rollback_steps_request_id_fkey"
    FOREIGN KEY ("request_id") REFERENCES "rollback_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publications"
  ADD CONSTRAINT "publications_rollback_request_id_fkey"
    FOREIGN KEY ("rollback_request_id") REFERENCES "rollback_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
