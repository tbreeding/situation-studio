# Production migration runbook

This runbook is evidence for checkpoint 7. It is not authorization to execute
checkpoint 8.

## Required approval packet

Before any production command, record and ask the user to approve:

1. exact Situation Studio and Leadership commit SHAs;
2. the Leadership and Studio migration checksums;
3. the encrypted backup destination and successful restore-drill receipt;
4. the pre-migration Leadership release ID, manifest hash, generation, and
   rendered parity evidence;
5. the exact database-role grant diff;
6. the exact deployment host, release directories, process configuration, and
   rollback command sequence.

The packet must also name the approved Studio HTTPS origin, the off-RP1 backup
SSH target and directory, the retention period enforced on that destination,
and the qualified review-provider route. Do not substitute a guessed hostname,
storage target, or model.

## Read-only preflight

Re-read repository cleanliness, official pointer identity, runtime health,
database names, schema migration history, roles, backup destination, and free
space. Abort on any mismatch. Historical Studio bootstrap uses only the
Leadership reader role and a `READ ONLY` transaction.

## Runtime and backup isolation

Provision separate operating-system users for web, review worker, publisher,
and backup operator. Each process receives only its own mode-0400/0600
environment file through `ops/start-isolated-process.sh`; the launcher clears
the inherited environment before starting the process. The web and review
worker never receive Leadership publisher or backup credentials, and the
publisher never receives login, session, CSRF, throttle, or review-provider
secrets.

Run `ops/process-backup-queue.sh` as the backup operating-system user at least
once per minute. It claims one `QUEUED` receipt with `SKIP LOCKED`, streams
`pg_dump` directly into GPG recipient encryption, verifies the final
destination checksum, replicates the encrypted object to the approved off-RP1
destination with a second checksum verification, and only then marks the
receipt `VERIFIED`. `SITUATION_STUDIO_BACKUP_REQUIRE_OFFSITE=true` is mandatory
in production. Failed commands mark the claimed receipt `FAILED` with a safe
code. A scheduler should also insert a nightly `QUEUED` receipt; successful
publications, restorations, and retirements already enqueue their own receipts.
Use an off-host encrypted destination with independently approved retention.
Never place the database URL or GPG private-key material in command arguments.

Example scheduler entries, installed under the dedicated backup user after the
paths and environment file are approved:

```cron
* * * * * SITUATION_STUDIO_RELEASE=/home/admin/projects/situation-studio/current SITUATION_STUDIO_PROCESS_ENV_FILE=/home/admin/projects/situation-studio/shared/backup.env /home/admin/projects/situation-studio/current/ops/start-isolated-process.sh backup-queue
17 2 * * * SITUATION_STUDIO_RELEASE=/home/admin/projects/situation-studio/current SITUATION_STUDIO_PROCESS_ENV_FILE=/home/admin/projects/situation-studio/shared/backup.env /home/admin/projects/situation-studio/current/ops/start-isolated-process.sh backup-nightly
```

The scheduler entries expose only reviewed paths. The launcher verifies
environment-file mode and ownership and clears the inherited environment; do
not replace the paths with literal credentials.

## Ordered procedure after separate approval

1. Run `deploy.sh` with `SITUATION_STUDIO_PREFLIGHT_ONLY=1` and the exact
   approved commit, host, origin, and host header. This proves the service
   users, mode-restricted environment files, disk, memory, and process manager
   boundary without creating a release.
2. Produce and restore-drill encrypted Leadership and Studio backups, including
   the required checksum-verified off-RP1 copy.
3. Re-read and record the pre-migration official pointer, manifest, artifact
   bytes, API inventory, sitemap, feed, and baseline screenshots.
4. Apply only the reviewed additive Leadership migration as its owner.
5. Re-read the official pointer, manifest, artifact bytes, API inventory,
   sitemap, feed, and baseline screenshots and prove they are unchanged.
6. Create the Studio owner and database with
   `ops/provision-studio-database.sql`; apply the reviewed migrations; create
   and grant runtime roles with `ops/grant-runtime-roles.sql`; then inject the
   five generated runtime passwords from the protected execution environment
   with `ops/provision-studio-role-passwords.sql`.
7. Seed the first administrator through separately supplied secrets.
8. Bootstrap Studio through the read-only Leadership role and compare the
   exact release/hash/generation captured in step 3.
9. Install the exact prepared Studio release and start web, review worker, and
   publisher with distinct environment files and database roles.
10. Verify auth, inventory, `/health/live`, `/health/ready`, heartbeats, and
    Leadership observation. Do not submit production content.
11. Preserve all receipts and stop. A real publication needs another approval
    naming the test situation and expected bundle hash.

The immutable Studio release root is
`/home/admin/projects/situation-studio/releases/<UTC release ID>`, with
`/home/admin/projects/situation-studio/current` as the atomic pointer.
`deploy.sh` starts `situation-studio-web`,
`situation-studio-review-worker`, and `situation-studio-publisher` through the
root-owned PM2 daemon while each application process runs under its dedicated
non-login operating-system user.

## Abort and rollback

Before pointer promotion, abort by stopping the Studio processes and leaving
append-only data in place. The additive Leadership migration does not change
the official release and should not be rolled back in place. After a Studio
publication pointer advance, use the generation-fenced automatic restoration
boundary and verify both database and running Leadership identities. If that
cannot be verified, leave `RECOVERY_REQUIRED` fenced and escalate; do not
attempt an ad hoc edit.
