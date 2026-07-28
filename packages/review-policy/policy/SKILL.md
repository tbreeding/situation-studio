---
name: review-leadership-situations
description: Review, debate, teach, propose, and—after explicit human approval—apply improvements across leadership-situation MDX, linked quiz/practice JSON, user-facing preparation prompts, and workshop lesson plans. Use when Codex is asked to critique, rewrite, quality-audit, teach, or harmonize leadership guidance through framework-informed perspectives from Nonviolent Communication, Never Split the Difference, The Coaching Habit, Lencioni's team and organizational-health work, Radical Candor, Dan Heath's change and systems work, and Manager Tools. Spawn independent reviewers, adjudicate tradeoffs, create one teaching-aligned candidate bundle, protect publication provenance, and validate every affected learning surface.
---

# Review Leadership Situations

Use a fixed-round process: blind review, mediated debate, adjudication, teaching translation, single-writer candidate bundle, independent audit, human approval, and controlled application. Treat named thinkers as sources of published frameworks, never as simulated people.

## Load the operating references

Read [references/framework-lenses.md](references/framework-lenses.md), [references/agent-contracts.md](references/agent-contracts.md), [references/teaching-alignment.md](references/teaching-alignment.md), and [references/plain-global-english.md](references/plain-global-english.md) completely before spawning reviewers.

When the target is the Leadership Field Guide repository or contains `docs/AUTHORING.md`, also read [references/leadership-field-guide.md](references/leadership-field-guide.md) completely and then read the repository's current authoring guide, schema, validator, lesson-plan generator, syllabus, relevant lesson plans, practice data, rendering logic, tests, and source notes. Repository files are authoritative when they differ from the bundled summary.

## Establish mode and scope

Use one of these modes:

- `diagnostic`: test discovery, learning-surface mapping, orchestration, and phase contracts; do not make a substantive editorial decision, draft an approvable bundle, or edit.
- `audit`: report findings and decisions across the connected learning surfaces; do not draft or edit.
- `propose`: run the full process and return an exact candidate bundle for every affected learning surface; do not edit. Use this by default.
- `apply`: apply a previously shown bundle only after a human explicitly approves that exact bundle and identifies the human reviewer required by repository policy.

An initial request to “rewrite” authorizes creation of a candidate, not publication of unseen text under stale human approval. If no approved candidate exists in the conversation, complete `propose` first.

Process one situation at a time for the highest rigor, together with its linked practice, source lesson, and relevant preparation prompts. For larger sets, use cohorts of at most five situations, keep findings separated by artifact, and run a final cross-file consistency audit. Do not let batching turn passage-level review into generic book summaries.

## Preflight the target

1. Read applicable `AGENTS.md`, authoring rules, schemas, validators, target files, and source records.
2. Build the learning-surface graph: target situation; every consumer of its `practiceId`; the actual practice JSON; whether `variant` changes content or only context; possibly relevant preparation-tool prompts; `sourceReferences`; syllabus session; existing or missing detailed lesson plan; and affected tests. Label every edge `runtime consumer`, `shared conceptual surface`, or `no verified connection`, and cite the repository evidence. Do not infer that `PreparedAction` selects a prompt in `lib/tools.ts` without a code path proving it.
3. Inspect repository status. Preserve unrelated and pre-existing work.
4. Capture every in-scope artifact's full original content and SHA-256 before any approved edit. Do not rely on `git diff` when a file is untracked.
5. Record immutable facts, intended audience and work outcome, language and accessibility needs, learning objective, required structure, safety boundaries, source limitations, shared-content blast radius, and metadata that must remain unchanged. Unless repository evidence says otherwise, include managers who use English as an additional language and apply `plain-global-english.md`.
6. Classify the manager's actual mode: listening, feedback, coaching, negotiation, decision, role expectation, boundary, or formal process. More than one mode may appear, but do not disguise one as another.
7. Build a short case and learning brief from the source artifacts. Do not add inferred motives or facts.

In `diagnostic` mode, stop after exercising the requested discovery and phase contracts. Report what was and was not actually run, orchestration limitations, graph evidence, and no-write verification. A diagnostic result is never an audit decision or an approvable candidate.

## Run seven blind reviews

Confirm subagent tools are available. If they are unavailable, do not pretend a debate occurred; explain the limitation and ask whether to continue with a single-agent multi-pass review.

Spawn one read-only reviewer for each lens:

