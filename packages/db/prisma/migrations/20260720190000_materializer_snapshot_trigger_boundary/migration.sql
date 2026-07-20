-- Snapshot membership must take row locks on immutable source identities without
-- granting the materializer permission to rewrite the artifact registry or
-- content-addressed blobs. Trigger functions cannot be invoked as ordinary
-- functions, and their fixed search path prevents object-shadowing attacks.
ALTER FUNCTION public.protect_content_snapshot_artifact() SECURITY DEFINER;
ALTER FUNCTION public.protect_content_snapshot_artifact()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.protect_content_snapshot_edge() SECURITY DEFINER;
ALTER FUNCTION public.protect_content_snapshot_edge()
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.protect_content_snapshot_artifact() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_content_snapshot_edge() FROM PUBLIC;
