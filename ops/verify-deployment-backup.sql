\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

SELECT CASE
         WHEN receipt.id IS NULL THEN 'RECEIPT_MISSING'
         WHEN receipt.state IS DISTINCT FROM 'VERIFIED'
           THEN 'RECEIPT_NOT_VERIFIED'
         WHEN receipt.created_at IS NULL
           OR receipt.started_at IS NULL
           OR receipt.verified_at IS NULL
           OR NOT isfinite(receipt.created_at)
           OR NOT isfinite(receipt.started_at)
           OR NOT isfinite(receipt.verified_at)
           OR receipt.created_at <= :'quiesced_at'::timestamptz
           OR receipt.created_at IS DISTINCT FROM
                :'receipt_created_at'::timestamptz
           OR receipt.started_at IS DISTINCT FROM
                :'receipt_started_at'::timestamptz
           OR receipt.started_at < receipt.created_at
           OR receipt.verified_at < receipt.started_at
           OR receipt.verified_at > current_timestamp + interval '5 minutes'
           THEN 'RECEIPT_TIMESTAMP_INVALID'
         WHEN :'expected_destination_id' !~ '^offsite-verified:[a-f0-9]{64}$'
           OR receipt.destination_id IS DISTINCT FROM :'expected_destination_id'
           OR receipt.encrypted IS DISTINCT FROM true
           OR receipt.object_key IS NULL
           OR receipt.object_key !~ (
             '^situation-studio-[0-9]{8}T[0-9]{6}Z-' ||
             receipt.id::text ||
             '\.dump\.gpg$'
           )
           OR receipt.checksum IS NULL
           OR receipt.checksum !~ '^[a-f0-9]{64}$'
           OR receipt.byte_length IS NULL
           OR receipt.byte_length <= 0
           OR receipt.failure_code IS NOT NULL
           THEN 'RECEIPT_INCOMPLETE'
         WHEN anchor.event_count IS DISTINCT FROM 1
           OR anchor.payload_matches IS DISTINCT FROM true
           THEN 'ANCHOR_MISMATCH'
         ELSE 'READY'
       END AS policy_state,
       receipt.id,
       receipt.destination_id,
       receipt.object_key,
       receipt.checksum,
       receipt.byte_length,
       receipt.created_at,
       receipt.started_at,
       receipt.verified_at
  FROM (SELECT true) AS singleton
  LEFT JOIN LATERAL (
    SELECT candidate.*
      FROM backup_receipts AS candidate
     WHERE candidate.id = :'receipt_id'::uuid
     LIMIT 1
  ) AS receipt ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS event_count,
           bool_and(
             payload_shape.key_count = 8
             AND event.payload->>'schemaVersion' = 'deployment-backup-v1'
             AND event.payload->>'receiptId' = receipt.id::text
             AND (event.payload->>'quiescedAt')::timestamptz =
                  :'quiesced_at'::timestamptz
             AND (event.payload->>'createdAt')::timestamptz =
                  receipt.created_at
             AND event.payload->>'releaseId' = :'release_id'
             AND event.payload->>'commit' = :'commit'
             AND event.payload->>'reviewStateHash' = :'review_hash'
             AND event.payload->>'expectedLaneHash' = :'lane_hash'
             AND event.occurred_at = receipt.created_at
           ) AS payload_matches
      FROM audit_events AS event
      CROSS JOIN LATERAL (
        SELECT count(*)::integer AS key_count
          FROM jsonb_object_keys(event.payload)
      ) AS payload_shape
     WHERE event.action = 'DEPLOYMENT_BACKUP_ANCHORED'
       AND event.subject_type = 'BACKUP_RECEIPT'
       AND event.subject_id = receipt.id::text
  ) AS anchor ON receipt.id IS NOT NULL;

COMMIT;
