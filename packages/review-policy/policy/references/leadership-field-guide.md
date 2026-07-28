# Leadership Field Guide repository contract

Use this reference for the Leadership Field Guide repository. Always read the repository's current files before acting; they override this summary.

## Governing files

- `docs/AUTHORING.md`: editorial promise, required order, voice, originality, safety, AI limits, and human review.
- `lib/schema.ts`: frontmatter types, enums, lengths, and publication status.
- `lib/content.ts`: content-graph and heading validation.
- `scripts/validate-content.ts`: fast content-validation entry point.
- `content/bibliography/sources.json`: permitted source records.
- `content/practices/*.json`: actual practice setups, prompts, choices, consequences, and explanations.
- `components/practice-engine.tsx` and `components/practice-embed.tsx`: compact/full and variant runtime behavior.
- `lib/tools.ts`: user-facing preparation prompts and placeholders.
- `sourceMaterial/leadership-workshops-master/000_Syllabus.md`: course trajectory and session ownership.
- `sourceMaterial/leadership-workshops-master/lesson-plans/*.md`: detailed owned workshop lessons.
- `sourceMaterial/leadership-workshops-master/misc/prompt-lesson-plan-generator.md`: current lesson-plan conventions.

Do not infer authority from a stale summary or specification when the operational authoring guide and code agree otherwise. Flag genuine conflicts.

## Required situation structure

Preserve these H2 headings once each and in this order unless current repository rules say otherwise:

1. `The short answer`
2. `When this guidance fits`
3. `1 — See`
4. `2 — Choose`
5. `3 — Say`
6. `If they respond with…`
7. `4 — Sustain`
8. `Two-minute practice`
9. `I have my next move`
10. `Field note`
11. `Sources and next moves`

Preserve the safety/escalation block, three response branches, `PracticeEmbed`, and `PreparedAction` unless the current authoring contract explicitly changes them.

Mechanically verify details the current validator may not reconcile:

- filename basename equals frontmatter `slug`;
- `PracticeEmbed.practiceId` equals frontmatter `practiceId`;
- `PracticeEmbed.variant` equals frontmatter `practiceVariant`;
- `PreparedAction.scenario` equals `slug`;
- `PreparedAction.skill` equals `primarySkill`;
- source, author, practice, and related situation IDs exist;
- the safety block is present and agrees with frontmatter `support` in substance;
- the field note remains grounded in owned, real, anonymized material;
- headings occur once and response branches remain coherent.

## Learning-surface graph

Treat a situation as one node in a connected instructional system:

```text
situation MDX
  -> frontmatter practiceId / practiceVariant
  -> PracticeEmbed
  -> shared content/practices/<practiceId>.json
  -> compact situation experience and full standalone practice
  -> sourceReferences
  -> syllabus session and detailed lesson plan
  -> related user-facing preparation prompts in lib/tools.ts
```

Classify each connection as a verified runtime consumer, a shared conceptual surface, or no verified connection, and retain the code or content evidence. `PreparedAction` metadata does not prove that a situation selects a particular `lib/tools.ts` prompt; verify the actual runtime path before treating a tool as coupled.

Enumerate every consumer before changing shared practice data. The same practice may appear in multiple situations, guides, home-page surfaces, standalone routes, device state, navigation labels, and tests.

Current runtime details must be reverified rather than assumed:

- `practiceId` selects the JSON practice.
- `variant` may be analytics/context only; it does not select different questions unless runtime code explicitly implements that behavior.
- compact embeds may render only the first round.
- full practice routes render every round.
- practice IDs and inventory may be closed enums and exact-count test assumptions.

Do not specialize a shared practice for one situation unless the new content remains valid for all consumers. If distinct questions are required, propose the complete data-model, schema, rendering, navigation, and test change rather than pretending an existing variant already supports it.

## Lesson-plan alignment

Use the owned workshop repository as the canonical teaching source. Map the adjudicated distinction to the syllabus session that owns it. Update an existing detailed lesson or create the correctly numbered missing lesson when the course materially needs the new teaching.

Before drafting, read the current lesson-plan generator, prior lesson, syllabus entry, and next-session outline. Preserve current conventions, including:

- Markdown rather than a new HTML teaching workspace;
- lesson metadata and behavioral objectives;
- an agenda whose timing totals the stated duration;
- whole-group facilitation appropriate to the small class;
- an interactive component at least every 10–15 minutes;
- prior-learning retrieval, concrete workplace scenarios, facilitator notes, application, reflection, key takeaways, and concise sources;
- original wording and examples rather than copied framework scripts.

Create the lesson candidate before finalizing downstream public guidance and practice candidates, then present all connected changes as one approval bundle.

If the syllabus-owning lesson is missing and an earlier detailed lesson is also missing, do not fill the entire numerical gap automatically. Create the owning numbered lesson when the change materially requires it, ground prior-learning references in the syllabus and latest available detailed lesson, and flag the missing prerequisite lesson as a sequencing risk.

