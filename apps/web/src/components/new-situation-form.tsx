"use client";

import { useState } from "react";

const fields = [
  [
    "observedProblem",
    "Observed problem",
    "What observable behavior or pattern needs guidance?",
  ],
  ["audience", "Audience", "Who will use this guidance?"],
  [
    "managerRole",
    "Manager role",
    "What authority and responsibility does the manager hold?",
  ],
  [
    "knownContext",
    "Known context",
    "What do we know from safe, anonymized evidence?",
  ],
  [
    "assumptions",
    "Accepted assumptions",
    "What working assumptions are you deliberately making?",
  ],
  [
    "unknowns",
    "Unknowns",
    "What remains unknown? Write “None identified” if there are none.",
  ],
  [
    "unknownImpact",
    "Impact of unknowns",
    "How might those unknowns change the advice?",
  ],
  [
    "desiredOutcome",
    "Desired outcome",
    "What should improve after the manager acts?",
  ],
  [
    "safetyEscalation",
    "Safety and escalation",
    "When must the manager stop and seek HR, legal, or emergency support?",
  ],
  [
    "learningObjective",
    "Observable learning objective",
    "Example: The manager can identify the pattern and state one clear next move.",
  ],
  [
    "sources",
    "Source basis",
    "Which approved sources or internal course materials ground this rule?",
  ],
  [
    "shouldAdvise",
    "What this should advise",
    "Name the central recommendation.",
  ],
  [
    "mustNotAdvise",
    "What this must not advise",
    "Name unsafe, coercive, discriminatory, or misleading advice to exclude.",
  ],
  [
    "affectedSurfaces",
    "Expected learning surfaces",
    "Situation, practice, lesson, preparation prompt, or other consumers.",
  ],
] as const;

export function NewSituationForm({
  csrfToken,
  relatedSituations,
}: {
  csrfToken: string;
  relatedSituations: { slug: string; title: string }[];
}) {
  const [status, setStatus] = useState(
    "Complete every field. Human confirmation creates the first immutable brief and draft.",
  );

  async function submit(form: FormData) {
    setStatus("Checking shared understanding and creating the initial draft…");
    const payload = Object.fromEntries(
      [...form.entries()].map(([key, value]) => [key, String(value)]),
    );
    const response = await fetch("/api/situations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(payload),
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
  }

  return (
    <form action={submit} className="panel">
      <div className="panelHeader">
        <h2>Confirmed shared-understanding brief</h2>
      </div>
      <div className="panelBody stack">
        <div className="formGrid">
          <label className="field">
            Stable slug
            <input
              name="slug"
              required
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              maxLength={100}
              placeholder="coach-a-specific-behavior"
            />
          </label>
          <label className="field">
            Situation title
            <input
              name="title"
              required
              minLength={20}
              maxLength={240}
              placeholder="A manager needs to…"
            />
          </label>
        </div>
        <div className="formGrid">
          <label className="field">
            First related situation
            <select name="relatedSituationIdA" required defaultValue="">
              <option value="" disabled>
                Choose a connected next move
              </option>
              {relatedSituations.map((situation) => (
                <option key={situation.slug} value={situation.slug}>
                  {situation.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Second related situation
            <select name="relatedSituationIdB" required defaultValue="">
              <option value="" disabled>
                Choose a distinct connected next move
              </option>
              {relatedSituations.map((situation) => (
                <option key={situation.slug} value={situation.slug}>
                  {situation.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {fields.map(([name, label, placeholder]) => (
          <label className="field" key={name}>
            {label}
            <textarea
              name={name}
              required
              minLength={
                name === "observedProblem"
                  ? 50
                  : name === "desiredOutcome"
                    ? 30
                    : 3
              }
              maxLength={4000}
              placeholder={placeholder}
            />
          </label>
        ))}
        <label className="confirmation">
          <input name="humanConfirmed" type="checkbox" value="yes" required />
          <span>
            I am confirming this exact brief as a human. It uses synthetic or
            anonymized context, contains no sensitive data, and states what the
            guidance must not advise.
          </span>
        </label>
        <p role="status" aria-live="polite">
          {status}
        </p>
        <button className="button" type="submit">
          Confirm brief and create draft
        </button>
      </div>
    </form>
  );
}
