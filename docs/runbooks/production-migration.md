# Production migration runbook

This runbook originated as checkpoint 7 evidence for the separately authorized
checkpoint 8 deployment, which is now historical and recorded below. It does
not authorize another deployment, migration, review, or content publication.

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

Initial-launch exception: on 2026-07-24 the user explicitly deferred backup
configuration. Set `SITUATION_STUDIO_BACKUP_READINESS_MODE=deferred` only for
this launch. The readiness response must report `backup.state = "deferred"`;
do not create a synthetic receipt. No content publication is authorized, and
backup configuration becomes a hard gate again before the first publication.
That exception remains valid only for a genuine first release with no current
Studio pointer. It is not accepted by a follow-up deployment or publication.

## Current deployed follow-up checkpoint

The focused-review follow-up deployment completed on 2026-08-02. Production
points to immutable release `20260802T114927Z` at exact commit
`328f9a8416f0b5ec1ad4d2a8e3c5e6336a2766d9`. The release grants only `SELECT`
on `situation_checkouts` to `situation_studio_review_worker`; the post-grant
schema guard, a real-PostgreSQL lane query under that role, and the live
privilege check all passed.

The successful cutover receipt is
`7faa3075-d8c2-4a48-beb2-dcc954976da1`, object
`situation-studio-20260802T115032Z-7faa3075-d8c2-4a48-beb2-dcc954976da1.dump.gpg`,
checksum
`07c81103a58d74fe590364915ea8ac5a7a527a367fcdbda5857fdc16f738c0c6`,
and byte length 747,152. The immutable backup marker records active-review hash
`649abf47d2247264917ee51a4c213b8222190bb70a218127d030a547a5f4b269`
and expected-lane hash
`48f0eb54c66386b108f3c3174e59e0becbf53751cd961c6f9e9673048d4472a8`.
The continuity marker records identical before/after review hashes, identical
expected/actual lane hashes, `matched: true`, and `laneMatched: true`.

The current pointer and all three PM2 working directories name that immutable
release. Web, review worker, and publisher are online with zero restarts. Local
live and ready return 200; readiness reports compatible Leadership identity,
fresh worker heartbeats, no publisher recovery, and backup evidence `READY`
with a passed non-empty restore drill. The unauthenticated public probe returns
403 with `private, no-store`. No deployment shell or lease remains.

Authenticated validation covered 1440×1000 and 390×844 layouts, all five
checkout resume anchors, and browser warn/error logs. Operations exposes
receipt-level publisher and backup evidence with safe allow-listed diagnostics
and keeps backup readiness independent of the latest attempt. No browser
console warning or error was observed.

Only `high-performer-hurting-team` was resumed. Retained job
`954d2835-8d2a-41e0-b06e-91582827a045` completed at 24 of 24 stages on attempt
3 and created proposal `695c584e-8afc-4351-8728-bb4d7c7998db` with seven
automatic and three manual-only pending suggestions. No proposal decision or
publication was made. The other four retained jobs and proposals did not
advance. Final review and publication drains are both `0|0|0`; five checkouts
remain active. The post-review active-state and lane hashes are
`c9e20501d0d90464a8a9634d8bcc7cdc8e21bface973a2295b899c451ccc7195`
and `941e37f90200d974536166d926ebd15459f2a4cb3fe3c3684f9573749e8f72a0`.

Earlier failed attempts remain append-only recovery evidence. Attempt
`20260802T095838Z` failed continuity on equivalent `null` versus `false`
no-owner projection; attempt `20260802T113720Z` failed candidate readiness on
missing checkout `SELECT`. Each restored and verified the previous release.
Do not delete or rewrite their receipts, release directories, or evidence.

This completed deployment does not authorize another review or a content
publication. Future deployment work must begin with the full read-only
preflight and a newly named exact commit approval; never reuse an old lease or
resume an abandoned attempt midway.

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

Provision the backup operator's noninteractive PATH with the reviewed Node
runtime, PostgreSQL client tools compatible with PostgreSQL 16 (`psql`,
`pg_dump`, and `pg_restore`), GnuPG, OpenSSH/SCP, `flock`, GNU `timeout`, and
`shasum`. Import the explicitly approved encryption recipient into that user's
GPG home and make its corresponding decryption key available there for the
restore drill; do not copy an administrator keyring. Follow-up preflight checks
each command and both recipient capabilities as that isolated user before it
accepts backup evidence.

