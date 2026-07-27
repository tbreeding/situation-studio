-- AddEnumValue
ALTER TYPE "ProposalTargetKind" ADD VALUE IF NOT EXISTS 'EMBED';
ALTER TYPE "ProposalTargetKind" ADD VALUE IF NOT EXISTS 'BUNDLE';

-- CreateEnum
CREATE TYPE "ProposalApplicationMode" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReviewFindingSeverity" AS ENUM ('NOTE', 'CONSIDER', 'IMPORTANT', 'BLOCKING');

-- AlterTable
ALTER TABLE "proposal_changes"
  ADD COLUMN "application_mode" "ProposalApplicationMode" NOT NULL DEFAULT 'AUTOMATIC',
  ADD COLUMN "before_body" TEXT,
  ADD COLUMN "problem" TEXT NOT NULL DEFAULT 'Editorial review finding',
  ADD COLUMN "explanation" TEXT NOT NULL DEFAULT 'See the retained review rationale.',
  ADD COLUMN "written_by_role_code" VARCHAR(100) NOT NULL DEFAULT 'bundle-writer',
  ADD COLUMN "identified_by_role_codes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "evidence_role_codes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "editor_body" TEXT,
  ADD COLUMN "editor_hash" CHAR(64),
  ADD COLUMN "edited_at" TIMESTAMPTZ(3),
  ADD COLUMN "edited_by_id" UUID;

-- CreateTable
CREATE TABLE "agent_candidate_revisions" (
  "id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "input_revision_id" UUID NOT NULL,
  "input_bundle_hash" CHAR(64) NOT NULL,
  "body" TEXT NOT NULL,
  "body_hash" CHAR(64) NOT NULL,
  "bundle_manifest" JSONB NOT NULL,
  "bundle_hash" CHAR(64) NOT NULL,
  "candidate_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_candidate_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_findings" (
  "id" UUID NOT NULL,
  "proposal_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "finding_key" VARCHAR(240) NOT NULL,
  "severity" "ReviewFindingSeverity" NOT NULL,
  "target_kind" "ProposalTargetKind" NOT NULL,
  "target_key" VARCHAR(240) NOT NULL,
  "summary" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "source_role_code" VARCHAR(100) NOT NULL,
  "evidence_role_codes" JSONB NOT NULL,
  CONSTRAINT "review_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_change_findings" (
  "change_id" UUID NOT NULL,
  "finding_id" UUID NOT NULL,
  CONSTRAINT "proposal_change_findings_pkey" PRIMARY KEY ("change_id", "finding_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_candidate_revisions_proposal_id_key"
  ON "agent_candidate_revisions"("proposal_id");
CREATE INDEX "agent_candidate_revisions_candidate_hash_idx"
  ON "agent_candidate_revisions"("candidate_hash");
CREATE UNIQUE INDEX "review_findings_position_key"
  ON "review_findings"("proposal_id", "position");
CREATE UNIQUE INDEX "review_findings_key_key"
  ON "review_findings"("proposal_id", "finding_key");
CREATE INDEX "review_findings_target_idx"
  ON "review_findings"("proposal_id", "target_kind", "target_key");
CREATE INDEX "proposal_changes_actionable_idx"
  ON "proposal_changes"("proposal_id", "state", "application_mode");

-- AddForeignKey
ALTER TABLE "agent_candidate_revisions"
  ADD CONSTRAINT "agent_candidate_revisions_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "review_proposals"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_candidate_revisions"
  ADD CONSTRAINT "agent_candidate_revisions_input_revision_id_fkey"
  FOREIGN KEY ("input_revision_id") REFERENCES "draft_revisions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_findings"
  ADD CONSTRAINT "review_findings_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "review_proposals"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proposal_change_findings"
  ADD CONSTRAINT "proposal_change_findings_change_id_fkey"
  FOREIGN KEY ("change_id") REFERENCES "proposal_changes"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "proposal_change_findings"
  ADD CONSTRAINT "proposal_change_findings_finding_id_fkey"
  FOREIGN KEY ("finding_id") REFERENCES "review_findings"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Normalize retained findings from prior immutable proposals. Their only
-- durable authoring evidence is the bundle-writer output that stored them.
INSERT INTO "review_findings" (
  "id", "proposal_id", "position", "finding_key", "severity",
  "target_kind", "target_key", "summary", "rationale",
  "source_role_code", "evidence_role_codes"
)
SELECT
  gen_random_uuid(),
  proposal.id,
  finding.ordinality - 1,
  'bundle-writer:' || (finding.value->>'id'),
  upper(finding.value->>'severity')::"ReviewFindingSeverity",
  (finding.value->>'targetKind')::"ProposalTargetKind",
  finding.value->>'targetKey',
  finding.value->>'summary',
  finding.value->>'rationale',
  'bundle-writer',
  '[]'::jsonb
FROM "review_proposals" proposal
CROSS JOIN LATERAL jsonb_array_elements(proposal.findings)
  WITH ORDINALITY AS finding(value, ordinality)
WHERE jsonb_typeof(proposal.findings) = 'array'
  AND finding.value ? 'id'
  AND finding.value ? 'severity'
  AND finding.value ? 'targetKind'
  AND finding.value ? 'targetKey'
  AND finding.value ? 'summary'
  AND finding.value ? 'rationale';

CREATE TRIGGER "agent_candidate_revisions_immutable_update"
BEFORE UPDATE OR DELETE ON "agent_candidate_revisions"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE TRIGGER "review_findings_immutable_update"
BEFORE UPDATE OR DELETE ON "review_findings"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE TRIGGER "proposal_change_findings_immutable_update"
BEFORE UPDATE OR DELETE ON "proposal_change_findings"
FOR EACH ROW EXECUTE FUNCTION studio_reject_immutable_mutation();

CREATE OR REPLACE FUNCTION studio_protect_proposal_change_source()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
    OR NEW.position IS DISTINCT FROM OLD.position
    OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
    OR NEW.target_key IS DISTINCT FROM OLD.target_key
    OR NEW.application_mode IS DISTINCT FROM OLD.application_mode
    OR NEW.before_hash IS DISTINCT FROM OLD.before_hash
    OR NEW.before_body IS DISTINCT FROM OLD.before_body
    OR NEW.after_body IS DISTINCT FROM OLD.after_body
    OR NEW.after_hash IS DISTINCT FROM OLD.after_hash
    OR NEW.problem IS DISTINCT FROM OLD.problem
    OR NEW.explanation IS DISTINCT FROM OLD.explanation
    OR NEW.rationale IS DISTINCT FROM OLD.rationale
    OR NEW.written_by_role_code IS DISTINCT FROM OLD.written_by_role_code
    OR NEW.identified_by_role_codes IS DISTINCT FROM OLD.identified_by_role_codes
    OR NEW.evidence_role_codes IS DISTINCT FROM OLD.evidence_role_codes
  THEN
    RAISE EXCEPTION 'proposal change source is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "proposal_changes_source_immutable_update"
BEFORE UPDATE ON "proposal_changes"
FOR EACH ROW EXECUTE FUNCTION studio_protect_proposal_change_source();
