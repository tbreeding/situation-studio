-- Safe, allowlisted proof fields for cross-repository publication receipts.
-- Existing receipts remain valid historical identity-only records.
ALTER TABLE "verification_receipts"
  ADD COLUMN "producer_commit" CHAR(40),
  ADD COLUMN "producer_contract_digest" CHAR(64),
  ADD COLUMN "consumer_commit" CHAR(40),
  ADD COLUMN "capability_digest" CHAR(64),
  ADD COLUMN "affected_situation_slug" VARCHAR(160),
  ADD COLUMN "typed_parity_code" VARCHAR(100),
  ADD COLUMN "route_probe_code" VARCHAR(100),
  ADD COLUMN "route_http_status" INTEGER,
  ADD COLUMN "observed_route_release_id" UUID,
  ADD COLUMN "observed_route_manifest_hash" CHAR(64),
  ADD COLUMN "observed_situation_body_hash" CHAR(64),
  ADD COLUMN "observed_practice_logical_id" VARCHAR(240),
  ADD COLUMN "observed_practice_content_hash" CHAR(64);

ALTER TABLE "verification_receipts"
  ADD CONSTRAINT "verification_receipts_route_status_valid"
  CHECK (
    "route_http_status" IS NULL
    OR "route_http_status" BETWEEN 100 AND 599
  );
