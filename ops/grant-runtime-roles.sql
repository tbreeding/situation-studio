\set ON_ERROR_STOP on

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_owner') THEN
    CREATE ROLE situation_studio_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_web') THEN
    CREATE ROLE situation_studio_web LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_review_worker') THEN
    CREATE ROLE situation_studio_review_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_publisher') THEN
    CREATE ROLE situation_studio_publisher LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_backup_inspector') THEN
    CREATE ROLE situation_studio_backup_inspector LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_backup_operator') THEN
    CREATE ROLE situation_studio_backup_operator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END;
$$;

ALTER ROLE situation_studio_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE situation_studio_web LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE situation_studio_review_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE situation_studio_publisher LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE situation_studio_backup_inspector LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE situation_studio_backup_operator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

REVOKE ALL ON DATABASE situation_studio FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

GRANT CONNECT ON DATABASE situation_studio
  TO situation_studio_web,
     situation_studio_review_worker,
     situation_studio_publisher,
     situation_studio_backup_inspector,
     situation_studio_backup_operator;
GRANT USAGE ON SCHEMA public
  TO situation_studio_web,
     situation_studio_review_worker,
     situation_studio_publisher,
     situation_studio_backup_inspector,
     situation_studio_backup_operator;

GRANT SELECT, INSERT, UPDATE
  ON users, user_role_assignments, sessions, login_throttles,
     password_reset_tokens, situations, situation_checkouts, drafts,
     draft_revisions, draft_revision_artifacts, content_blobs,
     review_jobs, review_steps, review_proposals, proposal_changes,
     publication_jobs, audit_events
  TO situation_studio_web;
GRANT DELETE ON login_throttles TO situation_studio_web;
GRANT SELECT, INSERT ON scoped_artifact_variants TO situation_studio_web;

GRANT SELECT, INSERT ON leadership_release_observations,
  production_situation_versions, production_version_artifacts
  TO situation_studio_web;
GRANT SELECT, INSERT, UPDATE ON leadership_sync_cursors
  TO situation_studio_web;
GRANT SELECT, INSERT ON publication_events
  TO situation_studio_web;
GRANT SELECT, INSERT, UPDATE ON publication_preflight_receipts
  TO situation_studio_web;
GRANT SELECT, INSERT ON publication_candidate_artifacts
  TO situation_studio_web;
GRANT SELECT ON
  agent_runs, publication_attempts,
  verification_receipts, backup_receipts, publication_candidate_snapshots,
  process_heartbeats, agent_candidate_revisions, review_findings,
  proposal_change_findings
  TO situation_studio_web;

GRANT SELECT, UPDATE ON review_jobs, review_steps
  TO situation_studio_review_worker;
GRANT SELECT, INSERT, UPDATE ON agent_runs
  TO situation_studio_review_worker;
GRANT SELECT, INSERT ON review_proposals, proposal_changes
  TO situation_studio_review_worker;
GRANT SELECT, INSERT ON agent_candidate_revisions, review_findings,
  proposal_change_findings
  TO situation_studio_review_worker;
GRANT INSERT ON audit_events
  TO situation_studio_review_worker;
GRANT SELECT ON draft_revisions, draft_revision_artifacts, content_blobs,
  drafts, production_situation_versions, production_version_artifacts,
  scoped_artifact_variants, situation_checkouts
  TO situation_studio_review_worker;
GRANT SELECT, INSERT, UPDATE ON process_heartbeats
  TO situation_studio_review_worker;

GRANT SELECT, UPDATE ON publication_jobs TO situation_studio_publisher;
GRANT SELECT, INSERT, UPDATE ON publication_attempts
  TO situation_studio_publisher;
GRANT SELECT, INSERT ON publication_events,
  verification_receipts, leadership_release_observations,
  production_situation_versions, production_version_artifacts,
  backup_receipts, audit_events
  TO situation_studio_publisher;
GRANT SELECT, INSERT, UPDATE, DELETE ON publication_candidate_snapshots
  TO situation_studio_publisher;
GRANT SELECT ON publication_preflight_receipts,
  publication_candidate_artifacts
  TO situation_studio_publisher;
GRANT SELECT ON draft_revisions, draft_revision_artifacts, content_blobs,
  scoped_artifact_variants, review_jobs, review_steps, review_proposals,
  proposal_changes, agent_candidate_revisions, review_findings,
  proposal_change_findings, leadership_sync_cursors
  TO situation_studio_publisher;
GRANT SELECT, INSERT, UPDATE ON process_heartbeats
  TO situation_studio_publisher;
GRANT SELECT, UPDATE ON situation_checkouts, drafts, situations
  TO situation_studio_publisher;

GRANT SELECT ON backup_receipts, production_situation_versions,
  production_version_artifacts, content_blobs
  TO situation_studio_backup_inspector;

GRANT SELECT ON ALL TABLES IN SCHEMA public
  TO situation_studio_backup_operator;
GRANT INSERT, UPDATE ON backup_receipts
  TO situation_studio_backup_operator;

ALTER DEFAULT PRIVILEGES FOR ROLE situation_studio_owner IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC;