The review user has a dedicated home directory for subscription CLI state but
no interactive login shell. Run `ops/install-review-clis.sh` as that user to
install exactly Codex CLI `0.145.0` and Claude Code `2.1.218` under
`~/.local`. Authenticate both subscriptions as that user—Codex device
authentication is suitable for the headless host—and run one structured smoke
through each adapter with `pnpm qualify:review-clis`. Do not copy the
administrator's home or auth files.
The installer rejects either package unless its registry integrity matches the
reviewed SHA-512 value embedded in the script.
Production preference is pinned to Codex `gpt-5.6-sol`, then Claude `sonnet`.
The deployment preflight verifies exact CLI versions and both login states.

Run `ops/process-backup-queue.sh` as the backup operating-system user at least
once per minute. It claims one `QUEUED` receipt with `SKIP LOCKED`, streams
`pg_dump` directly into GPG recipient encryption, verifies the final
destination checksum, replicates the encrypted object to the approved off-RP1
destination with a second checksum verification, and only then marks the
receipt `VERIFIED`. The worker replaces the queue label with an
`offsite-verified:<sha256>` destination attestation derived from the verified
off-site object location; local-only receipts remain explicitly `local-only`
and cannot authorize publication. `STUDIO_BACKUP_REQUIRE_OFFSITE=true` is
mandatory in production. Failed commands mark the claimed receipt `FAILED`
with a safe code. A scheduler should also insert a nightly `QUEUED` receipt;
successful publications, restorations, and retirements already enqueue their
own receipts.
The worker refuses to inspect or claim the queue unless
`STUDIO_BACKUP_DATABASE_URL` and `STUDIO_BACKUP_QUEUE_DATABASE_URL` normalize
to the same PostgreSQL hostname, port, and `situation_studio` database. The two
URLs may use different least-privilege users, but they must not identify
different servers or databases. Follow-up deployment preflight applies the
same candidate-owned check before accepting any receipt.
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

The initial deployed worker verifies and copies off-site objects but predates
the receipt-bound destination marker. For the first follow-up only, let that
exact current worker finish one recent backup, then run the exact approved
`ops/attest-legacy-offsite-backup.sh` as the backup user with `backup.env`
loaded. The script accepts only the two historical queue labels, recomputes the
approved remote object's checksum and byte length, and appends an idempotent
attestation receipt that preserves the original backup verification time. Save
its JSON output with the approval packet. This is a controlled evidence
transition, not a synthetic backup and not permission to edit an existing
receipt. Run and record the restore drill against that exact object. All later
receipts are written with the marker directly by the current queue worker.

The queue worker also holds a destination-scoped `flock`, uses bounded dump,
encryption, database, SSH, and copy operations, and converts an abandoned
`RUNNING` claim to an explicit safe failure before claiming more work. Signals
and command failures run the same receipt/start-time-fenced failure path; a
success is accepted only when exactly one unchanged claim becomes `VERIFIED`.
Do not run a second ad-hoc worker around this lock or manually rewrite a
receipt.

Run `ops/record-restore-drill.sh <receipt-uuid>` as the backup user for the
exact newly verified or legacy-attested receipt. Supply the absolute `current`
release link as `SITUATION_STUDIO_RELEASE`, the protected `backup.env` path as
`SITUATION_STUDIO_PROCESS_ENV_FILE`, and the separately computed SHA-256 of the
exact approved candidate recorder as
`SITUATION_STUDIO_APPROVED_RESTORE_RECORDER_SHA256`. This digest is mandatory
because the initial deferred release does not contain the new recorder: a
regular candidate copy may run before deployment, but the script verifies its
own bytes at start and again before recording success, and invokes only the
restore script from the immutable current release. Recompute and reapprove the
digest after any candidate edit.