## Practice and quiz quality

- Map every round to a behavioral learning objective.
- Ensure the compact first round teaches the situation-relevant distinction.
- Use later rounds for changed conditions, transfer, spacing, or interleaving.
- Keep choices plausible, grammatically parallel, and comparable in length without sacrificing naturalness.
- Do not expose a preferred branch through formatting, verbosity, or caricature.
- Keep consequence and explanation distinct: what the choice makes likely, then why.
- Preserve the product's branch-exploration model; a `toward` signal is not necessarily a universal “correct answer.”
- Verify practice schema, IDs, choice count, round count, signals, device state, navigation, and tests.

## Voice and substantive constraints

- Lead with the next useful move.
- Use plain international English with U.S. spelling. Write for managers who may use English as an additional language.
- Prefer familiar, concrete words, short paragraphs, literal headings, one main idea per sentence, and stable terms. Avoid unexplained jargon, idioms, culture-specific metaphors, stacked nouns, and abstract labels.
- Prefer observable behavior, context, impact, and an honestly classified next step over personality labels.
- Provide one adaptable opener that sounds natural when read aloud, not a theatrical script or policy statement.
- Make uncertainty and decision rights visible.
- Connect follow-through to owners, timing, and observable evidence.
- Do not promise performance, conflict, retention, or employment outcomes.
- Keep guidance jurisdiction-neutral and route protected, legal, HR, safety, security, safeguarding, clinical, emergency, or senior-leader matters appropriately.

Apply [plain-global-english.md](plain-global-english.md) as a publication gate. Set one core message, three things to remember, at most three new reader-facing concepts, and the shortest useful reading path. Keep framework and editorial distinctions internal unless naming one changes what the reader must do. Audit the complete rendered page, including controls, practice feedback, forms, repeated summaries, and mobile behavior.

An occurrence of `need` is not automatically wrong. Inspect its semantic role. Universal human needs, ordinary business needs, and neutral prose may be legitimate. Flag a pattern such as `I need you to <action>` when it disguises a prescribed strategy, managerial expectation, or demand.

## Sources, originality, and field notes

- Use original structures, examples, exercises, and wording.
- Add a bibliography record before adding a source reference.
- Cite a book or research only when it supports a claim actually made.
- Do not reproduce an external framework, worksheet, diagram, branded script, book summary, or podcast wording as site inventory.
- Describe Manager Tools only as an influence or learning source, never an affiliation.
- Run a similarity spot check against cited sources and Manager Tools.
- Never invent or embellish a workshop anecdote, source, quotation, finding, legal conclusion, or individualized employment decision.

Framework lenses inform the private editorial process. Do not turn public situation pages into seven-framework summaries.

## Publication provenance and approval

Situation and guide files may carry `reviewStatus: human-approved`. AI and subagents may critique and draft lesson, practice, prompt, and public-content changes but may not approve publication.

Do not silently alter a public MDX file while leaving a stale human reviewer and review date. The safe workflow is:

1. produce the decision ledger, teaching blueprint, and exact cross-artifact candidate bundle without editing targets;
2. enumerate shared consumers and obtain explicit human approval of that exact bundle plus a confirmed reviewer identity;
3. apply the approved lesson, practice, prompt, and situation changes together;
4. update `lastReviewed` and `reviewer` on applicable published MDX from the human review;
5. keep `author` and `published` unchanged unless separately authorized;
6. validate before handoff.

If the human requests a material change after reviewing the bundle, present the revised affected bundle for approval before applying it. Do not apply a lesson first and repair the quiz later.

For exact review, present unified diffs for existing artifacts and full file content for new artifacts. Do not substitute a lesson outline for the full proposed Markdown lesson.

## Validation

Run proportionate checks from the repository root after approved situation-body-only changes:

```bash
pnpm content:validate
pnpm test -- tests/content.test.ts
pnpm build
```

Run the full suite when changes affect practice data, tool prompts, shared behavior, schema, lesson-linked relationships, or multiple content artifacts:

```bash
pnpm verify
```

Run browser tests when practice rendering, compact/full behavior, presentation, or interaction changed:

```bash
pnpm verify:browser
```

If title, social hook, or campaign metadata changes, inspect the promotion-generation workflow before deciding whether to run it. Do not modify promotion artifacts for body-only prose changes.

For practice-data changes, manually or automatically verify both a compact situation embed and the full standalone route, including feedback for every branch. Confirm the lesson timing and source links separately because application tests do not validate instructional quality.

Inspect repository status and every final targeted file after validation. If files are untracked, do not claim `git diff` proves the change; compare exact approved content and hashes instead.

Before presenting any candidate, run the whole-page audit contract in `plain-global-english.md` and a fresh-reader task test on raw artifacts. Ask what the manager should do first, what to ask, what to decide before the conversation ends, what to do before the next deadline, and which words were difficult. Do not reveal the intended answer.
