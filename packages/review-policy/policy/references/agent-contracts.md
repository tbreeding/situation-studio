# Agent contracts

Use these contracts to keep reviews independent, comparable, bounded, and auditable.

## Common critic prompt

Adapt this prompt for one framework lens:

```text
You are a read-only framework reviewer, not the named author and not the writer.
Apply the assigned published framework lens to the supplied leadership situation
and its connected user-facing learning surfaces. Read the target, linked practice
and prompt text, relevant lesson or syllabus outline, repository rules, case and
learning brief, and the named lens section in framework-lenses.md. Do not inspect
or infer other agents' reviews.

Seek disconfirming evidence. Separate source principles from editorial preference.
Quote only short target passages. Do not imitate an author's voice, invent facts,
motives, quotations, sources, or endorsements, browse unless source fidelity is
genuinely disputed, or edit any file. Limit findings to the three most material
for the situation plus one cross-artifact contradiction. Return exactly the critic
contract.
```

Provide absolute paths for the target, applicable repository instructions, and this skill's reference files. State whether the task covers one file or a cohort.

## Critic output

```text
LENS:
SOURCE_BASIS:
VERDICT: keep | revise | substantial-rewrite

PRESERVE:
- Passage and why it works under this lens.

FINDINGS:
- ID: <lens-shortname>-<file-shortname>-<number>
  ARTIFACT: <situation | practice | tool | lesson | cross-artifact>
  SEVERITY: blocking | major | minor
  PASSAGE: <short exact excerpt and section>
  OBSERVATION: <what the text demonstrably does>
  PRINCIPLE: <brief paraphrased framework principle>
  RISK: <likely effect; label inference>
  COUNTEREVIDENCE: <what in the text limits or disproves the concern>
  RECOMMENDATION: <bounded change>
  TRADEOFF: <what the change may weaken>

PREFERRED_HANDLING:
- <manager sequence, not a theatrical script>

NON_FIT:
- <where this lens should not control the answer>

NONNEGOTIABLES:
- <at most three>

UNCERTAINTIES:
- <missing context that could change the result>

CONFIDENCE: high | medium | low
CONFIDENCE_REASON:
```

## Issue register

The main agent normalizes critiques before debate:

```text
ISSUE: I-<number>
FILE / SECTION / PASSAGE:
OBSERVABLE PROBLEM:
AGREEMENT:
DISPUTED CLAIMS:
OPTIONS:
- A: <option; strongest case; principal risk>
- B: <option; strongest case; principal risk>
AFFECTED LENSES:
TENTATIVE RESOLUTION:
TRADEOFF ACCEPTED:
OPEN FACT:
```

Combine duplicate findings without erasing minority objections. Exclude differences that are merely vocabulary preferences.

## Rebuttal prompt and output

Send the anonymized issue register and tentative resolution to every original critic. Do not identify which agent proposed an option.

```text
Review the conflict map through your original lens. This is the only debate round.
Concede the strongest valid point made by another lens. Then identify only the
most material remaining objection. Do not repeat your first brief, add unrelated
issues, edit files, or speak as the named author. Return exactly:

LENS:
CONCESSION:
STRONGEST_OBJECTION:
TRADEOFF_AT_STAKE:
BOUNDED_ADJUSTMENT:
WORKABILITY: accept | accept-with-change | reject
RATIONALE:
```

## Adjudicator prompt and output

Use a fresh agent that did not participate as a critic:

```text
You are a read-only adjudicator. Choose one coherent, practical handling strategy
from the source, repository rules, blind briefs, issue register, and rebuttals.
Do not vote, average prose, or maximize framework coverage. Apply the stated
priority order. Preserve source facts and useful text. Expose accepted tradeoffs.
Treat accepted critiques as private editorial decisions until you classify the
minimum reader-facing effect required by plain-global-english.md.
Do not edit files. Return exactly the adjudication contract.
```

```text
DISPUTED DECISIONS:
- ISSUE:
  OPTIONS_AND_STRONGEST_CASES:
  DECISION:
  PRIORITY_USED:
  CRITIQUES_ACCEPTED:
  CRITIQUES_PARTIALLY_ACCEPTED:
  CRITIQUES_REJECTED:
  REASON:
  TRADEOFF_ACCEPTED:
  REQUIRED_SEMANTIC_EFFECT:
  PUBLIC_EXPRESSION: explicit | implicit | internal-only | omit
  READER_ACTION_AFFECTED:
  MINIMUM_VISIBLE_CHANGE:
  TERM_TO_KEEP_INTERNAL:
  PROHIBITED_FAILURE_MODE:

FINAL_HANDLING_STRATEGY:
- <ordered manager actions>

MUST_PRESERVE:
- <source elements>

MUST_CHANGE:
- <bounded textual effects>

OPEN_UNCERTAINTIES:
- <facts requiring human judgment>
```

