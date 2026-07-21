# Spec: Private Candidate Handoff Rebuild

## Goal

Restore a trustworthy, complete human review path from Situation Studio to the
private Leadership candidate so an authorized publisher can reauthenticate,
authorize the exact immutable candidate, explicitly continue through a native
same-tab POST, cause Leadership to record its signed healthy observation,
return to Studio, and only then receive the separate final-publication
confirmation. The public official snapshot must remain unchanged throughout
private review.

## Context

- Production publication request `c078a261-9a02-41e4-9825-cddbd51ed428` is
  paused safely at `CANDIDATE_AVAILABLE` for candidate hash
  `ca8d523a5a4acef439a368c3511296d6058fccd20fb02c7d50cfa17ec7868a34`.
- The official Leadership manifest remains
  `cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e`.
- The previous Studio implementation opened `about:blank` before asynchronously
  creating authorization. In a constrained single-tab browser that replaced
  the Studio page and prevented the request from completing.
- Leadership already uses a full same-site document navigation after candidate
  cookie exchange so its candidate observer mounts with the new cookies.
- Candidate authorization is a sensitive, recent-reauthentication-gated,
  session-and-permission-bound action. Exchange tokens are one-time and must be
  sent in a POST body, never a URL.
- PostgreSQL is the authority for publication state, candidate authorization,
  signed observation receipts, final confirmation, and the official pointer.
- `.temp-logins` contains temporary live credentials. It is local-only,
  ignored, owner-readable only, and its contents must never appear in source,
  process arguments, documentation, logs, test artifacts, commits, or chat.

## Scope — this pass only

- Replace the Studio-side private-candidate handoff as one explicit flow rather
  than retaining popup-era behavior.
- Cover both publication and rollback candidate handoffs through the same
  implementation contract.
- Preserve and verify recent password reauthentication and automatic retry of
  the original handoff action.
- Create one-time, candidate-bound authorization only after all server-side
  state, ownership, target, permission, and recency checks pass.
- Submit the exchange token and safe relative return path to Leadership with a
  user-activated same-tab cross-origin POST and full document navigation.
- Prevent duplicate clicks while authorization or navigation is in progress and
  give accessible, deterministic status/error feedback.
- Add Playwright E2E coverage that provisions a fresh PostgreSQL 16 database
  through Testcontainers, applies all migrations, seeds users/content, starts
  Studio, and uses a local Leadership contract server to exercise the real
  browser navigation and Studio backchannel exchange.
- Test the successful path and critical negative paths: reauthentication,
  single use, exact request/candidate binding, no popup/about:blank, official
  isolation, failure recovery, and the separation of observation from final
  confirmation.
- Run the complete repository verification gate and production build.
- After local acceptance, commit, push, deploy through the guarded exact-commit
  release path, and verify the live signed-in handoff with the temporary
  credentials without performing the owner's final human publication
  confirmation.

## Out of scope / do NOT touch

- Do not manufacture a Leadership observation or final human confirmation.
- Do not select the candidate as official, trigger rollback, or bypass the
  publisher state machine.
- Do not alter candidate bytes, snapshot hashes, reviewer identity, approval,
  or the active publication request.
- Do not change Leadership content or its public reader/publisher authority.
- Do not change the one-hostname, one-process, one-port Leadership topology.
- Do not perform Checkpoint 8 Git-publisher decommissioning, backup/PITR work,
  firewall changes, provider configuration, or unrelated UI work.
- Do not overwrite unrelated user changes. The `.gitignore` protection for
  `.temp-logins` is preserved.

## Constraints

- No popup, named window, `window.open`, or `about:blank` may participate in the
  candidate path.
- The handoff must work in a single-tab browser.
- The exchange uses POST to the configured Leadership candidate origin. The
  token must not enter the URL, browser history, referrer, client logs, or
  persistent browser storage.
- Return destinations are generated from a validated Studio situation slug and
  remain relative paths.
- Candidate authorization remains bound to request, target, snapshot, exact
  snapshot hash, reviewer, audience, expiration, and recent authenticated
  session.
- One authorization can be exchanged at most once; expired, revoked, wrong-
  state, wrong-user, and mismatched-candidate attempts fail closed.
- Private candidate reads and observations never move the official pointer.
- Final confirmation remains a separate recent-reauthenticated human action
  enabled only after the exact signed healthy candidate observation advances
  the publication to `AWAITING_CONFIRMATION`.
- Tests must not use production data or credentials and must refuse a non-test
  database.
