# Spec: Situation Studio Desktop UI/UX Improvement Pass

## Goal

Make Situation Studio faster to understand and safer to operate during a normal desktop session on a 13-inch MacBook Air, without weakening its immutable-content, review, authorization, or sensitive-data boundaries.

The implementation decision this spec serves is: **which high-confidence UI/UX changes should be made first so the operator can find a situation, understand its state and blast radius, create a complete brief, and identify the next valid action without decoding implementation details or encountering permission dead ends?**

This is an implementation-ready candidate spec, not authorization to begin implementation. The user must review and confirm or revise it first.

## Context

- Situation Studio is a private operations application for creating, reviewing, validating, and publishing coherent Leadership Field Guide learning bundles.
- PostgreSQL owns workflow state and history. The Leadership Git repository owns exact published artifact bytes and deployable history.
- The live protected application contained 15 published situations and zero active checkouts during the audit.
- Provider execution is disabled in production. Manual editing remains available; deterministic fake adapters are acceptance-only.
- The audit used the invited `agent` account through both authentication gates.
- The account can view Situation Studio, the inventory, creation form, jobs, capacity, and all 15 existing situation workspaces.
- The account cannot access Administration. Opening the visible Administration navigation item redirects silently to the Situations home page.
- The user explicitly set this pass as desktop-only, using a 13-inch MacBook Air as the reference device.
- The primary evidence viewport was 1440×900 CSS pixels. Verification must also cover 1280×800 to protect realistic browser-window and display-scaling variation on a 13-inch laptop.
- The existing visual language is editorial and distinctive: dark green, cream, warm status colors, serif display headings, compact uppercase labels, and bordered operational cards.
- Existing acceptance evidence reports passing formatting, lint, strict TypeScript, Prisma validation, secret scanning, production build, 23 contract/unit tests, 8 Chromium browser tests, and zero browser console errors in the accepted build.

### Audit method and ground truth

The audit used the live authenticated UI, DOM/accessibility snapshots, screenshots, computed layout measurements, route inventory, browser console inspection, `HANDOFF.md`, and `artifacts/reports/acceptance.json`.

Observed route types:

- Authentication activation and sign-in
- Situations inventory (`/`)
- New-situation brief (`/situations/new`)
- Situation workspace (`/situations/[slug]`), checked across all 15 baseline situations
- Review jobs (`/jobs`)
- Provider capacity (`/capacity`)
- Administration (`/administration`), present in navigation but inaccessible to this account

The following existing behavior is ground truth and must be preserved:

- All 15 published workspace editors were read-only before checkout.
- No audited desktop page had document-level horizontal overflow at 1440×900.
- Existing routes loaded without browser console warnings or errors.
- Skip-to-content, semantic primary navigation, labeled form controls, published state, checkout availability, draft state, validation state, blocking-comment count, and blast-radius count were exposed in the DOM.
- The content safety boundary was prominent on the inventory and creation pages.

## Observed findings

### What is already working well

- The product has a coherent visual identity rather than looking like a generic administration template.
- Authentication explains that the outer access gate and Studio account are separate.
- Activation copy clearly explains password privacy, minimum length, and the single-use link.
- The inventory makes publication and checkout availability visible without opening a workspace.
- Situation workspaces successfully combine baseline content, connected surfaces, and workflow state.
- The exact published artifact remains visible and read-only until a checkout is obtained.
- Sensitive-data warnings are direct, specific, and placed before content entry.
- The creation form names important epistemic and safety questions: known context, assumptions, unknowns, impact of unknowns, desired outcome, escalation, learning objective, approved source basis, positive guidance, and prohibited guidance.
- The interface is contained at the target desktop width, and the live audit produced no console errors.

### P1 — Permissions-aware navigation is missing

Observed evidence:

- Primary navigation always displayed Situations, Jobs, Capacity, and Administration.
- No primary navigation link exposed `aria-current` on its matching route.
- The `agent` account could not open Administration; the request redirected to the Situations home page without an explanation.

Critique:

- A navigation item communicates availability. A silent redirect makes the user question whether the click failed, the route is broken, or their role changed.
- The absence of a current-page state makes orientation harder across similar cream-and-green screens.
- Rendering an unauthorized destination weakens the otherwise strong authorization model at the presentation layer, even when server enforcement is correct.

