CREATE TABLE "publication_candidate_snapshots" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "release_id" UUID NOT NULL,
  "parent_release_id" UUID NOT NULL,
  "expected_pointer_generation" BIGINT NOT NULL,
  "manifest_hash" CHAR(64) NOT NULL,
  "manifest_body" TEXT NOT NULL,
  "artifact_count" INTEGER NOT NULL,
  "edge_count" INTEGER NOT NULL,
  "total_byte_length" BIGINT NOT NULL,
  "assembly" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "publication_candidate_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "publication_candidate_snapshots_job_id_key"
  ON "publication_candidate_snapshots"("job_id");
CREATE UNIQUE INDEX "publication_candidate_snapshots_release_id_key"
  ON "publication_candidate_snapshots"("release_id");

ALTER TABLE "publication_candidate_snapshots"
  ADD CONSTRAINT "publication_candidate_snapshots_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "publication_jobs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
