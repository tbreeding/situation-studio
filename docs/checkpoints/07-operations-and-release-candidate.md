# Checkpoint 7 — Creation, retirement, operations, and release candidate

Status as of 2026-07-23: complete locally; checkpoint 8 was not then
authorized.

> Historical pre-deployment checkpoint. Checkpoint 8 was later authorized and
> completed as recorded in `../../HANDOFF.md`; neither that authorization nor
> this record authorizes another deployment or publication.

Creation starts atomically with a validated template, stable slug, checkout,
canonical default practice context, and promotion metadata. The lifecycle
integration publishes a new 16th situation, retires it in a new complete
release, and restores its original public bytes in another forward-only
release. The unrelated comparison situation remains byte-identical throughout.

Operations include admin user/state/password controls, force-check-in, queue
and recovery health, web/review-worker/publisher heartbeats, mode-restricted
per-process environments, PM2 configuration, encrypted backups, checksum
receipts, restore drills, and a gated migration runbook.

The Studio migration checksums are:

| Migration              | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Initial foundation     | `f1aab2e156b9c2cf0bc961ea07b876b3005d647fa1f3247986b01a25fb066bc9` |
| Candidate snapshots    | `5e7046b456c1c418d9585943a0e31df2eec8c6eb0f938658181b77f18163d4fd` |
| Process heartbeats     | `33e3fc73c285eab1564220ca9d5aa041a6663118c6eb0860e5f8faa2efe47dda` |
| Production occurrences | `5499daa121f7de97560dde20f10e22c493f43ae7f53d4dc1270cb0fcb233df1e` |
| Variant immutability   | `6d85343ebb72e165a48193e9ee2a42743136c168ee1ad4939a2267533aac8060` |
| Lineage and leases     | `4fdd192543c4b3b0ce1daf5de529fd15fe14c1f95120a31af9298a3f9b5a4662` |
| Review retry backoff   | `215a97ca59bb9ad0009780683bf9bcfee7d3d48af16022cbb221c91397ae971a` |
| Focused review lane    | `440d9fc1232b075164e1a43ee9ea002aa8dc9b10c1c4f7eaae21ff7336f3cb27` |

The final disposable queued-backup receipt was:

- database receipt:
  `026b779a-fabc-4780-9cab-cbb0f7a6a4bb`;
- state: `VERIFIED`;
- destination: `nightly-encrypted-backup`;
- object: `situation-studio-20260723T215652Z.dump.gpg`;
- SHA-256:
  `1987c46f318bc3fa6376046540e0c461af7666020f43972550611858ff7447a2`;
- encrypted bytes: `65551`.

The same verified queue object was streamed through decrypt-and-restore. It
recovered all 6 migrations, 15 situations, 15 production versions, 16 content
blobs, and 84 audit events into the empty
`situation_studio_restore_drill_20260723_nightly` database. No plaintext dump
was written.

Reviewed operational checksums are:

- guarded deployment launcher:
  `c6d011f4fb0698620c636c186b21582093fa810e13fd7252d6f9bb71b9796ddd`;
- fail-closed release schema helper:
  `e4197d24910e03beb5decede99dcda67835b9b39d36393db887a894b78207217`;
- protected public-gate verifier:
  `8bcc34158834ee5d0f922d0ae43a940a847f4298a42e45d94828e1e84abbf418`;
- fresh-database provisioning:
  `3a6dc220fe296141e18632752055215665d26d96edb0aaab5ed923f418ca083d`;
- runtime-password provisioning:
  `f300b10fc3181d967185a5cd7770af577211cccf514468493a6a67d3d52d56b7`;
- Studio runtime grants:
  `c1971735ca977dc64129a333617347c43726b5de4c55c40e97ae78aa367ea217`;
- isolated launcher:
  `19485675cb21408af8c308ce45a47930774e642ea575e116415bf849ae06355a`;
- pinned subscription CLI installer:
  `7b2c1be29fdbe5a3c5b031519ba84af425a2456b05e6d6868391b84ee6bf23e3`;
- constrained Codex PTY wrapper:
  `c606e518ecb37f9e23791aff6a380bb743c132ff04c07a14bca3a29b34764653`;
- encrypted local/off-site backup:
  `537a82c306ec1feccd75d46564791c1cffe69ac398c33111de92782489653ba4`;
- nightly enqueue:
  `8e1ed5193c63f05eb1bc7433b1fc89d17fbe52f4ef3f0b247c26e649518b27c6`;
- backup queue consumer:
  `21c27177f63061a5bbcc8ed8bae1fc9e81ff179bbca633b7b5a58bc147f05010`.

Final local evidence includes:

- Studio formatting, lint, typecheck, strict secret scan, and optimized
  production build;
- 113 unit tests and 12 cross-database integration scenarios;
- 9 publisher scenarios, including lifecycle, consecutive scoped releases,
  all-release history import, and injected crashes;
- browser/accessibility: 9 passed, 6 intentionally skipped duplicates;
- Leadership: lint, typecheck, 38 unit tests, and 13 integration tests;
- role-grant proof for six non-superuser, non-owner runtime identities,
  including positive and negative table privileges;
- secret scanning after the production build across source, browser assets,
  and logs;
- independent review and dispositions in
  [independent-review.md](independent-review.md).

The 2026-07-25 retry follow-up added the seventh Studio migration; the
real-time status follow-up adds no migration or grant. Their focused provider,
health, UI, stream, security-projection, and worker tests pass. All 16
cross-database integration scenarios pass; the 7-scenario review integration
file passes three consecutive stability repetitions; the 22 focused
review-status tests pass five consecutive repetitions; and the
browser/accessibility suite passes 10 executed scenarios with 8 intentional
duplicate-mutation skips. The full Studio verification gate passes 140 unit
tests, formatting, lint, all workspace typechecks, the strict secret scan, and
the optimized production build.

### Review-status streaming operations

The review-status endpoint requires an HTTP/1.1 or HTTP/2 reverse-proxy path
that forwards response chunks immediately. The application sends
`X-Accel-Buffering: no`, forbids cache storage and transformation, and provides
a comment heartbeat every 15 seconds. Any front proxy or CDN must:

- preserve `text/event-stream` and the authenticated session cookie;
- disable response buffering and compression/transformation for this path;
- keep the upstream idle timeout comfortably above 15 seconds;
- avoid caching or coalescing responses between users; and
- permit a two-minute response, after which native `EventSource` reconnects.

The endpoint is a read-only status projection and requires no new database
grant or CSRF policy. It uses the web runtime role's existing review reads. It
does not keep a PostgreSQL connection checked out while idle. Capacity planning
must account for one live HTTP response and about 0.67 compact status queries
per second for each open active workspace. At materially higher concurrency,
use shared invalidation/broadcast plus connect-time snapshot reads rather than
reducing the snapshot or moving progress authority into browser memory.

Deployment verification for an approved release must confirm that chunks and
15-second heartbeats arrive through the actual proxy without buffering, that
an interrupted connection receives a full reconnect snapshot, and that the
connection closes after terminal state. Before the explicit follow-up
deployment approval, no production deployment or production review retry was
performed for this implementation.

The initial production deployment described in `HANDOFF.md` has already
occurred. The combined follow-up uses the guarded immutable-release launcher,
which applies additive Studio migrations under a temporarily login-enabled
schema-owner role, restores that role to `NOLOGIN` even on failure, reapplies
reviewed runtime grants, records the exact commit in `.release-commit`, and
performs the process cutover only after migration success. The user explicitly
deferred backup configuration for the initial launch on 2026-07-24; readiness
must report that deferral, and backup configuration becomes required again
before any content publication.