Recommended change:

- Derive navigation visibility from the same server-authoritative capability/role policy that protects the route.
- Hide Administration for accounts that cannot access it. Do not create a parallel client-only permission interpretation.
- Add an unambiguous visual current-page treatment and `aria-current="page"` to the active primary link.
- Keep unavailable capabilities out of primary navigation. If product policy later requires permission discovery, explain it in account/help documentation rather than presenting a dead primary action.

### P1 — The new-situation brief is cognitively unstructured

Observed evidence at 1440×900:

- The main form was 2,574 px tall inside a 3,108 px page.
- It contained 19 required controls: two text inputs, two related-situation selects, fourteen textareas, and one confirmation checkbox.
- It contained no `fieldset` elements and only one internal form heading.
- None of the controls used `aria-describedby` for persistent instructions.
- Most explanatory guidance existed only as placeholder text, which disappears during entry.
- The stable slug must be authored manually before the situation title.
- The submit button remained enabled when every required field was empty; native required-field validation is the only immediately discoverable constraint.
- Both related situations are required before the immutable brief can be created.
- “Grilling-based discovery” is distinctive but reads as internal methodology jargon without an explanation.

Critique:

- Nineteen required decisions presented as one uninterrupted card creates completion anxiety and makes it hard to resume after interruption.
- Placeholder-only prompts stop helping precisely when the operator is reviewing an entered answer.
- Identity, context, uncertainty, safety, pedagogy, source grounding, and guidance boundaries are different reasoning tasks and should not appear as one undifferentiated sequence.
- Manual slug entry is implementation work that can usually be derived from the title and confirmed rather than invented first.
- Native validation alone does not explain total progress, the first incomplete section, or why a field matters.

Recommended change:

- Keep the existing immutable-brief and human-confirmation contract, but organize the controls into four plain-language sections:
  1. Name and connect — title, generated/editable slug, two related situations.
  2. Understand the situation — observed problem, audience, manager role, known context, assumptions, unknowns, impact, desired outcome.
  3. Set safety and learning guardrails — safety/escalation, observable learning objective, source basis.
  4. Define the guidance — should advise, must not advise, expected surfaces, final human confirmation.
- Keep the sections on one reviewable page rather than forcing a step-by-step wizard. Provide a sticky section outline/progress summary, allow completed sections to collapse, and keep incomplete/error sections expanded.
- Use semantic `fieldset`/`legend` or equivalent labeled regions with correct heading hierarchy.
- Keep short examples in placeholders, but move the actual instruction and any invariant to persistent help text associated with each control.
- Generate the slug from the title, keep it editable, show the final route preview, and validate uniqueness before an immutable brief is created.
- Add a compact progress summary that identifies complete and incomplete sections without saving partial content to production.
- On attempted submission, present an error summary, focus the first invalid control, set `aria-invalid`, preserve all entered values, and make no mutation request until client-side validity passes.
- Explain “discovery brief” in plain language; retain “grilling-based discovery” only as secondary methodology language if it is important to the product vocabulary.

### P1 — The situation workspace prioritizes raw implementation detail over operator comprehension

Observed evidence on a representative published workspace at 1440×900:

- The workspace used a 1,324 px main area with three simultaneous columns: 240 px bundle surfaces, 690 px artifact, and 320 px review state.
- The display title used a 72 px font and occupied 140–210 px vertically across the 15 audited titles.
- The raw MDX editor was 690×368 px, used a 12.8 px font, and contained 2,326 px of vertically scrollable content in the representative situation.
- All 15 workspaces preserved a read-only editor and had no document-level horizontal overflow.
- Bundle-surface entries exposed raw paths, slugs, and relation types, but contained no links.
- The page showed “All saved” beside a read-only published baseline, which implies an editing context that does not yet exist.
- The Review State panel showed “No mutable draft yet,” “No proposal,” and “Validations: Not run” beside a prominent PUBLISHED state without explaining that these are current-workflow states layered over a valid published baseline.
- “Archive situation” was enabled while the adjacent “Required reason for archive” input was empty and did not carry the HTML `required` attribute.

