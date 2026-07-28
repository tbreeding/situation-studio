# Plain global English and page-level usability

Use these rules for every reader-facing learning surface: titles, headings, body text, examples, safety notes, practice setup and feedback, buttons, forms, tooltips, summaries, and mobile views.

## Reader and outcome

Write for a busy manager who may use English as an additional language. Use plain international English with U.S. spelling. Aim for language commonly understood at approximately B1–B2 level, while keeping necessary management distinctions accurate.

Optimize for action, not for showing the editorial reasoning. A reader should be able to:

1. identify the first useful action within 30 seconds;
2. explain the page in three plain sentences;
3. prepare for the conversation without translating specialist terms;
4. know what to agree before the conversation ends;
5. know what to do before the next deadline or checkpoint.

Readability scores may help locate dense passages. They are diagnostic only and never replace human judgment or task testing.

## Separate private reasoning from public teaching

Framework reviews, issue registers, adjudication, and source distinctions are private editorial machinery. An accepted critique does not automatically deserve a public heading, concept, field, card, or sentence.

For every accepted decision, choose the smallest public expression that changes what the reader should notice, say, decide, or do:

- `explicit`: the reader must name or use the distinction;
- `implicit`: express it through sequence, wording, or a prompt without teaching the label;
- `internal-only`: use it to shape the draft, but do not expose it;
- `omit`: it is sound in theory but adds no material reader value here.

Prefer one clear sentence or one existing prompt over a new section. Do not display the full sophistication of the editorial process on the page.

## Set a concept budget

Before drafting, write:

- one core message;
- three things the reader must remember;
- no more than three new reader-facing concepts or labels;
- the shortest useful path through the page;
- the content that can be removed.

Treat three new concepts as a ceiling, not a target. Existing everyday ideas such as “date,” “support,” and “check-in” do not need branded labels. If a concept does not change a reader decision, keep it internal or remove it.

Each section must earn its place by doing at least one job:

- helping the reader recognize what is happening;
- helping the reader choose a next move;
- giving usable words;
- helping the reader prepare;
- helping the reader follow through;
- setting a necessary safety boundary.

Merge or remove sections that repeat another section’s job. Do not build separate models, maps, worksheets, practices, and pocket cards that all restate the same guidance.

## Write plain, literal language

- Use familiar, concrete words.
- Put one main idea in each sentence.
- Keep paragraphs short.
- Use literal headings that tell the reader what the section is for.
- Prefer verbs over abstract nouns: “agree on a new date,” not “complete commitment renegotiation.”
- Prefer people and actions over systems language: “ask who is waiting for the work,” not “identify the dependency owner.”
- Keep the same term for the same idea across the page.
- Explain a necessary technical term on first use. Do not rename an everyday idea to make it sound like a model.
- Avoid idioms, slang, wordplay, culture-specific metaphors, and phrasal shortcuts that depend on native fluency.
- Avoid long noun strings, stacked qualifiers, and abstract labels.
- Avoid rhetorical questions when a direct instruction is clearer.
- Use contractions in spoken examples when they sound natural.

Common internal-to-public translations:

| Keep internal | Prefer in public |
| --- | --- |
| decision space | what is fixed and what can change |
| bounded intervention | one small change |
| guardrail | what else we need to protect |
| dependency owner | the person waiting for the work |
| revisable constraint hypothesis | our best current explanation |
| record dissent | write down where you disagree |
| least-burdensome workable plan | the simplest plan that can work |
| authorized repair owner | who can fix the problem |

These are examples, not approved replacement jargon. Often the best choice is to remove the label and state the action.

## Make spoken language usable

A spoken example should sound like something a calm manager could say once, without reading from the page.

- Give one conversational move at a time.
- Use concrete facts the manager could verify.
- Ask one clear question, then allow room for an answer.
- Do not pack evidence, legal caution, empathy, decision rights, and a request into one speech.
- Use placeholders only where adaptation is necessary.
- Read every example aloud. Rewrite it if it sounds like policy text, a contract, a framework recital, or a courtroom question.

Example:

> We agreed on June 4 and June 11. The work wasn’t finished by those dates, and we didn’t agree on new dates. Is that how you remember it?

Do not inflate this into language such as “dates in my record,” “materially incomplete,” or “before we draw conclusions” unless that precision is required by the real context.

## Apply the rules to interaction design

- Make buttons describe the next action: “Build my plan,” not “Operationalize.”
- Ask only for information the reader will use.
- Keep form labels concrete and provide short examples.
- Make practice instructions shorter than the decision being practiced.
- Make feedback explain the likely effect and next move in plain language.
- Do not require readers to learn framework vocabulary to choose a useful response.
- Ensure the essential path is complete on mobile. Do not hide a required step behind a secondary tab, hover state, or later practice round.
- Use visual emphasis to show sequence and priority, not to create more categories.

## Whole-page audit contract

Audit the complete rendered page, not selected quotations. Include navigation labels, headings, examples, safety text, practice, feedback, forms, buttons, tooltips, repeated summaries, and the smallest supported viewport.

Return:

```text
FIRST_ACTION_IN_30_SECONDS: pass | fail
FIRST_ACTION_FOUND:
THREE_SENTENCE_SUMMARY:
- <sentence 1>
- <sentence 2>
- <sentence 3>
CONCEPTS_TO_RETAIN:
- <reader-facing concept or step>
CONCEPT_COUNT:
INTERNAL_LANGUAGE_EXPOSED:
- <exact label and plain alternative, or none>
REPEATED_OR_COMPETING_SECTIONS:
- <section and overlap, or none>
CONTENT_TO_REMOVE:
- <content and why it does not change action, or none>
GLOBAL_ENGLISH_BLOCKERS:
- <exact passage, reason, and bounded correction, or none>
INTERACTION_LABEL_BLOCKERS:
- <label and correction, or none>
MOBILE_ESSENTIAL_PATH: pass | fail | not-verified
MANAGER_CAN_ACT_WITHOUT_JARGON: pass | fail
VERDICT: PASS | REVISE
```

Return `PASS` only when the first action is clear, the three-sentence summary is accurate, the concept budget is respected, no internal terminology blocks use, and a manager using English as an additional language can act without decoding the page.

## Forward-test the reader task

Give fresh reviewers the raw candidate, not the diagnosis, intended fix, or expected answer. Ask them:

1. What should the manager do first?
2. What should the manager ask the employee?
3. What should they decide before the conversation ends?
4. What should the manager do before the next deadline?
5. Which words, labels, or sections were difficult to understand?

Treat unclear or materially inconsistent answers as evidence that the page needs revision. Do not coach the reviewer toward the intended model.
