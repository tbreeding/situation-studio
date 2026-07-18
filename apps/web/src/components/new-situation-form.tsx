"use client";

import { type FormEvent, type ReactNode, useMemo, useState } from "react";

const textFields = {
  observedProblem: {
    label: "Observed problem",
    help: "Describe behavior a camera or calendar could capture, not a diagnosis or character judgment.",
    example:
      "Example: Three agreed handoffs arrived after the date without an earlier risk signal.",
    minLength: 50,
  },
  audience: {
    label: "Audience",
    help: "Name the role or group who will use this guidance.",
    example: "Example: Managers of individual contributors",
    minLength: 3,
  },
  managerRole: {
    label: "Manager role",
    help: "State the authority, responsibility, and limits the manager holds in this situation.",
    example:
      "Example: Sets priorities and gives feedback; does not make clinical or legal judgments.",
    minLength: 3,
  },
  knownContext: {
    label: "Known context",
    help: "Record only safe, anonymized facts that are established for this brief.",
    example:
      "Example: Expectations and dates were documented before the work began.",
    minLength: 3,
  },
  assumptions: {
    label: "Accepted assumptions",
    help: "Name working assumptions you are deliberately accepting so reviewers can challenge them.",
    example:
      "Example: The manager has already checked for conflicting priorities.",
    minLength: 3,
  },
  unknowns: {
    label: "Unknowns",
    help: "Name what remains uncertain. Enter “None identified” when there are no deliberate unknowns.",
    example:
      "Example: Whether an approval dependency changed the delivery date",
    minLength: 3,
  },
  unknownImpact: {
    label: "Impact of unknowns",
    help: "Explain how the uncertainty could change the recommendation. This remains required even when no unknown is identified.",
    example:
      "Example: A blocked dependency would shift the advice toward repairing the planning system.",
    minLength: 3,
  },
  desiredOutcome: {
    label: "Desired outcome",
    help: "Describe the observable improvement the manager is trying to produce.",
    example:
      "Example: The employee raises delivery risk before the agreed checkpoint and proposes a tradeoff.",
    minLength: 30,
  },
  safetyEscalation: {
    label: "Safety and escalation",
    help: "State when the manager must stop and seek HR, legal, emergency, or other qualified support.",
    example:
      "Example: Escalate when a protected concern, safety risk, or formal discipline is raised.",
    minLength: 3,
  },
  learningObjective: {
    label: "Observable learning objective",
    help: "Use “can” or “will” plus an observable action such as identify, choose, state, ask, write, demonstrate, practice, compare, respond, or follow.",
    example:
      "Example: The manager can identify the pattern and state one clear next move.",
    minLength: 3,
  },
  sources: {
    label: "Source basis",
    help: "Name the approved sources or internal course materials that ground the rule.",
    example: "Example: Leadership course syllabus, feedback module",
    minLength: 3,
  },
  shouldAdvise: {
    label: "What this should advise",
    help: "State the central recommendation the final guidance must make.",
    example:
      "Example: Name the observed pattern, ask one diagnostic question, and agree on the next behavior.",
    minLength: 3,
  },
  mustNotAdvise: {
    label: "What this must not advise",
    help: "Explicitly exclude unsafe, coercive, discriminatory, clinical, legal, or misleading advice.",
    example:
      "Example: Do not diagnose intent, promise confidentiality, or bypass required support.",
    minLength: 3,
  },
  affectedSurfaces: {
    label: "Expected learning surfaces",
    help: "List the learning surfaces likely to consume the rule so reviewers can assess its blast radius.",
    example:
      "Example: Situation, practice, workshop lesson, preparation prompt",
    minLength: 3,
  },
} as const;

type TextFieldName = keyof typeof textFields;
type FieldName =
  | "title"
  | "slug"
  | "relatedSituationIdA"
  | "relatedSituationIdB"
  | TextFieldName
  | "humanConfirmed";
type Values = Record<FieldName, string>;
type Errors = Partial<Record<FieldName, string>>;
const noErrors: Errors = {};

const initialValues = Object.fromEntries(
  [
    "title",
    "slug",
    "relatedSituationIdA",
    "relatedSituationIdB",
    ...Object.keys(textFields),
    "humanConfirmed",
  ].map((name) => [name, ""]),
) as Values;