Critique:

- The page successfully exposes the system model, but it asks the operator to interpret three dense representations at once.
- The editorial title dominates a page whose primary job is operational decision-making.
- A small, internally scrolling source field is a poor default reading surface for 4,000–5,300 character artifacts.
- Raw relation labels such as “Uses,” “Used by,” internal paths, and slugs reveal the graph but do not help the operator navigate it.
- Published-baseline state and current proposal/draft state are mixed without an explicit lifecycle model.
- The archive reason and action affordances visually contradict the claim that a reason is required.

Recommended change:

- Default published workspaces to a readable rendered preview with a deliberate “Source MDX” secondary view. The source view must preserve exact bytes and remain read-only until checkout.
- Give Source MDX at least a 14 px monospace font and an expand/full-screen control. Avoid making a short nested scroller the only way to inspect the artifact.
- Reduce recurring operations-page titles to a responsive 48–64 px range so the imported workspace titles occupy no more than two lines at 1280–1440 px. Preserve the serif face, weight, palette, and editorial voice; reserve larger display treatment for authentication or true introductory surfaces.
- Reframe the top of the page around the next valid action: published baseline, checkout availability, current owner if checked out, and the primary checkout/review action.
- Present baseline, draft, proposal, validation, approval, and publication as an ordered lifecycle with plain-language explanations. Make it obvious that “not run” refers to a nonexistent/current candidate, not to the validity of the published baseline.
- Group bundle connections by surface type. Link situation relations to their workspaces and link any other entities only where a real in-product destination exists. Keep non-navigable repository paths visibly copyable rather than styling them like dead navigation.
- Make lower-priority dependency detail collapsible without hiding the blast-radius count.
- Move archive controls into a visually separated danger area. Match the UI to the backend invariant: require a nonblank reason, expose inline validation, and require explicit confirmation before submitting the archive request.
- Replace “All saved” in the read-only baseline state with “Published baseline · read-only” or similarly accurate language.

### P2 — The situation inventory is visually strong but operationally inefficient

Observed evidence at 1440×900:

- The inventory contained 15 equal 431×272 px cards in three columns and produced a 2,019 px page.
- The page-level display heading used an 86.4 px font and occupied 161 px.
- Every card repeated PUBLISHED, checkout-availability copy, active state, and “Open workspace.”
- The page contained no search input, filter, select, or sort control.

Critique:

- The large hero is appropriate for a landing page but consumes valuable space in a recurring operations surface.
- Repeating identical publication and availability language on every card reduces the visual salience of exceptions.
- Fifteen items remain scannable, but the current design has no path to scale or to answer common questions such as “which situation is checked out?” or “find the item about one-on-ones.”

Recommended change:

- Preserve the editorial brand but compact the recurring inventory header after the product identity is established.
- Add client-side search across title, slug, topic tags, and primary skill already available in the inventory payload.
- Add quick filters for “Needs attention,” lifecycle/publication state, and checkout availability. “Needs attention” includes blocked validation, pending review/publication, active checkout, or another state requiring an operator decision.
- Default to “Needs attention first, then alphabetical by title.” Preserve a simple alphabetical sort option. Avoid building a generalized query system in this pass.
- Make the exceptional state visually dominant: checked out, archived, draft/proposal present, validation blocked, or publication pending. Reduce repeated prose for the common published/available case.
- Preserve a clear New Situation action and the total/checked-out counts.
- Provide a useful zero-results state with a one-click filter reset.

### P2 — Jobs and Capacity explain state but not the operator’s next move

Observed evidence at 1440×900:

- Jobs displayed a 1,339×231 px empty panel stating “No review jobs yet.”
- Capacity displayed a 1,339×117 px panel stating that no provider account is configured and deterministic CI reviews remain available only in fake mode.
- Neither page contained a link or button in the main content.
- Both pages otherwise fit within a single 900 px viewport.

Critique:

- The pages report absence but do not explain what creates a job, why provider capacity matters, who can change it, or which manual work remains available.
- “Deterministic CI reviews” and “fake mode” are implementation vocabulary. They are valuable in diagnostics but weak primary product copy.
- Large empty bordered panels make these pages feel unfinished even though the disabled provider state is intentional and safe.

