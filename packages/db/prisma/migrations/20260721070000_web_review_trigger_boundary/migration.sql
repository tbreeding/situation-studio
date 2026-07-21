-- Candidate authorization, Leadership observation, and final confirmation
-- take row locks on identities the web role must never be allowed to rewrite.
-- Trigger functions cannot be called as ordinary functions; a fixed search
-- path prevents object-shadowing while the table owner performs those locks.
ALTER FUNCTION public.protect_candidate_authorization() SECURITY DEFINER;
ALTER FUNCTION public.protect_candidate_authorization()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.protect_leadership_observation() SECURITY DEFINER;
ALTER FUNCTION public.protect_leadership_observation()
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.protect_publication_confirmation() SECURITY DEFINER;
ALTER FUNCTION public.protect_publication_confirmation()
  SET search_path = pg_catalog, public;

REVOKE ALL ON FUNCTION public.protect_candidate_authorization() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_leadership_observation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.protect_publication_confirmation() FROM PUBLIC;
