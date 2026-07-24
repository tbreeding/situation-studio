-- A content-identical restoration is a new production occurrence with its own
-- release observation and provenance. Content blobs remain deduplicated.
DROP INDEX "production_versions_bundle_key";

CREATE INDEX "production_versions_bundle_idx"
ON "production_situation_versions"("situation_id", "bundle_hash");

CREATE UNIQUE INDEX "production_versions_observation_key"
ON "production_situation_versions"("situation_id", "observation_id");