Recommended change:

- Give each empty state three pieces of information: what the state means, why it is currently true, and the valid next action.
- Jobs should explain which workflow action creates a review job and link back to eligible situations. If the account cannot create one, say so explicitly.
- Capacity should lead with “AI review providers are disabled” and “Manual editing remains available.” Put adapter/fake-mode detail in a technical disclosure.
- Show a last-checked timestamp and the relevant configured/disabled capability names when that information is already available without exposing credentials.
- Do not add provider configuration controls in this pass.

### P2 — Cross-page orientation and copy consistency need refinement

Observed evidence:

- Primary navigation had no visual or semantic current-page state.
- Workspace pages had no breadcrumb or explicit link back to the inventory near the title.
- The interface mixes audience-facing language (“One rule. Every learning surface.”), workflow language (“proposal,” “blast radius”), repository language (paths and slugs), and test-environment language (“fake mode”) at the same visual level.

Recommended change:

- Establish a copy hierarchy:
  - Primary: operator intent and current state.
  - Secondary: workflow terminology with concise explanations.
  - Technical detail: repository paths, identifiers, adapter modes, hashes, and diagnostics.
- Add an inventory breadcrumb/back link on new and existing situation pages.
- Preserve exact identifiers where operationally necessary, but do not make them the primary label when a human-readable title exists.

## Scope — this pass only

- Improve the authenticated desktop experience at 1280×800 and 1440×900.
- Apply permissions-aware primary navigation using the existing authorization policy.
- Add visual and semantic current-route navigation state.
- Improve the Situations inventory hierarchy, search, minimal filtering, and exceptional-state scanning.
- Reorganize the existing new-situation controls without changing the immutable brief schema or which fields are required.
- Add persistent field guidance, client-side validation summary, and title-derived editable slug behavior.
- Improve the published workspace reading experience, lifecycle explanation, dependency organization, and danger-area validation.
- Improve Jobs and Capacity empty-state language and provide valid next-step navigation.
- Preserve and extend automated desktop browser coverage for every affected page type.
- Update relevant documentation and acceptance evidence if implementation is later approved and deployed.

## Out of scope / do NOT touch

- Do not implement anything until the user approves or revises this spec.
- Do not edit, create, check out, archive, restore, approve, publish, or roll back any live situation during this spec/review pass.
- Do not audit or redesign Administration in this pass; the invited account cannot access it and the user explicitly said not to pursue access now.
- Do not implement mobile or narrow-screen changes in this pass. Mobile observations from the exploratory audit are intentionally excluded from acceptance criteria.
- Do not change the separate TimsPrototypes gate UI or authentication system.
- Do not change Studio activation, password, login, session, CSRF, throttling, Origin/Host, or cookie behavior.
- Do not change RBAC rules, add roles, or broaden permissions. Only make navigation reflect the authorization policy that already exists.
- Do not change Prisma schema, database migrations, workflow state machines, checkout exclusivity, audit history, validation contracts, or publication saga.
- Do not provision providers, credentials, service identities, publisher keys, backups, or network/firewall changes.
- Do not change exact published Leadership artifact bytes or the imported baseline.
- Do not build a generalized design system, replace the visual identity, or rewrite unrelated components.
- Do not add production partial-draft persistence for the new-situation form in this pass.

## Constraints

- The Leadership Git repository remains the authority for published artifact bytes; UI changes must not rewrite or normalize baseline content.
- PostgreSQL workflow invariants and append-only audit behavior must remain intact.
- Existing provider execution remains fail-closed.
- Navigation authorization must be server-derived or use the same shared authorization policy as the protected route. Never rely on a client-only role check as the security boundary.
- The existing 19-field immutable-brief contract and human-confirmation requirement remain unchanged unless separately approved.
- The existing two-related-situation requirement remains unchanged in this pass.
- Exact source must remain inspectable. A rendered preview supplements, not replaces, the exact MDX view.
- No operational body text or source editor should render below 14 px at the target desktop sizes.
- At both target viewports, affected pages must have no document-level horizontal scrollbar and all primary actions must remain visible without horizontal scrolling.
- Preserve keyboard operation, visible focus, the skip link, semantic headings/landmarks, explicit labels, and status text that does not rely on color alone.
- Preserve the current color palette and editorial type character unless a measured readability issue requires a targeted adjustment.
- Keep changes compartmentalized by page type; do not combine UI work with provider, publication, or infrastructure work.
- Use synthetic/local fixture data for mutating verification. The production audit remains read-only.
- Never place activation links, passwords, provider credentials, or other secrets in source, test snapshots, logs, screenshots, specifications, or commits.

