\set ON_ERROR_STOP on

BEGIN;

WITH deployment_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(
    hashtextextended('situation-studio-deployment-backup', 0)
  )
), input AS (
  SELECT :'quiesced_at'::timestamptz AS quiesced_at,
         :'release_id'::text AS release_id,
         :'commit'::text AS commit,
         :'review_hash'::text AS review_hash,
         :'lane_hash'::text AS lane_hash
), anchor AS (
  SELECT input.*, clock_timestamp() AS created_at
    FROM input
    CROSS JOIN deployment_lock
   WHERE input.release_id ~ '^[0-9]{8}T[0-9]{6}Z$'
     AND input.commit ~ '^[a-f0-9]{40}$'
     AND input.review_hash ~ '^[a-f0-9]{64}$'
     AND input.lane_hash ~ '^[a-f0-9]{64}$'
), receipt AS (
  INSERT INTO backup_receipts (
    id,
    state,
    destination_id,
    encrypted,
    started_at,
    created_at
  )
  SELECT gen_random_uuid(),
         'RUNNING',
         'deployment-quiesced',
         true,
         anchor.created_at,
         anchor.created_at
    FROM anchor
   WHERE anchor.created_at > anchor.quiesced_at
  RETURNING id, started_at, created_at
), event AS (
  INSERT INTO audit_events (
    id,
    actor_id,
    action,
    subject_type,
    subject_id,
    payload,
    occurred_at
  )
  SELECT gen_random_uuid(),
         NULL,
         'DEPLOYMENT_BACKUP_ANCHORED',
         'BACKUP_RECEIPT',
         receipt.id::text,
         jsonb_build_object(
           'schemaVersion', 'deployment-backup-v1',
           'receiptId', receipt.id::text,
           'quiescedAt', anchor.quiesced_at,
           'createdAt', receipt.created_at,
           'releaseId', anchor.release_id,
           'commit', anchor.commit,
           'reviewStateHash', anchor.review_hash,
           'expectedLaneHash', anchor.lane_hash
         ),
         receipt.created_at
    FROM receipt
    CROSS JOIN anchor
  RETURNING subject_id
)
SELECT receipt.id::text,
       receipt.started_at::text,
       receipt.created_at::text
  FROM receipt
  JOIN event ON event.subject_id = receipt.id::text;

COMMIT;