const sections = [
  {
    id: "name-connect",
    title: "Name and connect",
    description:
      "Give the situation a durable identity and connect two related next moves.",
    fields: [
      "title",
      "slug",
      "relatedSituationIdA",
      "relatedSituationIdB",
    ] as FieldName[],
  },
  {
    id: "understand",
    title: "Understand the situation",
    description:
      "Separate observed behavior, established context, assumptions, and deliberate unknowns.",
    fields: [
      "observedProblem",
      "audience",
      "managerRole",
      "knownContext",
      "assumptions",
      "unknowns",
      "unknownImpact",
      "desiredOutcome",
    ] as FieldName[],
  },
  {
    id: "guardrails",
    title: "Set safety and learning guardrails",
    description:
      "Define escalation, an observable learning outcome, and the approved source basis.",
    fields: ["safetyEscalation", "learningObjective", "sources"] as FieldName[],
  },
  {
    id: "guidance",
    title: "Define the guidance",
    description:
      "Set the advice boundary, affected surfaces, and final human confirmation.",
    fields: [
      "shouldAdvise",
      "mustNotAdvise",
      "affectedSurfaces",
      "humanConfirmed",
    ] as FieldName[],
  },
] as const;

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100)
    .replace(/-+$/u, "");
}

function validate(values: Values, existingSlugs: ReadonlySet<string>): Errors {
  const errors: Errors = {};
  if (values.title.trim().length < 20)
    errors.title = "Enter a title of at least 20 characters.";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(values.slug))
    errors.slug = "Use lowercase letters, numbers, and single hyphens only.";
  else if (existingSlugs.has(values.slug))
    errors.slug = "That stable slug already belongs to another situation.";
  if (!values.relatedSituationIdA)
    errors.relatedSituationIdA = "Choose the first related situation.";
  if (!values.relatedSituationIdB)
    errors.relatedSituationIdB = "Choose the second related situation.";
  if (
    values.relatedSituationIdA &&
    values.relatedSituationIdA === values.relatedSituationIdB
  )
    errors.relatedSituationIdB = "Choose two distinct related situations.";
  for (const [name, definition] of Object.entries(textFields) as [
    TextFieldName,
    (typeof textFields)[TextFieldName],
  ][]) {
    if (values[name].trim().length < definition.minLength)
      errors[name] = `Enter at least ${definition.minLength} characters.`;
  }
  if (
    values.learningObjective.trim() &&
    !/\b(?:will|can)\b.+\b(?:identify|choose|state|ask|write|demonstrate|practice|compare|respond|follow)\b/iu.test(
      values.learningObjective,
    )
  )
    errors.learningObjective =
      "Describe an observable behavior using “can” or “will” and a measurable action.";
  if (values.humanConfirmed !== "yes")
    errors.humanConfirmed = "Human confirmation is required.";
  return errors;
}

function FieldError({
  name,
  error,
}: {
  name: FieldName;
  error: string | undefined;
}) {
  if (!error) return null;
  return (
    <span className="fieldError" id={`${name}-error`}>
      {error}
    </span>
  );
}