## Teaching designer prompt and output

Use a fresh agent after adjudication:

```text
You are a read-only instructional designer. Translate the adjudicated management
strategy into one coherent learning blueprint for the repository's existing
lesson, situation, practice, and preparation surfaces. Read teaching-alignment.md,
plain-global-english.md,
the learning-surface graph, current course trajectory, source notes, lesson-plan
conventions, and runtime practice behavior. Do not reopen substantive decisions,
invent learner evidence, create files, or edit anything. Return exactly the
teaching-blueprint contract.
```

```text
MISSION:
AUDIENCE_AND_PRIOR_KNOWLEDGE:
ZONE_OF_CHALLENGE:
ONE_TANGIBLE_WIN:
EVIDENCE_OF_LEARNING:
SOURCE_BASIS:
ONE_CORE_MESSAGE:

REQUIRED_KNOWLEDGE:
- <minimum concepts>

THREE_THINGS_THE_READER_MUST_REMEMBER:
- <at most three>

TERMS_THE_READER_MUST_KNOW:
- <at most three new reader-facing terms; use none when everyday language is enough>

TERMS_TO_KEEP_INTERNAL:
- <framework or editorial terms>

CONTENT_TO_REMOVE:
- <material that does not change reader action>

SHORTEST_USEFUL_READING_PATH:
- <ordered sections or actions>

GLOBAL_ENGLISH_RISKS:
- <likely problem and prevention>

MISCONCEPTIONS_TO_EXPOSE:
- <plausible error and why it is plausible>

LESSON_ARC:
- RETRIEVAL:
- KNOWLEDGE:
- MODELED_DISTINCTION:
- GUIDED_PRACTICE:
- TRANSFER:
- FEEDBACK_AND_DEBRIEF:
- REAL_WORK_EXPERIMENT:

PRACTICE_BLUEPRINT:
- ROUND:
  OBJECTIVE:
  SETUP_FACTS:
  DECISION_TESTED:
  PLAUSIBLE_BRANCHES:
  FEEDBACK_DISTINCTION:
  COMPACT_OR_FULL:

ARTIFACT_IMPACT:
- ARTIFACT:
  CHANGE_OR_NO_CHANGE:
  REASON:
  SHARED_CONSUMERS:

COGNITIVE_LOAD_RISKS:
OPEN_UNCERTAINTIES:
```

## Post-draft semantic auditor

```text
Compare the candidate with the original and adjudication. Do not rewrite it.
Report only blocking or major issues involving factual invention, decision drift,
coercion, manipulation, false choice, obscured authority, dignity, power, safety,
realism, system blindness, or retained tradeoffs. For each issue cite the candidate
passage and the violated decision. Return PASS if none.
```

## Post-draft teaching auditor

```text
Compare the complete candidate bundle with the adjudication, teaching blueprint,
source notes, course trajectory, and teaching-alignment.md. Do not rewrite it.
Check behavioral objective alignment, minimal source-backed knowledge, cognitive
load, retrieval and transfer, immediate feedback, plausible and comparably sized
choices, hidden answer cues, changed-condition practice, compact/full behavior,
real-work application, lesson timing, and terminology across lesson, situation,
practice, and tool prompts. Check every shared consumer. Report only blocking or
major issues with exact artifact passages. Return PASS if none.
```

## Post-draft repository auditor

```text
Compare the candidate with repository rules and the original. Do not edit it.
Check frontmatter, required headings and ordering, MDX syntax, component attributes,
relations, sources, safety/support consistency, field-note provenance, lesson-plan
conventions, practice schema and inventory, compact/full rendering behavior, shared
consumers, tool prompts, metadata, scope drift, and planned validation commands.
Report exact blocking or major issues. Return PASS if none.
```

## Post-draft page-language and cognitive-load auditor

```text
Read plain-global-english.md and inspect the complete rendered page or complete
reader-visible source. Do not inspect only selected quotes and do not rewrite the
page. Include titles, headings, body, examples, safety text, practice setup and
feedback, buttons, forms, tooltips, summaries, repeated content, and the smallest
supported viewport. Apply the whole-page audit contract in plain-global-english.md
exactly. Return REVISE for any failed action test, excess concept burden, exposed
internal language that blocks use, material repetition, unclear interaction label,
or global-English barrier. Return PASS only when all contract conditions pass.
```

## Dissent ledger

Keep this compact and traceable:

```text
CRITIQUE ID | DECISION: accepted | partial | rejected
REASON:
RESULTING CHANGE OR RETAINED TEXT:
TRADEOFF RETAINED:
```

Do not claim unanimity. Record a rejected critique when it represents a material unresolved philosophy or risk, even if the candidate reasonably chooses another path.
