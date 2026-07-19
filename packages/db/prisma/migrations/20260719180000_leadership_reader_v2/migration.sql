-- Binary-safe, batched Leadership reader functions. These are new versioned
-- functions so the Checkpoint 1 function signatures remain compatible.
CREATE OR REPLACE FUNCTION leadership_read_official_snapshot_v2(p_target_code text)
RETURNS TABLE(
  snapshot_id uuid,
  snapshot_hash char(64),
  canonical_manifest text,
  validation_policy_hash char(64),
  artifact_count integer,
  total_byte_length bigint,
  logical_id varchar(200),
  canonical_path varchar(500),
  artifact_type text,
  content_hash char(64),
  byte_length integer,
  encoding text,
  body text,
  binary_body bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT snapshot."id", snapshot."manifest_hash", snapshot."manifest",
    snapshot."validation_policy_hash", snapshot."artifact_count",
    snapshot."total_byte_length", member."logical_id", member."canonical_path",
    member."artifact_type"::text, member."content_hash", member."byte_length",
    blob."encoding"::text, blob."body", blob."binary_body"
  FROM public."publication_targets" target
  JOIN public."content_snapshots" snapshot
    ON snapshot."id" = target."official_snapshot_id"
   AND snapshot."validation_state" = 'VALIDATED'
  JOIN public."content_snapshot_artifacts" member
    ON member."snapshot_id" = snapshot."id"
  JOIN public."content_blobs" blob ON blob."hash" = member."content_hash"
  WHERE target."code" = p_target_code AND target."bootstrapped_at" IS NOT NULL
  ORDER BY member."canonical_path", member."logical_id";
$$;

CREATE OR REPLACE FUNCTION leadership_read_candidate_snapshot_v2(
  p_target_code text, p_cookie_token_hash text, p_reviewer_id uuid, p_audience text
)
RETURNS TABLE(
  snapshot_id uuid,
  snapshot_hash char(64),
  canonical_manifest text,
  validation_policy_hash char(64),
  artifact_count integer,
  total_byte_length bigint,
  logical_id varchar(200),
  canonical_path varchar(500),
  artifact_type text,
  content_hash char(64),
  byte_length integer,
  encoding text,
  body text,
  binary_body bytea
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT snapshot."id", snapshot."manifest_hash", snapshot."manifest",
    snapshot."validation_policy_hash", snapshot."artifact_count",
    snapshot."total_byte_length", member."logical_id", member."canonical_path",
    member."artifact_type"::text, member."content_hash", member."byte_length",
    blob."encoding"::text, blob."body", blob."binary_body"
  FROM public."publication_targets" target
  JOIN public."candidate_authorizations" authz
    ON authz."target_id" = target."id"
   AND authz."snapshot_id" = target."candidate_snapshot_id"
   AND authz."publication_request_id" IS NOT DISTINCT FROM target."candidate_publication_request_id"
   AND authz."rollback_request_id" IS NOT DISTINCT FROM target."candidate_rollback_request_id"
   AND authz."cookie_token_hash" = p_cookie_token_hash
   AND authz."reviewer_id" = p_reviewer_id
   AND authz."audience" = p_audience
   AND authz."exchanged_at" IS NOT NULL
   AND authz."revoked_at" IS NULL
   AND authz."expires_at" > statement_timestamp()
  JOIN public."content_snapshots" snapshot
    ON snapshot."id" = target."candidate_snapshot_id"
   AND snapshot."manifest_hash" = authz."snapshot_hash"
   AND snapshot."validation_state" = 'VALIDATED'
  JOIN public."content_snapshot_artifacts" member
    ON member."snapshot_id" = snapshot."id"
  JOIN public."content_blobs" blob ON blob."hash" = member."content_hash"
  WHERE target."code" = p_target_code
    AND p_cookie_token_hash ~ '^[a-f0-9]{64}$'
  ORDER BY member."canonical_path", member."logical_id";
$$;

REVOKE ALL ON FUNCTION leadership_read_official_snapshot_v2(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION leadership_read_candidate_snapshot_v2(text, text, uuid, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadership_content_reader') THEN
    GRANT EXECUTE ON FUNCTION leadership_read_official_snapshot_v2(text)
      TO leadership_content_reader;
    GRANT EXECUTE ON FUNCTION leadership_read_candidate_snapshot_v2(text, text, uuid, text)
      TO leadership_content_reader;
  END IF;
END;
$$;
