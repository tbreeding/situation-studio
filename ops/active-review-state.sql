BEGIN TRANSACTION READ ONLY;

WITH active_checkouts AS (
  SELECT checkout.*
    FROM situation_checkouts checkout
   WHERE checkout.released_at IS NULL
),
active_drafts AS (
  SELECT draft.*
    FROM drafts draft
    JOIN active_checkouts checkout
      ON checkout.draft_id = draft.id
),
active_revisions AS (
  SELECT revision.*
    FROM draft_revisions revision
    JOIN active_drafts draft
      ON draft.id = revision.draft_id
),
active_review_jobs AS (
  SELECT job.*
    FROM review_jobs job
    JOIN active_checkouts checkout
      ON checkout.id = job.checkout_id
),
active_review_steps AS (
  SELECT step.*
    FROM review_steps step
    JOIN active_review_jobs job
      ON job.id = step.job_id
),
active_review_runs AS (
  SELECT run.*
    FROM agent_runs run
    JOIN active_review_steps step
      ON step.id = run.step_id
),
active_proposals AS (
  SELECT proposal.*
    FROM review_proposals proposal
    JOIN active_review_jobs job
      ON job.id = proposal.job_id
),
active_candidates AS (
  SELECT candidate.*
    FROM agent_candidate_revisions candidate
    JOIN active_proposals proposal
      ON proposal.id = candidate.proposal_id
),
active_changes AS (
  SELECT change.*
    FROM proposal_changes change
    JOIN active_proposals proposal
      ON proposal.id = change.proposal_id
)
SELECT jsonb_build_object(
  'checkouts', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      checkout.id,
      checkout.situation_id,
      checkout.holder_id,
      checkout.draft_id,
      checkout.fence,
      checkout.acquired_at,
      checkout.released_at,
      checkout.release_reason,
      checkout.forced_by_id,
      checkout.force_reason,
      checkout.resulting_draft_hash
    ) ORDER BY checkout.id)
      FROM active_checkouts checkout
  ), '[]'::jsonb),
  'drafts', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      draft.id,
      draft.situation_id,
      draft.lineage,
      draft.state,
      draft.base_production_version_id,
      draft.base_release_id,
      draft.base_manifest_hash,
      draft.base_pointer_generation,
      draft.base_bundle_hash,
      draft.restoration_parent_id,
      draft.rebase_release_id,
      draft.current_revision_number,
      draft.current_bundle_hash,
      draft.archived_at,
      draft.conflicted_at,
      draft.created_at,
      draft.updated_at
    ) ORDER BY draft.id)
      FROM active_drafts draft
  ), '[]'::jsonb),
  'revisions', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      revision.id,
      revision.draft_id,
      revision.revision,
      revision.parent_id,
      revision.bundle_hash,
      revision.contract_version,
      revision.validation_policy,
      revision.actor_id,
      revision.named_checkpoint,
      revision.created_at
    ) ORDER BY revision.id)
      FROM active_revisions revision
  ), '[]'::jsonb),
  'revisionArtifacts', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      artifact.revision_id,
      artifact.logical_id,
      artifact.kind,
      artifact.visibility,
      artifact.content_hash,
      artifact.position
    ) ORDER BY artifact.revision_id, artifact.position)
      FROM draft_revision_artifacts artifact
      JOIN active_revisions revision
        ON revision.id = artifact.revision_id
  ), '[]'::jsonb),
  'reviewJobs', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      job.id,
      job.situation_id,
      job.input_revision_id,
      job.checkout_id,
      job.checkout_fence,
      job.fence,
      job.state,
      job.context_hash,
      job.contract_version,
      job.policy_version,
      job.started_at,
      job.finished_at,
      job.claim_token,
      job.lease_expires_at,
      job.retry_not_before,
      job.cancelled_at,
      job.cancelled_by_id,
      job.cancellation_reason,
      job.failure_code
    ) ORDER BY job.id)
      FROM active_review_jobs job
  ), '[]'::jsonb),
  'reviewSteps', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      step.id,
      step.job_id,
      step.ordinal,
      step.role_code,
      step.dependencies,
      step.state,
      step.output_hash,
      step.started_at,
      step.finished_at
    ) ORDER BY step.job_id, step.ordinal)
      FROM active_review_steps step
  ), '[]'::jsonb),
  'reviewRuns', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      run.id,
      run.step_id,
      run.attempt,
      run.requested_provider,
      run.resolved_provider,
      run.requested_model,
      run.resolved_model,
      run.reasoning_effort,
      run.evidence_hash,
      run.provider_attempts,
      run.output_hash,
      run.failure_class,
      run.retryable,
      run.started_at,
      run.finished_at
    ) ORDER BY run.step_id, run.attempt)
      FROM active_review_runs run
  ), '[]'::jsonb),
  'proposals', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      proposal.id,
      proposal.job_id,
      proposal.input_revision_id,
      proposal.proposal_hash,
      proposal.created_at
    ) ORDER BY proposal.id)
      FROM active_proposals proposal
  ), '[]'::jsonb),
  'candidates', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      candidate.id,
      candidate.proposal_id,
      candidate.input_revision_id,
      candidate.input_bundle_hash,
      candidate.body_hash,
      candidate.bundle_hash,
      candidate.candidate_hash,
      candidate.created_at
    ) ORDER BY candidate.id)
      FROM active_candidates candidate
  ), '[]'::jsonb),
  'changes', COALESCE((
    SELECT jsonb_agg(jsonb_build_array(
      change.id,
      change.proposal_id,
      change.position,
      change.target_kind,
      change.target_key,
      change.application_mode,
      change.before_hash,
      change.after_hash,
      change.editor_hash,
      change.state,
      change.decided_at,
      change.decided_by_id,
      change.applied_revision_id
    ) ORDER BY change.proposal_id, change.position)
      FROM active_changes change
  ), '[]'::jsonb)
)::text;

COMMIT;
