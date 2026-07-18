-- CreateIndex
CREATE INDEX "publications_version_idx" ON "publications"("version_id");

-- AddForeignKey
ALTER TABLE "draft_artifacts" ADD CONSTRAINT "draft_artifacts_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "situation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
