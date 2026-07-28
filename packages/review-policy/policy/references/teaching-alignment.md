# Teaching alignment

Use this phase to turn an adjudicated management strategy into an aligned lesson, public situation, practice, and preparation surface. Keep instructional design downstream of substantive adjudication and upstream of human approval. Read and apply [plain-global-english.md](plain-global-english.md) to every reader-facing artifact.

## Adaptation source and boundary

This workflow adapts instructional-design principles from [Matt Pocock's `teach` skill](https://github.com/mattpocock/skills/blob/main/skills/productivity/teach/SKILL.md), distributed in an [MIT-licensed repository](https://github.com/mattpocock/skills/blob/main/LICENSE).

Adapt the principles, not the artifact layout. Pocock's skill assumes a stateful teaching workspace with HTML lessons, mission files, learning records, and reusable HTML assets. The Leadership Field Guide already has a Markdown workshop curriculum, JSON practices, MDX situations, source records, and application components. Follow the repository's architecture.

Do not invoke or impersonate Matt Pocock. Describe this as a teach-informed instructional-design pass.

## Phase placement

Run teaching alignment:

1. after the framework critics, rebuttal round, and adjudicator settle the managerial handling;
2. before semantic, teaching, and repository audits;
3. before the human sees and approves the candidate bundle;
4. before any lesson, practice, prompt, or situation file is changed.

Running it earlier lets pedagogical convenience distort unresolved substance. Running it after application creates drift among artifacts carrying the same idea.

## Build the learning brief

Derive, do not invent:

- **Mission:** the real management outcome this material helps the audience achieve.
- **Audience:** role, likely experience, language and accessibility needs, and constraints from repository context.
- **Prior knowledge:** relevant preceding sessions and practices.
- **Zone of challenge:** what is just beyond the audience's current demonstrated skill.
- **One tangible win:** one action or decision the learner can perform after the lesson.
- **Evidence of learning:** an observable response, choice, or real-work experiment.
- **Source basis:** owned notes and high-trust primary sources supporting the knowledge.
- **Misconceptions:** plausible errors the practice should expose without caricature.

Keep the learning objective behavioral. Avoid objectives such as “understand NVC.” Prefer an observable distinction such as “classify a manager's next statement as a request, role expectation, boundary, or disguised demand, then rewrite it honestly.”

Before designing the artifact set, define one core message, the three things the reader must remember, at most three new reader-facing concepts, the shortest useful reading path, and content to remove. An accepted substantive decision does not automatically require public explanation. Keep framework and editorial terms internal when sequence, wording, or a prompt can carry the decision.

## Balance knowledge, skill, and wisdom

- **Knowledge:** teach only the concepts required for the target behavior. Make acquisition easy and cite high-trust sources.
- **Skill:** require retrieval or transfer in a realistic scenario and provide immediate explanatory feedback.
- **Wisdom:** end with a bounded real-work experiment, reflection, or discussion that recognizes context cannot be reduced to a quiz.

Distinguish momentary fluency from durable learning. Use retrieval practice, spacing across sessions, and interleaving of related distinctions when the course trajectory supports them. Do not add complexity merely to appear rigorous.

## Create or update the lesson plan

Treat the owned workshop lesson as the canonical teaching source for the aligned bundle.

1. Map the adjudicated strategy to the syllabus session that owns the concept.
2. Update an existing detailed lesson when it already owns that concept.
3. If the syllabus has an outline but no detailed lesson, create the correctly numbered Markdown lesson only when the change materially affects the curriculum.
4. Read the current lesson-plan generator, syllabus, prior lesson, and next-session outline before drafting.
5. Preserve the repository's current duration, small-group format, headings, facilitator detail, activity cadence, and source rules.
6. Give the lesson one coherent arc: retrieval of prior learning, minimal new knowledge, modeled distinction, guided whole-group practice, independent or real-work transfer, feedback/debrief, and next experiment.
7. Keep time allocations honest and total them.
8. Use source-backed claims and original examples. Do not turn the plan into a book summary or reproduce a proprietary script.

If the adjudication does not change what the course should teach, record a no-change lesson decision with a reason instead of manufacturing edits.

An earlier gap in the detailed-lesson sequence does not by itself justify leaving the owning lesson missing. When the syllabus clearly assigns the concept to a later session, create that numbered lesson if the candidate materially needs it. Use the syllabus outline and the latest available detailed lesson to bound assumed prior knowledge, identify the missing prerequisite lesson as a sequencing risk, and do not create unrelated gap lessons without separate scope and review.

## Design the quiz or practice

The practice is an instructional feedback loop, not a trivia test or a disguised compliance check.

- Map each round to one learning objective and one decision.
- Test transfer in a workplace scenario rather than recall of an author's terminology.
- Make distractors plausible expressions of real misconceptions found in the review.
- Keep choices grammatically parallel and comparable in word and character length where practical.
- Never reveal a preferred branch through greater detail, polished tone, unique formatting, or obviously harsh distractors.
- Do not sacrifice natural language or semantic precision merely to equalize character counts.
- Use plain global English in setups, choices, consequences, explanations, buttons, and instructions. Do not make framework vocabulary a prerequisite for a useful choice.
- Give immediate feedback that names the likely consequence and explains the distinction.
- Allow more than one useful branch when context genuinely supports it; do not force a false single answer.
- Keep setup facts sufficient to decide. If a crucial fact is unknown, make uncertainty part of the choice.
- Ensure compact embeds teach through the first round because the current UI may hide later rounds.
- Ensure the full standalone sequence adds transfer, changed conditions, spacing, or interleaving rather than repeating the first item.
- Use a real-work follow-through or reflection to bridge from skill to wisdom.

## Protect shared learning surfaces

Before changing a practice, enumerate every situation, guide, home page, standalone route, and test that consumes it.

Change shared practice content only when the new learning objective is valid for every consumer. If a situation needs distinct questions, do not rely on a `variant` value unless runtime code actually selects variant-specific content. Propose the necessary data, schema, rendering, navigation, and test changes or retain a shared general practice.

Likewise, change a preparation-tool prompt only when the revised wording improves every scenario using that tool. Keep a no-change record when the concept does not generalize.

## Audit the bundle

The candidate bundle must tell one consistent story:

- the lesson explicitly teaches the distinction;
- the situation applies it without theory dumping;
- the practice requires the learner to use it;
- the feedback explains consequences without moral judgment;
- the preparation tool prompts the same honest classification;
- terminology, source claims, safety boundaries, and authority remain consistent;
- the first useful action is visible within 30 seconds, and the reader can summarize the guidance in three plain sentences;
- no more than three new reader-facing concepts compete for attention;
- headings, examples, practice, feedback, forms, controls, and mobile summaries use literal, globally understandable language;
- every changed shared artifact has an enumerated consumer impact.

Reject bundles in which the public answer is changed but the lesson teaches the old rule, the quiz rewards formula recognition, or a shared practice is silently specialized for one situation.

For approval, provide a unified diff for an existing lesson and full Markdown for a new lesson. A title, agenda, or teaching blueprint alone is not an exact lesson candidate.
