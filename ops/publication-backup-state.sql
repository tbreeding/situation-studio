\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

SELECT CASE
         WHEN backup.id IS NULL THEN 'BACKUP_MISSING'
         WHEN backup.destination_id !~ '^offsite-verified:[a-f0-9]{64}$'
           OR backup.encrypted IS DISTINCT FROM true
           OR backup.object_key IS NULL
           OR backup.object_key !~ '^[A-Za-z0-9._-]+$'
           OR backup.checksum IS NULL
           OR backup.checksum !~ '^[a-f0-9]{64}$'
           OR backup.byte_length IS NULL
           OR backup.byte_length <= 0
           OR backup.verified_at IS NULL
           OR NOT isfinite(backup.verified_at)
           THEN 'BACKUP_INCOMPLETE'
         WHEN backup.verified_at > current_timestamp + interval '5 minutes'
           THEN 'BACKUP_TIMESTAMP_INVALID'
         WHEN backup.verified_at < current_timestamp - interval '26 hours'
           THEN 'BACKUP_STALE'
         WHEN restore_drill.id IS NULL THEN 'RESTORE_DRILL_MISSING'
         WHEN restore_drill.restore_drill_at IS NULL
           OR restore_drill.restore_drill_result IS NULL
           OR restore_drill.restore_drill_result = ''
           OR restore_drill.destination_id !~
                '^offsite-verified:[a-f0-9]{64}$'
           OR restore_drill.encrypted IS DISTINCT FROM true
           OR restore_drill.object_key IS NULL
           OR restore_drill.object_key !~ '^[A-Za-z0-9._-]+$'
           OR restore_drill.checksum IS NULL
           OR restore_drill.checksum !~ '^[a-f0-9]{64}$'
           OR restore_drill.byte_length IS NULL
           OR restore_drill.byte_length <= 0
           OR restore_drill.verified_at IS NULL
           OR NOT isfinite(restore_drill.verified_at)
           OR restore_drill.created_at IS NULL
           OR NOT isfinite(restore_drill.created_at)
           THEN 'RESTORE_DRILL_INCOMPLETE'
         WHEN NOT isfinite(restore_drill.restore_drill_at)
           OR restore_drill.restore_drill_at >
                current_timestamp + interval '5 minutes'
           OR restore_drill.restore_drill_at < restore_drill.verified_at
           OR restore_drill.restore_drill_at < restore_drill.created_at
           THEN 'RESTORE_DRILL_TIMESTAMP_INVALID'
         WHEN restore_drill.restore_drill_at <
                current_timestamp - interval '30 days'
           THEN 'RESTORE_DRILL_STALE'
         WHEN restore_drill.restore_drill_result IS DISTINCT FROM 'PASSED'
           THEN 'RESTORE_DRILL_FAILED'
         ELSE 'READY'
       END AS policy_state,
       backup.id,
       backup.destination_id,
       backup.object_key,
       backup.checksum,
       backup.byte_length,
       restore_drill.id AS restore_drill_receipt_id
  FROM (SELECT true) AS anchor
  LEFT JOIN LATERAL (
    SELECT receipt.id,
           receipt.destination_id,
           receipt.object_key,
           receipt.checksum,
           receipt.encrypted,
           receipt.byte_length,
           receipt.verified_at
     FROM backup_receipts AS receipt
     WHERE receipt.state = 'VERIFIED'
     ORDER BY receipt.created_at DESC, receipt.id DESC
     LIMIT 1
  ) AS backup ON true
  LEFT JOIN LATERAL (
    SELECT receipt.id,
           receipt.destination_id,
           receipt.object_key,
           receipt.checksum,
           receipt.encrypted,
           receipt.byte_length,
           receipt.verified_at,
           receipt.created_at,
           receipt.restore_drill_at,
           receipt.restore_drill_result
     FROM backup_receipts AS receipt
     WHERE receipt.state = 'VERIFIED'
       AND (
         receipt.restore_drill_at IS NOT NULL
         OR receipt.restore_drill_result IS NOT NULL
       )
     ORDER BY receipt.restore_drill_at DESC NULLS FIRST,
              receipt.created_at DESC,
              receipt.id DESC
     LIMIT 1
  ) AS restore_drill ON true;

COMMIT;