## Success criteria (testable)

### Global navigation and desktop containment

- [ ] At 1280×800 and 1440×900, the global header exposes all navigation, account, and sign-out controls without horizontal scrolling or overlap.
- [ ] The active primary destination has a visually distinct state and `aria-current="page"`.
- [ ] A non-administrator session does not receive an actionable Administration navigation link.
- [ ] Direct unauthorized access remains server-protected and returns/communicates the existing safe authorization outcome; UI changes do not weaken RBAC.
- [ ] Every affected page has `document.documentElement.scrollWidth <= clientWidth` at both target viewports.

### Situations inventory

- [ ] The 15 imported situations remain present with unchanged slugs, titles, lifecycle states, and checkout states.
- [ ] Search matches title, slug, topic tag, and primary skill and updates the visible result count without a server mutation.
- [ ] “Needs attention,” lifecycle/publication, and checkout filters can be combined and reset.
- [ ] Default ordering places situations needing operator attention first and then sorts alphabetically by title; a simple alphabetical sort remains available.
- [ ] A zero-result state states that no situations match and offers a single reset action.
- [ ] Checked-out, archived, blocked, draft/proposal, or pending states are more visually salient than the common published/available state.
- [ ] New Situation remains visible and keyboard reachable without opening a card.

### New-situation brief

- [ ] All 19 existing controls and their current required/confirmation semantics remain present.
- [ ] Controls are grouped into four labeled semantic regions covering identity/connections, situation understanding, safety/learning, and guidance boundaries/surfaces.
- [ ] Every control has persistent instructional or constraint text where instruction is needed; placeholders are examples, not the sole guidance.
- [ ] The title produces a stable slug preview, the slug remains editable, and uniqueness is checked before any create request.
- [ ] Submitting an incomplete brief causes no network mutation and shows an accessible error summary linked to invalid controls.
- [ ] Focus moves to the first invalid control, invalid controls expose `aria-invalid`, and previously entered values remain intact.
- [ ] The form exposes section-level completion without persisting partial sensitive content to production.
- [ ] Human confirmation remains required immediately before the immutable brief/draft creation request.

### Situation workspace

- [ ] All 15 imported situation artifacts remain read-only until a valid exclusive checkout is obtained.
- [ ] A published workspace defaults to a human-readable rendered view while retaining an exact Source MDX view.
- [ ] The Source MDX view uses a font size of at least 14 px and provides an expand/full-screen inspection mode.
- [ ] No title exceeds two display lines at either target viewport for the 15 imported titles.
- [ ] The page distinguishes published baseline state from current draft/proposal/validation state in plain language.
- [ ] Situation-to-situation dependencies are keyboard-accessible links to existing workspaces.
- [ ] Non-navigable paths/identifiers remain visible or copyable but are not presented as inert pseudo-links.
- [ ] Blast-radius count remains visible even when detailed dependencies are collapsed.
- [ ] Read-only state copy does not claim that an inactive editor is “All saved.”
- [ ] Archive controls are visually separated, require a nonblank reason in the client and server contract, expose inline errors, and require explicit confirmation before mutation.

### Jobs and Capacity

- [ ] Jobs empty state explains what creates a job and includes a valid link to the next eligible surface.
- [ ] Capacity leads with provider availability and the fact that manual editing remains available.
- [ ] Technical adapter/fake-mode detail is available but visually secondary.
- [ ] Neither empty state exposes a control the current account cannot use.
- [ ] Both pages remain complete within one 900 px-tall viewport when empty.

### Accessibility, regression, and safety