1. Nonviolent Communication and power/request clarity
2. Tactical empathy and negotiation
3. Coaching and curiosity
4. Team trust, conflict, commitment, accountability, and clarity
5. Care plus direct challenge
6. Systems, upstream prevention, and behavior change
7. Management operating cadence, behavioral feedback, and follow-through

Give every reviewer the same situation, linked user-facing practice and prompt text, relevant source lesson or syllabus outline, case and learning brief, common rubric, repository rules, and only its assigned lens. Do not reveal other reviews. Use the critic prompt and output contract in `agent-contracts.md`. Require evidence, counterevidence, non-fit, uncertainty, and no more than three material findings per situation plus one cross-artifact contradiction. Spawn with minimal inherited conversation context, such as `fork_turns: "none"`, and supply a compact, self-contained evidence packet plus absolute file paths.

Subagents must never edit target files. The main agent is the only writer.

Never exceed the currently available concurrency. Run as many critics in parallel as the live slot count permits; for example, when the runner owns one of four total slots, use waves of three, three, and one, while a delegated runner may need waves of two. Save each agent ID and exact response for the rebuttal round.

Wait in bounded intervals and keep the human informed. If a reviewer makes no progress across two consecutive bounded waits, request a compact completion; after one final bounded wait with no progress, interrupt it. Restart a failed role once only when capacity permits. If any required critic, rebuttal, adjudicator, teaching designer, or auditor remains missing, stop `audit` or `propose` mode and report the incomplete workflow. Never fill in a missing agent's perspective or present a partial run as an approvable bundle; offer `diagnostic` mode instead.

## Mediate one debate round

Normalize the blind briefs into an issue register:

- source passage and observable problem;
- agreements and disputed claims;
- viable options;
- strongest case and risk for each option;
- affected framework lenses;
- tentative resolution and explicit tradeoff.

Do not count votes. Send the anonymized issue register and tentative resolution back to all seven reviewers using `followup_task`, again within the concurrency limit. Require the rebuttal contract from `agent-contracts.md`: one concession, strongest remaining objection, tradeoff, bounded adjustment, and workability judgment.

Keep the debate to one rebuttal round unless the adjudicator identifies a specific safety or factual conflict that cannot be resolved from the source. Do not generate free-form author banter.

## Adjudicate the handling strategy

Spawn a fresh, read-only adjudicator. Give it the original target, repository rules, blind briefs, issue register, and rebuttals. Require the adjudication contract in `agent-contracts.md`.

Resolve conflicts in this order:

1. safety, legality, anti-discrimination, source fidelity, and factual accuracy;
2. observable evidence, fairness, and proportionality;
3. honest treatment of authority, choice, requirements, and consequences;
4. dignity, care, and meaningful voice;
5. team clarity, productive dissent, accountability, and collective results;
6. feasibility, system support, prevention, and follow-through;
7. natural, concise, speakable language.

The adjudicator must choose one coherent way to handle the situation, not concatenate all suggestions. Record accepted, partially accepted, and rejected critiques with reasons and retained tradeoffs. For every accepted decision, classify its public expression as `explicit`, `implicit`, `internal-only`, or `omit`; an accepted critique does not automatically earn a public heading, field, label, or component. Treat plain global English as a hard publication gate after the substantive decision is correct, not as a lower-priority optional improvement.

In `audit` mode, stop here and return the chosen handling strategy, learning-surface implications, dissent ledger, open uncertainties, and verification performed. Do not draft a candidate or edit a target.

## Translate the decision into teaching

Run this as the final content-design phase after adjudication but before approval. This placement prevents pedagogy from deciding unresolved management substance and prevents lesson, practice, and public guidance from drifting after publication.

Spawn a fresh, read-only teaching designer. Give it the adjudicated strategy, learning-surface graph, current course trajectory, trusted sources, audience, lesson-plan conventions, and [references/teaching-alignment.md](references/teaching-alignment.md). Require the teaching-blueprint contract in `agent-contracts.md`. The designer proposes alignment; it never edits files.

Require one core message, three things the reader must remember, at most three new reader-facing concepts, terms to keep internal, content to remove, the shortest useful reading path, and global-English risks. Express private framework reasoning through the smallest reader-facing change that affects action.

Have the main agent create one coherent candidate bundle in this conceptual order:

1. create or update the canonical owned lesson plan when the adjudication materially changes what the course should teach;
2. update the situation guidance from the same learning objective and source facts;
3. update or create the linked quiz/practice so it rehearses the adjudicated distinction with immediate explanatory feedback;
4. update relevant user-facing tool prompts when they encode the same concept;
5. record why any connected artifact does not need a change.

