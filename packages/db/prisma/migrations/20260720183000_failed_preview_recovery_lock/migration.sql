-- Let the least-privilege web role serialize failed-preview review recovery
-- with publication-target mutations without granting table UPDATE authority.

CREATE OR REPLACE FUNCTION lock_publication_target_for_review(p_target_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  locked_target_id uuid;
BEGIN
  SELECT target."id"
    INTO locked_target_id
    FROM public."publication_targets" AS target
    WHERE target."code" = p_target_code
    FOR UPDATE;

  IF locked_target_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'publication target was not found';
  END IF;

  RETURN locked_target_id;
END;
$$;

REVOKE ALL ON FUNCTION lock_publication_target_for_review(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_web') THEN
    GRANT EXECUTE ON FUNCTION lock_publication_target_for_review(text)
      TO situation_studio_web;
  END IF;
END;
$$;