- [ ] Keyboard-only navigation reaches global navigation, filters, cards, form controls, view switches, dependency links, and primary actions in a logical order.
- [ ] Visible focus is not clipped by cards, panels, or sticky elements.
- [ ] Automated accessibility checks report no critical or serious violations on Home, New Situation, one representative workspace, Jobs, and Capacity.
- [ ] Browser console warnings/errors remain zero during the automated desktop walkthrough.
- [ ] Existing checkout race, immutable baseline, append-only audit, validation, approval, publication, archive/restore, and security contract tests continue to pass.
- [ ] No live situation or Leadership artifact byte changes during UI verification.

## Verification plan

1. **Static and contract gate**
   - Run `pnpm verify`.
   - Confirm formatting, lint, strict TypeScript, Prisma validation, baseline verification, secret scan, production build, and existing contract/unit tests pass.
   - Compare results with `artifacts/reports/acceptance.json`.

2. **Desktop browser matrix**
   - Extend browser coverage at 1280×800 and 1440×900.
   - Cover Home, Jobs empty state, Capacity disabled state, New Situation empty/invalid state, and representative short/long-title workspaces.
   - Include the longest imported situation title and the largest imported MDX artifact.
   - Assert document containment, header containment, active navigation state, permission-aware Administration visibility, and zero console errors.

3. **Inventory behavior**
   - Verify search by exact title fragment and slug fragment.
   - Verify each filter alone, a combined filter, a zero-result state, and reset.
   - Assert the original 15 situations and exact identifiers remain unchanged.

4. **Creation form behavior in a non-production fixture environment**
   - Assert semantic section names and control/help associations.
   - Attempt empty submission and verify no request is issued.
   - Verify error summary, focus management, `aria-invalid`, and value preservation.
   - Verify slug generation, manual override, invalid characters, and duplicate detection.
   - Stop before the create mutation unless a disposable test database and explicit fixture cleanup are in place.

5. **Workspace behavior**
   - Verify all 15 baseline editors are read-only without checkout.
   - Verify rendered/source switching, exact source preservation, expanded-source mode, and title wrapping at both viewports.
   - Verify real situation dependencies navigate correctly.
   - Verify baseline/draft/proposal/validation copy for published-with-no-draft and fixture states with an active proposal.
   - Test archive reason and confirmation only against a disposable fixture situation; never against a baseline situation.

6. **Manual production-build review**
   - Use a production build and a non-administrator fixture session.
   - Review hierarchy, typography, density, copy, focus treatment, and destructive-action separation.
   - Capture representative desktop screenshots for user review before deployment.

7. **Independent review**
   - Before trusting the result, have a second reviewer check the spec criteria against the production-build screenshots and browser-test report.
   - The resolved product decisions below are the default adjudication. Escalate only if implementation evidence exposes a safety conflict, technical invariant, or materially different tradeoff.

## Checkpoints

### Checkpoint 0 — approve the spec

- Stop now and show this file to the user.
- The user delegated the five previously open UX choices to the product recommendation recorded in “Resolved product decisions.”
- Review the complete scope, acceptance criteria, and checkpoint boundaries; only contradictions or materially new constraints need another decision interview.
- Do not implement until the user explicitly approves a revised or unchanged spec.

### Checkpoint 1 — orientation and low-risk empty states

- Implement permissions-aware/current navigation and inventory breadcrumbs.
- Improve Jobs and Capacity empty-state hierarchy and copy.
- Add/adjust desktop containment and accessibility tests.
- Stop and show 1280×800 and 1440×900 screenshots plus test results.

### Checkpoint 2 — creation brief

- Implement semantic grouping, persistent help, progress summary, slug behavior, and accessible validation.
- Preserve the exact brief schema and mutation boundary.
- Stop and demonstrate empty, partially complete, invalid, and ready-to-confirm states without creating a production situation.

### Checkpoint 3 — published workspace

- Implement rendered/source views, desktop typography/density improvements, lifecycle explanation, dependency navigation, and danger-area validation.
- Prove exact source preservation and read-only behavior across all 15 baseline situations.
- Stop and show short-title, long-title, small-artifact, and large-artifact screenshots and test results.

### Checkpoint 4 — inventory efficiency and final regression

- Implement search, minimal filtering, exceptional-state emphasis, and zero-results recovery.
- Run the complete verification plan.
- Stop with the final acceptance report before any deployment.

