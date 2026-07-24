# Checkpoint 7 — Creation, retirement, operations, and release candidate

Status: complete locally on 2026-07-23; checkpoint 8 is not authorized.

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
  `68473e423e03277bc8019f17c9e6e54e7d8ad68db91488f031dfe05c82ff4d0b`;
- protected public-gate verifier:
  `8bcc34158834ee5d0f922d0ae43a940a847f4298a42e45d94828e1e84abbf418`;
- fresh-database provisioning:
  `3a6dc220fe296141e18632752055215665d26d96edb0aaab5ed923f418ca083d`;
- runtime-password provisioning:
  `f300b10fc3181d967185a5cd7770af577211cccf514468493a6a67d3d52d56b7`;
- Studio runtime grants:
  `d4c60d5f1b1f9a02697cc673431c6df48b3eb32be81701a1d4786876b1386ca3`;
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

External pre-deployment inputs remain dedicated production CLI authentication
and the Claude fallback smoke, approved Studio hostname, and separate
checkpoint-8 approval. The user explicitly deferred backup configuration for
the initial launch on 2026-07-24; readiness must report that deferral, and
backup configuration becomes required again before any content publication.
Both coordinated release candidates are committed on clean local `main`
branches and remain unpushed.