export function NewSituationForm({
  csrfToken,
  relatedSituations,
  existingSlugs,
}: {
  csrfToken: string;
  relatedSituations: { slug: string; title: string }[];
  existingSlugs: string[];
}) {
  const [values, setValues] = useState<Values>(initialValues);
  const [attempted, setAttempted] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [status, setStatus] = useState(
    "Complete all four sections. Nothing is saved until you confirm the exact brief.",
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    Object.fromEntries(sections.map((section) => [section.id, true])),
  );
  const existingSlugSet = useMemo(
    () => new Set(existingSlugs),
    [existingSlugs],
  );
  const allErrors = useMemo(
    () => validate(values, existingSlugSet),
    [existingSlugSet, values],
  );
  const errors = attempted ? allErrors : noErrors;
  const completedSections = sections.filter((section) =>
    section.fields.every((field) => !allErrors[field]),
  );

  function update(name: FieldName, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function updateTitle(value: string) {
    setValues((current) => ({
      ...current,
      title: value,
      slug: slugEdited ? current.slug : slugify(value),
    }));
  }

  function describedBy(name: FieldName) {
    return `${name}-help${errors[name] ? ` ${name}-error` : ""}`;
  }

  function renderTextField(name: TextFieldName): ReactNode {
    const definition = textFields[name];
    return (
      <label className="field" htmlFor={name} key={name}>
        <span>{definition.label}</span>
        <span className="fieldHelp" id={`${name}-help`}>
          {definition.help}
        </span>
        <textarea
          aria-label={definition.label}
          id={name}
          name={name}
          value={values[name]}
          onChange={(event) => update(name, event.target.value)}
          required
          minLength={definition.minLength}
          maxLength={4000}
          placeholder={definition.example}
          aria-describedby={describedBy(name)}
          aria-invalid={errors[name] ? true : undefined}
        />
        <FieldError name={name} error={errors[name]} />
      </label>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    const errorSections = sections.filter((section) =>
      section.fields.some((field) => allErrors[field]),
    );
    setExpanded((current) => ({
      ...current,
      ...Object.fromEntries(errorSections.map((section) => [section.id, true])),
    }));
    const firstInvalid = (Object.keys(initialValues) as FieldName[]).find(
      (field) => allErrors[field],
    );
    if (firstInvalid) {
      setStatus(
        `${Object.keys(allErrors).length} fields need attention. Review the summary and complete the expanded sections.`,
      );
      requestAnimationFrame(() =>
        document.getElementById(firstInvalid)?.focus(),
      );
      return;
    }

    setStatus("Checking shared understanding and creating the initial draft…");
    try {
      const response = await fetch("/api/situations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(values),
      });
      const result = (await response.json()) as {
        slug?: string;
        error?: string;
        reasons?: string[];
      };
      if (response.ok && result.slug)
        location.assign(`/situations/${result.slug}`);
      else
        setStatus(
          result.reasons?.join(" · ") ??
            result.error ??
            "Situation creation failed.",
        );
    } catch {
      setStatus(
        "Situation creation could not reach the server. Your entries remain on this page.",
      );
    }
  }

  return (
    <div className="briefLayout">
      <aside className="briefProgress" aria-labelledby="brief-progress-title">
        <p className="eyebrow" id="brief-progress-title">
          Brief progress
        </p>
        <p className="progressCount">
          <strong>{completedSections.length} of 4</strong> sections complete
        </p>
        <ol>
          {sections.map((section, index) => {
            const complete = completedSections.includes(section);
            return (
              <li
                className={complete ? "complete" : undefined}
                key={section.id}
              >
                <a href={`#${section.id}`}>
                  <span>{index + 1}</span>
                  {section.title}
                </a>
                <small>{complete ? "Complete" : "Incomplete"}</small>
              </li>
            );
          })}
        </ol>
        <p className="fieldHelp">
          Partial content stays in this browser tab and is not persisted.
        </p>
      </aside>

      <form className="briefForm" noValidate onSubmit={submit}>
        <header className="panelHeader briefHeader">
          <div>
            <p className="eyebrow">Immutable after confirmation</p>
            <h2>Shared-understanding discovery brief</h2>
          </div>
          <span className="badge gold">19 required controls</span>
        </header>

        {attempted && Object.keys(errors).length > 0 && (
          <section
            className="errorSummary"
            role="alert"
            aria-labelledby="error-summary-title"
          >
            <h2 id="error-summary-title">The brief is not ready</h2>
            <p>Correct these fields before the create request can be sent:</p>
            <ul>
              {(Object.entries(errors) as [FieldName, string][]).map(
                ([name, error]) => (
                  <li key={name}>
                    <a
                      href={`#${name}`}
                      onClick={() => document.getElementById(name)?.focus()}
                    >
                      {error}
                    </a>
                  </li>
                ),
              )}
            </ul>
          </section>
        )}

        {sections.map((section, index) => {
          const complete = completedSections.includes(section);
          return (
            <details
              className="briefSection"
              id={section.id}
              key={section.id}
              open={expanded[section.id]}
              onToggle={(event) => {
                if (!complete && !event.currentTarget.open) {
                  event.currentTarget.open = true;
                  return;
                }
                setExpanded((current) => ({
                  ...current,
                  [section.id]: event.currentTarget.open,
                }));
              }}
            >
              <summary>
                <span className="sectionNumber">{index + 1}</span>
                <span>
                  <strong>{section.title}</strong>
                  <small>{section.description}</small>
                </span>
                <span className={`badge ${complete ? "" : "gold"}`}>
                  {complete ? "Complete" : "Incomplete"}
                </span>
              </summary>
              <section
                className="briefSectionBody"
                aria-label={section.title}
                role="group"
              >
                {section.id === "name-connect" && (
                  <>
                    <div className="formGrid">
                      <label className="field" htmlFor="title">
                        <span>Situation title</span>
                        <span className="fieldHelp" id="title-help">
                          Use a specific, human-readable title. The stable slug
                          is generated from it and can be edited.
                        </span>
                        <input
                          aria-label="Situation title"
                          id="title"
                          name="title"
                          value={values.title}
                          onChange={(event) => updateTitle(event.target.value)}
                          required
                          minLength={20}
                          maxLength={240}
                          placeholder="Example: A manager keeps taking delegated work back"
                          aria-describedby={describedBy("title")}
                          aria-invalid={errors.title ? true : undefined}
                        />
                        <FieldError name="title" error={errors.title} />
                      </label>
                      <label className="field" htmlFor="slug">
                        <span>Stable slug</span>
                        <span className="fieldHelp" id="slug-help">
                          This becomes the durable route and repository
                          identifier. Confirm it before creation.
                        </span>
                        <input
                          aria-label="Stable slug"
                          id="slug"
                          name="slug"
                          value={values.slug}
                          onChange={(event) => {
                            setSlugEdited(true);
                            update("slug", event.target.value);
                          }}
                          required
                          pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                          maxLength={100}
                          placeholder="manager-keeps-taking-work-back"
                          aria-describedby={describedBy("slug")}
                          aria-invalid={errors.slug ? true : undefined}
                        />
                        <span className="routePreview">
                          Route preview:{" "}
                          <code>
                            /situations/{values.slug || "your-stable-slug"}
                          </code>
                        </span>
                        {slugEdited && (
                          <button
                            className="inlineButton"
                            type="button"
                            onClick={() => {
                              setSlugEdited(false);
                              update("slug", slugify(values.title));
                            }}
                          >
                            Regenerate from title
                          </button>
                        )}
                        <FieldError name="slug" error={errors.slug} />
                      </label>
                    </div>
                    <div className="formGrid">
                      {(
                        ["relatedSituationIdA", "relatedSituationIdB"] as const
                      ).map((name, relatedIndex) => (
                        <label className="field" htmlFor={name} key={name}>
                          <span>
                            {relatedIndex === 0 ? "First" : "Second"} related
                            situation
                          </span>
                          <span className="fieldHelp" id={`${name}-help`}>
                            Choose a distinct, active situation that represents
                            a connected next move.
                          </span>
                          <select
                            aria-label={`${relatedIndex === 0 ? "First" : "Second"} related situation`}
                            id={name}
                            name={name}
                            value={values[name]}
                            onChange={(event) =>
                              update(name, event.target.value)
                            }
                            required
                            aria-describedby={describedBy(name)}
                            aria-invalid={errors[name] ? true : undefined}
                          >
                            <option value="">
                              Choose a connected situation
                            </option>
                            {relatedSituations.map((situation) => (
                              <option
                                key={situation.slug}
                                value={situation.slug}
                              >
                                {situation.title}
                              </option>
                            ))}
                          </select>
                          <FieldError name={name} error={errors[name]} />
                        </label>
                      ))}
                    </div>
                  </>
                )}
                {section.id === "understand" &&
                  section.fields.map((name) =>
                    renderTextField(name as TextFieldName),
                  )}
                {section.id === "guardrails" &&
                  section.fields.map((name) =>
                    renderTextField(name as TextFieldName),
                  )}
                {section.id === "guidance" && (
                  <>
                    {section.fields
                      .filter((name) => name !== "humanConfirmed")
                      .map((name) => renderTextField(name as TextFieldName))}
                    <label className="confirmation" htmlFor="humanConfirmed">
                      <input
                        aria-label="Final human confirmation"
                        id="humanConfirmed"
                        name="humanConfirmed"
                        type="checkbox"
                        value="yes"
                        checked={values.humanConfirmed === "yes"}
                        onChange={(event) =>
                          update(
                            "humanConfirmed",
                            event.target.checked ? "yes" : "",
                          )
                        }
                        required
                        aria-describedby={describedBy("humanConfirmed")}
                        aria-invalid={errors.humanConfirmed ? true : undefined}
                      />
                      <span>
                        <strong>Final human confirmation</strong>
                        <span className="fieldHelp" id="humanConfirmed-help">
                          I confirm this exact brief uses synthetic or
                          anonymized context, contains no sensitive data, and
                          states what the guidance must not advise.
                        </span>
                        <FieldError
                          name="humanConfirmed"
                          error={errors.humanConfirmed}
                        />
                      </span>
                    </label>
                  </>
                )}
              </section>
            </details>
          );
        })}

        <footer className="briefSubmit">
          <p role="status" aria-live="polite">
            {status}
          </p>
          <button className="button" type="submit">
            Confirm brief and create draft
          </button>
        </footer>
      </form>
    </div>
  );
}
