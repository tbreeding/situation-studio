\set ON_ERROR_STOP on

-- Run while connected to the PostgreSQL maintenance database as its
-- administrator. The schema owner is deliberately unable to log in.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_owner'
  ) THEN
    CREATE ROLE situation_studio_owner
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;
  END IF;
END;
$$;

ALTER ROLE situation_studio_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;

SELECT 'CREATE DATABASE situation_studio OWNER situation_studio_owner'
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = 'situation_studio'
)\gexec
