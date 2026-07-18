\set ON_ERROR_STOP on

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM situation_studio_ai;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM situation_studio_validator;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM situation_studio_publisher;

GRANT USAGE ON SCHEMA public TO
  situation_studio_ai,
  situation_studio_validator,
  situation_studio_publisher;

GRANT SELECT ON
  repository_snapshots,
  situations,
  content_blobs,
  artifacts,
  artifact_edges,
  situation_versions,
  version_artifacts,
  drafts,
  draft_revisions,
  draft_artifacts,
  situation_checkouts,
  ai_jobs,
  workflow_steps,
  agent_runs,
  provider_accounts,
  proposed_bundles,
  bundle_artifacts,
  validation_runs
TO situation_studio_ai;

GRANT INSERT, UPDATE ON
  situations,
  content_blobs,
  drafts,
  situation_checkouts,
  ai_jobs,
  workflow_steps,
  agent_runs,
  provider_accounts,
  proposed_bundles,
  bundle_artifacts,
  validation_runs
TO situation_studio_ai;

GRANT INSERT ON audit_events TO situation_studio_ai;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO situation_studio_ai;

GRANT SELECT ON
  repository_snapshots,
  content_blobs,
  artifacts,
  proposed_bundles,
  bundle_artifacts,
  validation_runs
TO situation_studio_validator;

GRANT INSERT, UPDATE ON validation_runs TO situation_studio_validator;
GRANT INSERT ON audit_events TO situation_studio_validator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO situation_studio_validator;

GRANT SELECT ON
  repository_snapshots,
  situations,
  content_blobs,
  artifacts,
  situation_versions,
  version_artifacts,
  drafts,
  situation_checkouts,
  checkout_resources,
  proposed_bundles,
  bundle_artifacts,
  comments,
  validation_runs,
  approvals,
  publication_requests,
  publication_steps,
  rollback_requests,
  rollback_steps,
  publications
TO situation_studio_publisher;

GRANT INSERT, UPDATE ON
  situations,
  drafts,
  situation_checkouts,
  checkout_resources,
  proposed_bundles,
  publication_requests,
  publication_steps,
  rollback_requests,
  rollback_steps
TO situation_studio_publisher;

GRANT INSERT ON
  situation_versions,
  version_artifacts,
  publications,
  audit_events
TO situation_studio_publisher;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO situation_studio_publisher;