Use the repository's Markdown lesson-plan architecture. Do not create Matt Pocock teaching-workspace files or HTML lessons unless the repository independently adopts that architecture. Preserve useful content, document structure, metadata, component wiring, source integrity, and grounded field notes. Avoid framework name-dropping in public guidance unless a supported claim actually requires attribution.

Enforce these semantic gates:

- Separate observations from judgments and feelings from interpretations.
- Separate universal human needs from strategies involving a specific person.
- Label a request, role expectation, decision, boundary, or consequence honestly; do not hide a demand inside “I need you to,” a pseudo-choice, or a leading question.
- Use tactical empathy for understanding, not covert control.
- Coach only where meaningful choice exists; give direct feedback or direction where the manager owes clarity.
- Invite dissent without tolerating conduct that blocks safe work or an already-closed decision.
- Pair individual accountability with a genuine system, capacity, incentives, decision-rights, and upstream-cause check.
- Do not diagnose, invent motives, add legal conclusions, fabricate sources or anecdotes, or promise an outcome.
- Make dialogue adaptable and speakable, not a theatrical framework recital.
- Apply the concept budget and full-page rules in `plain-global-english.md` to every reader-facing title, heading, paragraph, example, safety note, practice, feedback message, control, form, tooltip, summary, and mobile view.
- Keep private editorial terminology out of public guidance unless the reader must use the term to make a decision.

For practices and quizzes:

- Map each round to a specific learning objective and observable decision.
- Prefer transfer and effortful retrieval over trivia or recognition of framework vocabulary.
- Make every choice plausible and comparable in length; do not reveal the preferred branch through formatting, specificity, or verbosity.
- Give immediate consequence-based feedback that explains the governing distinction.
- Ensure the first round works in compact embeds and the full sequence works on the standalone practice page.
- Treat shared practice changes as shared product changes. Review every consumer before changing them.
- Do not pretend `variant` selects different questions when runtime code uses it only as analytics/context.
- Do not add a new practice without updating schema, inventory assumptions, relationships, navigation, and tests.

Spawn four fresh read-only auditors within the available concurrency:

- a semantic auditor for decision fidelity, dignity, coercion, realism, and unintended tradeoffs;
- a teaching auditor for objective alignment, source quality, cognitive load, retrieval and transfer, feedback quality, choice cueing, course trajectory, and cross-artifact consistency;
- a repository auditor for frontmatter, MDX, links, component alignment, scope drift, source rules, and required validation.
- a page-language and cognitive-load auditor for first-action clarity, concept count, repetition, plain global English, interaction labels, and the essential mobile path.

Give the page-language auditor the complete rendered page or complete reader-visible source, not selected excerpts, and require the contract in `agent-contracts.md`. Correct every `REVISE` result and all other blocking findings. If a correction changes a material adjudicated decision, re-run the affected audit before presenting the candidate. For multiple files, also audit cross-file terminology, contradictions, duplicated scripts, and voice drift.

## Present, approve, and apply

In `propose` mode, return:

1. the chosen handling strategy;
2. a compact dissent ledger with accepted and rejected material critiques;
3. the learning objective and teaching blueprint;
4. the exact candidate patch or replacement text for the lesson plan, situation, practice data, and tool prompts, plus explicit no-change decisions;
5. shared-content impact, known uncertainties, and the validation plan;
6. a clear statement that no target file was edited and human approval is pending.

The bundle must contain exact, reviewable text. Use a unified diff for an existing artifact and a full content block for a new artifact. A new or substantially replaced 60-minute lesson may be long; do not collapse it into an outline and call it exact. Split the candidate into clearly labeled response sections when needed, while keeping all files under one approval decision.

Pause for explicit approval of the exact bundle. If the human requests a material revision, update and re-present the affected bundle before application.

In `apply` mode:

1. verify every target still matches its captured baseline or reconcile user changes without overwriting them;
2. apply only the approved bundle with `apply_patch`, keeping lesson, practice, prompt, and situation changes together;
3. update `lastReviewed` and `reviewer` only from confirmed human-review information; never claim an agent approved publication;
4. run the repository-specific checks in `leadership-field-guide.md` plus any checks required by current repository instructions;
5. inspect the final targeted changes and confirm every material edit maps to the decision ledger and teaching blueprint;
6. report changed files, shared consumers checked, validation results, remaining tradeoffs, and the human review identity/date recorded.

Do not commit, stage, push, publish, or modify unrelated files unless the user separately asks.
