ALTER TABLE "drafts"
  ADD COLUMN "restoration_parent_id" UUID;

ALTER TABLE "publication_jobs"
  ADD COLUMN "restoration_parent_id" UUID,
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ(3);

ALTER TABLE "review_jobs"
  ADD COLUMN "claim_token" UUID,
  ADD COLUMN "lease_expires_at" TIMESTAMPTZ(3);

ALTER TABLE "drafts"
  ADD CONSTRAINT "drafts_restoration_parent_id_fkey"
  FOREIGN KEY ("restoration_parent_id")
  REFERENCES "production_situation_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "publication_jobs"
  ADD CONSTRAINT "publication_jobs_restoration_parent_id_fkey"
  FOREIGN KEY ("restoration_parent_id")
  REFERENCES "production_situation_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "review_jobs_lease_idx"
ON "review_jobs"("state", "lease_expires_at");

CREATE INDEX "publication_jobs_lease_idx"
ON "publication_jobs"("state", "lease_expires_at");