The recorder re-reads the protected backup environment, proves the receipt is
complete and bound to the currently configured target, rechecks local and
off-site checksum and byte length, and invokes the bounded restore drill
against the configured empty `situation_studio_restore_drill_*` database. It
records `PASSED` or `FAILED` only while the receipt's verified facts remain
unchanged. Publication and deployment accept a passed drill only for that
complete receipt, no earlier than its verification or creation, no more than
30 days old, and not materially in the future. Save its JSON output—which
includes the receipt ID, recorder digest, and current restore-script release
commit—with the approval packet, then discard or recreate the disposable drill
database before another run.
The drill also fails unless the restored database contains migrations,
situations, production versions, and content blobs; an empty schema or empty
production dataset is never valid restore evidence.

## Ordered procedure after separate approval

1. Re-read repository cleanliness, host identity, current service and database
   inventory, official Leadership identity, schema history, roles, disk, and
   memory without mutation. Abort on any mismatch with the approved packet.
2. Create the approved service users, home/release/shared/backup directories,
   and mode-restricted per-process environment files. Install and authenticate
   the two pinned subscription CLIs under the dedicated review user and run
   structured Codex and no-tools Claude smokes. Before any follow-up release,
   set `SITUATION_STUDIO_BACKUP_READINESS_MODE=required` in `web.env`; the
   launcher rejects the historical deferred mode for the candidate.
3. Run `deploy.sh` with `SITUATION_STUDIO_PREFLIGHT_ONLY=1` and the exact
   approved commit, host, origin, and host header. This proves the application
   service users, exact authenticated CLI versions, mode-restricted application
   environment files, disk, memory, and process-manager boundary without
   creating a release. On every follow-up release it also proves the backup
   user and environment, exact schedules, current encrypted off-host backup,
   and passed restore-drill evidence through the committed read-only database
   policy that matches the publication guard. This direct proof intentionally
   does not depend on candidate-only health-response fields, so it can safely
   transition the initially deferred release. A genuine first release has no
   current service from which to prove that evidence; `first-deploy-deferred`
   skips only that impossible current-release check, while the publication gate
   remains locked. Before any release directory is created, the candidate-owned
   verifier requires `web.env` to be exactly `deferred` for a genuine first
   release or exactly `required` for every follow-up.
4. On the first release only, record the explicit initial-launch backup
   deferral; do not create a synthetic receipt or represent that a production
   backup exists. On every follow-up release, require the verified encrypted
   off-site backup receipt and non-empty restore evidence named in the approved
   packet before continuing.
5. Re-read and record the pre-migration official pointer, manifest, artifact
   bytes, API inventory, sitemap, feed, and baseline screenshots.
6. Apply only the reviewed additive Leadership migration as its owner, deploy
   the exact approved Leadership application commit through its immutable
   release launcher, and verify local health.
7. Re-read the official pointer, manifest, artifact bytes, API inventory,
   sitemap, feed, and baseline screenshots and prove they are unchanged.
8. Create the Studio owner and database with
   `ops/provision-studio-database.sql`; apply the reviewed migrations; create
   and grant runtime roles with `ops/grant-runtime-roles.sql`; then inject the
   five generated runtime passwords from the protected execution environment
   with `ops/provision-studio-role-passwords.sql`.
9. Seed the first administrator through separately supplied secrets.
10. Bootstrap Studio through the read-only Leadership role and compare the
    exact release/hash/generation captured in step 5.
11. Install the exact prepared Studio release and start web, review worker, and
    publisher with distinct environment files and database roles. On the first
    release only, set
    `SITUATION_STUDIO_PUBLIC_GATE_MODE=first-deploy-deferred`; the launcher
    rejects that mode if a prior Studio release already exists.
12. Register the exact approved slug in the TimsPrototypes access platform,
    pointing it to RP1's approved private IPv4 and port 3015. Run
    `ops/verify-public-gate.sh`; an unauthenticated `/health/live` probe must
    receive the platform's fail-closed 403 plus `Cache-Control: private,
