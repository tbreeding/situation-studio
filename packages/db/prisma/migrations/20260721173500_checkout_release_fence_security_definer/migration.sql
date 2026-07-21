-- Releasing a checkout is part of the materializer's reconciliation boundary.
-- Keep direct situation mutation denied while allowing the release trigger to
-- advance the situation fence under the migration owner's authority.

CREATE OR REPLACE FUNCTION public.fence_checkout_release()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."released_at" IS NULL AND NEW."released_at" IS NOT NULL THEN
    UPDATE public."situations"
      SET "fence" = "fence" + 1,
          "updated_at" = clock_timestamp()
      WHERE "id" = OLD."situation_id";
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fence_checkout_release() FROM PUBLIC;
