ALTER TABLE "users"
ADD COLUMN "repository_reviewer_id" VARCHAR(100);

CREATE UNIQUE INDEX "users_repository_reviewer_id_key"
ON "users"("repository_reviewer_id");

ALTER TABLE "users"
ADD CONSTRAINT "users_repository_reviewer_id_shape_check"
CHECK (
  "repository_reviewer_id" IS NULL OR
  "repository_reviewer_id" ~ '^[a-z0-9][a-z0-9-]{1,99}$'
);

ALTER TABLE "approvals"
ADD COLUMN "repository_reviewer_id" VARCHAR(100),
ADD COLUMN "content_review_date" CHAR(10);

ALTER TABLE "approvals"
ADD CONSTRAINT "approvals_review_provenance_pair_check"
CHECK (
  ("repository_reviewer_id" IS NULL) = ("content_review_date" IS NULL)
),
ADD CONSTRAINT "approvals_repository_reviewer_id_shape_check"
CHECK (
  "repository_reviewer_id" IS NULL OR
  "repository_reviewer_id" ~ '^[a-z0-9][a-z0-9-]{1,99}$'
),
ADD CONSTRAINT "approvals_content_review_date_shape_check"
CHECK (
  "content_review_date" IS NULL OR
  "content_review_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
);
