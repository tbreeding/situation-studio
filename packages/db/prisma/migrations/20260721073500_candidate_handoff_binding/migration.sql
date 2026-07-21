ALTER TABLE "candidate_authorizations"
  ADD COLUMN "handoff_id" uuid,
  ADD COLUMN "handoff_verifier_hash" char(64),
  ADD CONSTRAINT "candidate_authorizations_handoff_pair_check"
    CHECK (
      ("handoff_id" IS NULL AND "handoff_verifier_hash" IS NULL)
      OR
      ("handoff_id" IS NOT NULL AND "handoff_verifier_hash" IS NOT NULL)
    ),
  ADD CONSTRAINT "candidate_authorizations_handoff_verifier_hash_check"
    CHECK (
      "handoff_verifier_hash" IS NULL
      OR "handoff_verifier_hash" ~ '^[0-9a-f]{64}$'
    );

CREATE UNIQUE INDEX "candidate_authorizations_handoff_id_key"
  ON "candidate_authorizations"("handoff_id")
  WHERE "handoff_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_candidate_authorization()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  actor_type "IdentityType";
  actual_hash char(64);
  target_row record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'candidate authorizations cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "identity_type" INTO actor_type
      FROM "users" WHERE "id" = NEW."reviewer_id" FOR KEY SHARE;
    IF actor_type IS DISTINCT FROM 'HUMAN' THEN
      RAISE EXCEPTION 'candidate authorization requires a human reviewer';
    END IF;
    SELECT "manifest_hash" INTO actual_hash
      FROM "content_snapshots"
      WHERE "id" = NEW."snapshot_id" AND "validation_state" = 'VALIDATED'
      FOR KEY SHARE;
    SELECT * INTO target_row
      FROM "publication_targets" WHERE "id" = NEW."target_id" FOR KEY SHARE;
    IF actual_hash IS DISTINCT FROM NEW."snapshot_hash"
      OR target_row."candidate_snapshot_id" IS DISTINCT FROM NEW."snapshot_id"
      OR target_row."candidate_publication_request_id" IS DISTINCT FROM NEW."publication_request_id"
      OR target_row."candidate_rollback_request_id" IS DISTINCT FROM NEW."rollback_request_id"
    THEN RAISE EXCEPTION 'authorization does not match the active candidate'; END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
    OR NEW."publication_request_id" IS DISTINCT FROM OLD."publication_request_id"
    OR NEW."rollback_request_id" IS DISTINCT FROM OLD."rollback_request_id"
    OR NEW."target_id" <> OLD."target_id"
    OR NEW."snapshot_id" <> OLD."snapshot_id"
    OR NEW."snapshot_hash" <> OLD."snapshot_hash"
    OR NEW."reviewer_id" <> OLD."reviewer_id"
    OR NEW."exchange_token_hash" <> OLD."exchange_token_hash"
    OR NEW."handoff_id" IS DISTINCT FROM OLD."handoff_id"
    OR NEW."handoff_verifier_hash" IS DISTINCT FROM OLD."handoff_verifier_hash"
    OR NEW."audience" <> OLD."audience"
    OR NEW."expires_at" <> OLD."expires_at"
    OR NEW."created_at" <> OLD."created_at"
  THEN RAISE EXCEPTION 'candidate authorization identity is immutable'; END IF;
  IF OLD."cookie_token_hash" IS NOT NULL
    AND NEW."cookie_token_hash" IS DISTINCT FROM OLD."cookie_token_hash"
  THEN RAISE EXCEPTION 'candidate cookie binding is immutable once exchanged'; END IF;
  IF OLD."exchanged_at" IS NOT NULL
    AND NEW."exchanged_at" IS DISTINCT FROM OLD."exchanged_at"
  THEN RAISE EXCEPTION 'candidate exchange time is immutable once recorded'; END IF;
  IF OLD."revoked_at" IS NOT NULL
    AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
  THEN RAISE EXCEPTION 'candidate revocation is immutable once recorded'; END IF;
  IF OLD."exchanged_at" IS NULL AND NEW."exchanged_at" IS NOT NULL
    AND (clock_timestamp() >= OLD."expires_at" OR OLD."revoked_at" IS NOT NULL)
  THEN RAISE EXCEPTION 'expired or revoked authorization cannot be exchanged'; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_candidate_authorization() FROM PUBLIC;