no-store`. Unknown hosts receive 404, so this also proves the protected
    route exists. All later deployments use the launcher's default `required`
    gate mode.
13. Verify authenticated access, inventory, local `/health/live`,
    `/health/ready`, heartbeats, and
    Leadership observation. Do not submit production content.
14. Preserve all receipts and stop. A real publication needs another approval
    naming the test situation and expected bundle hash.

The immutable Studio release root is
`/home/admin/projects/situation-studio/releases/<UTC release ID>`, with
`/home/admin/projects/situation-studio/current` as the atomic pointer.
For subsequent releases, `deploy.sh` installs and builds the immutable release,
then stops web intake and review execution. Before stopping the publisher it
waits until every publication attempt has a non-null finish time—even when its
job already has a terminal state—and until no requested or active publication
remains; it refuses cutover if recovery is required. This preserves terminal
failure and recovery evidence before process shutdown.

The launcher holds one atomic, random-token deployment lease at
`shared/.deployment-lease` from the first production-host mutation through
local and public verification or rollback. The deployment and shared roots
must be owned by the deployment operator and must not be group- or
world-writable. Every release, migration, pointer, process, rollback, and lease
cleanup mutation rechecks the same token. An existing lease—including one that
appears stale—blocks a second deployment and is never removed based on age.
Immediately before stateful cutover, the launcher marks that lease unsafe to
release. A signal, lost SSH acknowledgement, ambiguous remote failure, or
unverified rollback deliberately leaves the lease in place and directs the
operator to the recovery procedure below; the local launcher never races a
possibly still-running remote cutover with a competing rollback. Lease release
becomes safe again only after the candidate passes every applicable gate or the
exact previous release is synchronously restored and locally verified.

With Studio quiesced, the launcher captures a content-body-free core projection
of active checkouts, draft resume anchors, revisions and artifact references,
review jobs, steps, runs, proposals, candidates, and proposal decisions. It also
derives the lane migration's expected normalized queue times from the earliest
`REVIEW_QUEUED` audits, falling back to the stored queue time, and derives the
expected focused owner from the pre-migration running jobs. After migration it
hashes the same core projection and the actual queue times/lane owner. Cutover
continues only when the core before/after hashes and expected/actual lane hashes
both match, at which point the release records an
`active-review-state-continuity-v2` receipt. Content bodies are not included in
the receipt.

On every follow-up deployment, after all three application processes are
quiesced and before migration, the launcher creates one exact preclaimed backup
receipt and an append-only `DEPLOYMENT_BACKUP_ANCHORED` audit event containing
the approved commit, release ID, database-clock quiescence time, and both review
projection hashes. The candidate worker synchronously creates a
receipt-suffixed encrypted off-site backup, then decrypts that exact local
artifact and has `pg_restore` read its custom-format catalog under timeouts.
Cutover requires the exact start-time-fenced receipt to become `VERIFIED` after
quiescence, match the preflight-frozen local/off-site destinations and resolved
encryption-key fingerprint, and retain unchanged review and lane projections
across the dump. The release records `.pre-migration-backup.json` only after all
checks pass. The ordinary 26-hour publication policy remains in force; this is
an additional, stricter deployment-only checkpoint. A genuine first release
has no prior Studio state and therefore has no post-quiescence checkpoint.
The isolated deployment-backup wrapper compares the frozen configuration hash
before it invokes the preclaimed worker, so configuration drift cannot mint a
new `VERIFIED` receipt before cutover aborts; the exact destination-ID check is
repeated afterward as defense in depth.

The schema helper temporarily enables login for the owner with the protected
`STUDIO_OWNER_MIGRATION_PASSWORD`, restores the owner to `NOLOGIN` on success
or failure, reapplies the reviewed runtime grants, and verifies the required
schema and privileges. A migration, continuity, cutover, local-health, or
required public-gate failure restores the exact previous immutable release and
restarts all three processes from it. Rollback is successful only after the
`current` symlink resolves to that release and both local `/health/live` and
`/health/ready` pass; failure to prove either condition is a critical deployment
failure. Additive database migrations remain forward-only and must stay
compatible with the previous release.

## Unreleased deterministic-preflight migration

The following procedure describes the local deterministic-reliability
overhaul. It has not been applied to production and requires a separate exact
deployment approval. Its implementation and local acceptance evidence are in
[`../validation/deterministic-reliability-overhaul-2026-08-02.md`](../validation/deterministic-reliability-overhaul-2026-08-02.md).

For subsequent releases, `deploy.sh` applies pending additive Studio migrations
before process cutover by temporarily enabling login for the schema owner with
the protected `STUDIO_OWNER_MIGRATION_PASSWORD`. The deterministic-preflight
migration is
`20260802120000_deterministic_publication_preflight`, SHA-256
`4e52a104b1eeae504cc25e6ac6450e4af2065cbeffc8e7dee76897cd34cd60ff`.
It is additive for reads and retained review/proposal writers, but a new
publication insert deliberately requires a sealed receipt and is therefore not
compatible with the old web publisher-request shape.

For this migration the launcher first stops the old web process, leaving the
old publisher running to drain every `REQUESTED`, `ASSEMBLING`, `PROMOTING`, or
`VERIFYING` job. It waits at most five minutes, aborts if the drain is nonzero,
then stops the publisher and applies the migration. No new publication write
can race that window. The review worker may remain live because its old insert
shape is backfilled and verified by compatibility triggers. The helper restores
the schema owner to `NOLOGIN` on success or failure, reapplies the reviewed
runtime grants, and verifies the new receipt tables, identity columns, and
least-privilege access.

The compatible Leadership release must be deployed and verified first. It
must expose `@leadership-field-guide/content-contracts` 0.3.0 with archive
SHA-256
`ef9a723608977b3f9ea3c25bd1a7cd5f323871854937c0e462a21ca057ee9f7f`,
validation-policy hash
`9131270fbc6a2e579ee10752fddf3f1f133b257a554666ea946bb76439deceee`,
compiler identity `leadership-publication-compiler-v1`, compiler digest
`5a0b47948760e9134eaac1727bc658de56c87e52bcc9e03db424bb80ea2d4c95`,
validator digest
`0104cd5e4f02ed5172ca5b7c14e31a694e11319e703cbeb3eec4d226518fc53a`,
typed route proof `affected-route-proof-json-v1`, and situation contract 1.0.0
archive SHA-256
`9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4`.
Recheck those exact capabilities and the no-store verification route before
cutting Studio over.

The capability digest is calculated over the complete producer JSON object,
excluding only `capabilityDigest`, before compatibility is decided. A Studio
consumer must preserve additive response fields through schema validation;
otherwise it can remove a valid digest-covered field and falsely report a
digest mismatch. The corrected readiness response distinguishes this
allow-listed Leadership incompatibility from a Studio database outage while
remaining HTTP 503. Do not reinterpret either state as ready or bypass the
launcher's required 200/`ready` preflight.

Migration or cutover failure restarts the prior processes and restores the
prior release pointer where applicable. Once this migration has committed, an
old-release rollback remains usable for editing and review but is intentionally
fail-closed for new publication requests; restore the compatible new release
before accepting publication work. Do not weaken the receipt trigger to regain
old-writer publication availability. The additive migration remains
forward-only.

When the approved host is reached through a private address that is not the
local SSH alias, set `SITUATION_STUDIO_DEPLOY_USER` explicitly. The launcher
validates the user and host separately, archives only the exact pushed commit,
and records that commit in the immutable release's `.release-commit` marker.
`deploy.sh` starts `situation-studio-web`,
`situation-studio-review-worker`, and `situation-studio-publisher` through the
root-owned PM2 daemon while each application process runs under its dedicated
non-login operating-system user.

## Deployment lease recovery

Treat an abandoned `.deployment-lease` as a failed deployment requiring human
reconciliation, not as a stale lock to expire. First perform only read-only
checks on both the operator machine and production host:

1. Confirm no local `deploy.sh` process, supervising terminal, CI job, or SSH
   client for the deployment is still active. On the host, confirm no matching
   deployment shell or SSH session remains. Reconcile with the named operator;
   a network interruption may leave a live remote command after the local
   client disappears. Use `pgrep -af 'deploy\.sh|ssh .*rpi1'` on the operator
   machine and
   `ps -eo pid,ppid,user,lstart,args | grep -E '[d]eploy\.sh|[b]ash -s --|[s]shd:.*@'`
   plus `who` on the host; explain every match rather than assuming it is stale.
2. Inspect the exact deployment and shared directories plus lease entries with
   `stat -c '%U %a %n' /home/admin/projects/situation-studio{,/shared,/shared/.deployment-lease,/shared/.deployment-lease/token,/shared/.deployment-lease/metadata}`
   and
   `find /home/admin/projects/situation-studio/shared/.deployment-lease -mindepth 1 -maxdepth 1 -printf '%f\n'`.
   The first two directories and lease must belong to the deployment operator;
   the parents must not be group/world writable, the lease must be mode 0700,
   and a complete lease has only mode-0600 regular `token` and `metadata`
   files. Do not follow or replace links.
3. Read `metadata` and correlate its commit, UTC release ID, start time, and
   operator with the abandoned approved run. Inspect the exact `current`
   symlink, its `.release-commit`, the candidate release marker and continuity
   receipts, `sudo pm2 status`, and local live/ready responses. Decide whether
   the previous or candidate release is actually running and healthy before
   touching the lease. The read-only host commands are:

   ```bash
   sed -n '1,20p' /home/admin/projects/situation-studio/shared/.deployment-lease/metadata
   readlink -f /home/admin/projects/situation-studio/current
   cat /home/admin/projects/situation-studio/current/.release-commit
   sudo pm2 status
   curl -fsS http://127.0.0.1:3015/health/live
   curl -fsS http://127.0.0.1:3015/health/ready
   ```

4. Obtain explicit human authorization naming the lease metadata, observed
   token, current release, and desired recovery. Never infer authorization from
   elapsed time, and never use recursive removal.
5. For a complete lease, capture the 64-hex token, re-read and compare it
   immediately before removal, then use the approved
   `ops/manage-studio-deployment-lease.sh release <studio-root> <token>` helper.
   The helper refuses a changed token, unsafe parent, unexpected entry, owner,
   or mode. Do not copy a token from another run. Substitute the exact release
   ID already reconciled from `metadata` and run:

   ```bash
   lease_token="$(cat /home/admin/projects/situation-studio/shared/.deployment-lease/token)"
   [[ "${lease_token}" =~ ^[a-f0-9]{64}$ ]]
   test "$(cat /home/admin/projects/situation-studio/shared/.deployment-lease/token)" = "${lease_token}"
   /bin/bash /home/admin/projects/situation-studio/releases/<metadata-release-id>/ops/manage-studio-deployment-lease.sh release /home/admin/projects/situation-studio "${lease_token}"
   ```

   If that candidate helper was not extracted, transfer only a separately
   checksum-verified copy from the exact approved commit and invoke it the same
   way; do not fall back to an older `current` helper.

6. If `mkdir` succeeded but token or metadata creation did not, the helper
   reports an **incomplete or unsafe lease** and cannot token-release it. After
   the same reconciliation and a separate explicit authorization naming this
   incomplete acquisition, remove only verified regular `token` and/or
   `metadata` files that actually exist, then `rmdir` the exact
   `.deployment-lease` directory. Stop if any other entry, link, owner, or mode
   is present. After the `find` output proves there are no other entries, use:

   ```bash
   incomplete_lease=/home/admin/projects/situation-studio/shared/.deployment-lease
   for lease_entry in token metadata; do
     if [[ -e "${incomplete_lease}/${lease_entry}" ]]; then
       test -f "${incomplete_lease}/${lease_entry}"
       test ! -L "${incomplete_lease}/${lease_entry}"
       rm -- "${incomplete_lease}/${lease_entry}"
     fi
   done
   rmdir -- "${incomplete_lease}"
   ```

After either recovery path, re-run the full read-only deployment preflight. Do
not resume halfway through the abandoned deployment.

## Abort and rollback

Before pointer promotion, abort by stopping the Studio processes and leaving
append-only data in place. The additive Leadership migration does not change
the official release and should not be rolled back in place. After a Studio
publication pointer advance, use the generation-fenced automatic restoration
boundary and verify both database and running Leadership identities. If that
cannot be verified, leave `RECOVERY_REQUIRED` fenced and escalate; do not
attempt an ad hoc edit. While fenced, editors may inspect saved work but Studio
must reject new situations, new checkouts, and editorial mutations globally.
