\set ON_ERROR_STOP on

-- Roles are provisioned separately so migrations never create credentials.
-- Each block is conditional during the expand phase; the Checkpoint 1 verifier
-- creates all roles and proves the effective grants.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_web') THEN
    REVOKE ALL ON
      content_snapshots,
      content_snapshot_artifacts,
      content_snapshot_edges,
      publication_targets,
      database_publications,
      publication_events,
      publication_confirmations,
      candidate_authorizations,
      leadership_observation_receipts
    FROM situation_studio_web;
    GRANT SELECT ON
      content_snapshots,
      content_snapshot_artifacts,
      content_snapshot_edges,
      publication_targets,
      database_publications,
      publication_events,
      publication_confirmations,
      candidate_authorizations,
      leadership_observation_receipts
    TO situation_studio_web;
    GRANT INSERT ON
      publication_confirmations,
      candidate_authorizations,
      leadership_observation_receipts
    TO situation_studio_web;
    GRANT UPDATE ON candidate_authorizations TO situation_studio_web;
    GRANT EXECUTE ON FUNCTION
      append_publication_event(uuid, uuid, uuid, text, text, jsonb)
    TO situation_studio_web;
    GRANT EXECUTE ON FUNCTION
      lock_publication_target_for_review(text)
    TO situation_studio_web;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_materializer') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM situation_studio_materializer;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM situation_studio_materializer;
    GRANT USAGE ON SCHEMA public TO situation_studio_materializer;
    GRANT SELECT ON
      situations,
      drafts,
      content_blobs,
      artifacts,
      artifact_edges,
      proposed_bundles,
      bundle_artifacts,
      validation_runs,
      approvals,
      publication_requests,
      publication_steps,
      rollback_requests,
      rollback_steps,
      publications,
      content_snapshots,
      content_snapshot_artifacts,
      content_snapshot_edges,
      publication_targets,
      database_publications,
      publication_events,
      publication_confirmations,
      candidate_authorizations,
      leadership_observation_receipts,
      situation_checkouts,
      checkout_resources
    TO situation_studio_materializer;
    GRANT INSERT ON
      content_snapshots,
      content_snapshot_artifacts,
      content_snapshot_edges,
      database_publications,
      publication_steps,
      rollback_steps,
      audit_events
    TO situation_studio_materializer;
    GRANT UPDATE ON
      content_snapshots,
      publication_targets,
      database_publications,
      publication_requests,
      publication_steps,
      rollback_requests,
      rollback_steps,
      candidate_authorizations,
      proposed_bundles,
      drafts,
      situation_checkouts,
      checkout_resources
    TO situation_studio_materializer;
    GRANT EXECUTE ON FUNCTION
      append_publication_event(uuid, uuid, uuid, text, text, jsonb)
    TO situation_studio_materializer;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadership_content_reader') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM leadership_content_reader;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM leadership_content_reader;
    GRANT USAGE ON SCHEMA public TO leadership_content_reader;
    GRANT EXECUTE ON FUNCTION
      leadership_read_official_snapshot(text)
    TO leadership_content_reader;
    GRANT EXECUTE ON FUNCTION
      leadership_read_candidate_snapshot(text, text, uuid, text)
    TO leadership_content_reader;
    GRANT EXECUTE ON FUNCTION
      leadership_read_official_snapshot_v2(text)
    TO leadership_content_reader;
    GRANT EXECUTE ON FUNCTION
      leadership_read_candidate_snapshot_v2(text, text, uuid, text)
    TO leadership_content_reader;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_operations') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM situation_studio_operations;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM situation_studio_operations;
    GRANT USAGE ON SCHEMA public TO situation_studio_operations;
    GRANT SELECT ON
      content_blobs,
      artifacts,
      artifact_edges,
      proposed_bundles,
      bundle_artifacts,
      approvals,
      publication_requests,
      publication_steps,
      rollback_requests,
      rollback_steps,
      publications,
      audit_events,
      content_snapshots,
      content_snapshot_artifacts,
      content_snapshot_edges,
      publication_targets,
      database_publications,
      publication_events,
      publication_confirmations,
      candidate_authorizations,
      leadership_observation_receipts
    TO situation_studio_operations;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_ai') THEN
    REVOKE ALL ON
      publication_targets,
      database_publications,
      publication_events,
      publication_confirmations,
      candidate_authorizations,
      leadership_observation_receipts
    FROM situation_studio_ai;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_validator') THEN
    REVOKE ALL ON
      publication_targets,
      database_publications,
      publication_events,
      publication_confirmations,
      candidate_authorizations,
      leadership_observation_receipts
    FROM situation_studio_validator;
    GRANT SELECT ON
      content_blobs,
      artifacts,
      content_snapshots,
      content_snapshot_artifacts,
      content_snapshot_edges
    TO situation_studio_validator;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'situation_studio_publisher') THEN
    REVOKE ALL ON
      content_snapshots,
      content_snapshot_artifacts,
      content_snapshot_edges,
      publication_targets,
      database_publications,
      publication_events,
      publication_confirmations,
      candidate_authorizations,
      leadership_observation_receipts
    FROM situation_studio_publisher;
  END IF;
END;
$$;