- The browser suite owns and disposes its Testcontainers database and local
  processes even on failure.
- Existing secret scanning, CSP, CSRF, exact Host/Origin, audit, and
  least-privilege boundaries remain intact.

## Success criteria (testable)

- [x] Clicking **Review private candidate** never opens a popup and never
      navigates to `about:blank`.
- [x] Without recent authentication, the first click opens the password dialog;
      a correct password retries the same action exactly once.
- [x] While the handoff is pending, the control is disabled and repeated clicks
      cannot create concurrent authorizations.
- [x] Studio creates an authorization only for the active exact candidate and
      returns no token when any state/binding precondition fails.
- [x] The browser performs a same-tab POST to Leadership `/candidate/exchange`
      with only `token` and the expected relative `returnTo` fields.
- [x] Leadership can exchange the token once through Studio's authenticated
      backchannel; replay fails.
- [x] Successful exchange causes a full document navigation to the expected
      private candidate route and does not expose the exchange token in the URL.
- [x] The test candidate route shows the exact candidate hash while a fresh
      anonymous browser context still sees the exact official hash.
- [x] A signed healthy observation for any wrong request, snapshot, hash, key,
      health state, or stale timestamp does not unlock confirmation.
- [x] The exact healthy candidate receipt advances the publisher-owned state to
      `AWAITING_CONFIRMATION`; the official pointer is still unchanged.
- [x] Returning to Studio shows the separate exact-hash final confirmation, but
      the E2E test and live verification do not click it.
- [x] Authorization/network failure leaves the user in Studio with a retryable
      error and no blank or orphaned tab.
- [x] Publication and rollback handoffs share the same tested form/navigation
      implementation.
- [x] `pnpm verify`, the Testcontainers-backed Playwright suite, and the
      production build pass.
- [ ] The guarded deployment reports the exact pushed commit healthy, and a
      signed-in live browser reaches the expected private candidate review step
      without moving the official pointer or recording final confirmation.

## Verification plan

- Use unit/contract tests for state derivation, validated handoff construction,
  authorization preconditions, and one-time exchange behavior.
- Use a Playwright runner that starts `PostgreSqlContainer`, deploys the real
  Prisma migrations, seeds the normal local fixture, and starts Studio with
  database-publication configuration.
- Use a purpose-built local Leadership contract server in E2E only. It must call
  Studio's real `/api/candidates/exchange` backchannel, issue a private test
  cookie, expose candidate/official identities, and retain request evidence for
  assertions without logging token values.
- Query the disposable database to prove authorization, exchange, observation,
  confirmation, and official-pointer invariants.
- Run formatting, lint, strict TypeScript, Prisma validation, unit/integration
  tests, secret scan, production build, and the browser matrix.
- Inspect the git diff for unrelated changes and credential leakage.
- Deploy only a clean, committed, pushed `main` SHA through `deploy.sh`.
- In the live browser, sign in from `.temp-logins`, start the private candidate
  review, verify exact identities and navigation, then stop before final human
  confirmation. Follow with read-only publication-state checks.

## Checkpoints

1. Contract checkpoint: map current Studio, Leadership, publisher, and database
   state transitions; finalize this spec.
2. Implementation checkpoint: replace popup-era client behavior and centralize
   authorization/handoff contracts.
3. Verifier checkpoint: add the Testcontainers environment and focused
   end-to-end tests; prove failures before accepting the implementation.
4. Local acceptance checkpoint: pass focused tests, full verification, and the
   production browser matrix.
5. Release checkpoint: independently inspect the final diff, commit/push the
   exact source, and run the guarded deployment.
6. Live acceptance checkpoint: perform the signed-in private-review handoff and
   read-only state verification, explicitly stopping before final confirmation.

The owner explicitly requested uninterrupted execution until the flow works, so
these are evidence checkpoints within one continuous pass rather than pauses for
routine approval. Any action that would publish, roll back, alter candidate
bytes, or manufacture human evidence remains a hard stop requiring explicit
owner direction.

## Working rules

- Verify every boundary before mutation and fail closed on ambiguity.
- Treat the handoff as one state machine; do not patch isolated symptoms.
- Prefer one explicit, typed implementation path for publication and rollback.
- Keep secrets out of output and artifacts; use environment injection or
  protected standard input where credentials are unavoidable.
- Preserve public behavior and official content until the owner's distinct final
  confirmation.
- Keep implementation changes scoped and delete obsolete popup-era behavior.
- Record objective evidence for every success criterion before declaring done.