### Checkpoint 5 — deployment, only after separate approval

- Deploy only committed, verified state through the immutable release process.
- Preserve the last healthy symlink target for rollback.
- Re-run the authenticated desktop walkthrough on the live route.
- Update `HANDOFF.md`, relevant runbooks/README, and `artifacts/reports/acceptance.json` if deployment state changes.

## Future ideas — captured but not committed to this pass

- A visual blast-radius graph that can pivot between source, route, practice, situation, validator, preparation prompt, quiz, and workshop consumers.
- A rendered/source/diff workspace with synchronized section navigation.
- Recent situations, saved filters, and favorites for frequent operators.
- A role-aware home dashboard showing “needs my action,” active checkouts, blocked validation, and pending publication.
- Review-job filters, duration estimates, progress history, and optional completion notifications.
- Situation templates that pre-fill question guidance without weakening human confirmation.
- Keyboard shortcuts or a command palette for inventory search and workspace switching.
- A safe local/session-only draft recovery mechanism for the long creation brief, designed explicitly around the sensitive-data boundary.
- A structured content editor that preserves exact MDX serialization and supports the approved Leadership content schema.
- An Administration audit and improvement spec after an authorized test account becomes available.
- A separate mobile/responsive pass if mobile operation becomes a product requirement.

## Resolved product decisions

The user explicitly delegated these choices to the product recommendation. They are now constraints for this candidate spec, not open questions.

### Published workspace defaults to rendered guidance

- Open a published situation in a readable rendered-guidance view.
- Keep a compact state-and-action summary visible above the content so the operator immediately understands publication state, checkout availability, and the next valid action.
- Make exact Source MDX a clearly labeled secondary view with expansion support.
- Rationale: the operator’s first job is to understand and judge the guidance; source inspection is essential but secondary until editing or byte-level verification is needed.

### Unavailable Administration is omitted from navigation

- Do not show Administration to a user who cannot access it.
- Preserve server-side route protection as the actual security boundary.
- Rationale: primary navigation represents available destinations. A disabled item or silent redirect creates uncertainty without helping the operator complete a task.

### Creation remains one structured, reviewable page

- Use the four plain-language sections “Name and connect,” “Understand the situation,” “Set safety and learning guardrails,” and “Define the guidance.”
- Provide sticky section progress and allow completed sections to collapse, but do not force a linear wizard.
- Rationale: the brief requires deliberate cross-checking among context, uncertainty, safety, learning, and guidance boundaries. A hard wizard hides relevant context; an undifferentiated form overwhelms it.

### Inventory prioritizes finding work and finding what needs attention

- Search title, slug, topic tags, and primary skill.
- Provide quick filters for Needs attention, lifecycle/publication state, and checkout availability.
- Sort by Needs attention first and then alphabetically by title, with a simple alphabetical alternative.
- Rationale: the recurring operator questions are “where is the situation?” and “what needs a decision?” Saved filters and generalized querying are premature for a 15-item inventory.

### Operational screens become denser without losing the brand

- Reduce recurring operations-page titles to a responsive 48–64 px range and require imported workspace titles to fit within two lines at the target viewports.
- Preserve the serif display face, cream/green palette, compact uppercase labels, warm state colors, and generous separation between major regions.
- Reserve the largest editorial treatment for authentication or true introductory surfaces, not frequently revisited inventory and workspace pages.
- Rationale: brand character should help orientation and trust, while recurring operational work needs more state and content above the fold.

## Working rules

- Verify before acting: surface and confirm any key decision or assumption first.
- Do not assume—ask. Do not hide confusion—surface it.
- Make the smallest change that works; do not over-engineer or rewrite unasked.
- Preserve unrelated user changes in the worktree.
- Keep implementation checkpoints small and reviewable; do not bundle all page types into one unreviewed change.
- Use production-like builds and real browser rendering for layout decisions.
- Treat content mutation, provider execution, publication authority, deployment, backup, database roles, and network changes as separate security boundaries.
- Never use a human credential or web runtime identity as a substitute for a missing service identity.
- Stop immediately if a UI change would require altering published artifact bytes, expanding RBAC, weakening validation, or changing a workflow invariant without separate approval.
