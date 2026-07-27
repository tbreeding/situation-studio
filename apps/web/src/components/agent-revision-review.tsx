"use client";

import { diffWordsWithSpace } from "diff";
import { useMemo, useState } from "react";
import { RenderedComparison } from "@/components/rendered-comparison";
import { SynchronizedDiff } from "@/components/synchronized-diff";

export type ReviewFindingView = {
  id: string;
  findingKey: string;
  severity: "NOTE" | "CONSIDER" | "IMPORTANT" | "BLOCKING";
  targetKind: string;
  targetKey: string;
  summary: string;
  rationale: string;
  sourceRoleCode: string;
  evidenceRoleCodes: string[];
};

export type ReviewChangeView = {
  id: string;
  targetKind: string;
  targetKey: string;
  applicationMode: "AUTOMATIC" | "MANUAL";
  beforeHash: string | null;
  beforeBody: string | null;
  afterBody: string;
  afterHash: string;
  editorBody: string | null;
  editorHash: string | null;
  modified: boolean;
  problem: string;
  explanation: string;
  rationale: string;
  writtenByRoleCode: string;
  identifiedByRoleCodes: string[];
  evidenceRoleCodes: string[];
  findingIds: string[];
  state: string;
};

export type ReviewProposalView = {
  id: string;
  summary: string;
  candidate: null | {
    body: string;
    bodyHash: string;
    bundleHash: string;
    candidateHash: string;
  };
  findings: ReviewFindingView[];
  changes: ReviewChangeView[];
};

function roleLabel(role: string) {
  const labels: Record<string, string> = {
    "surface-mapper": "Surface Mapper",
    "critic-nvc": "Nonviolent Communication reviewer",
    "critic-negotiation": "Negotiation reviewer",
    "critic-coaching": "Coaching reviewer",
    "critic-team-health": "Team Health reviewer",
    "critic-radical-candor": "Radical Candor reviewer",
    "critic-change-systems": "Change Systems reviewer",
    "critic-manager-tools": "Manager Tools reviewer",
    "rebuttal-nvc": "Nonviolent Communication rebuttal",
    "rebuttal-negotiation": "Negotiation rebuttal",
    "rebuttal-coaching": "Coaching rebuttal",
    "rebuttal-team-health": "Team Health rebuttal",
    "rebuttal-radical-candor": "Radical Candor rebuttal",
    "rebuttal-change-systems": "Change Systems rebuttal",
    "rebuttal-manager-tools": "Manager Tools rebuttal",
    adjudicator: "Adjudicator",
    "teaching-designer": "Teaching Designer",
    "bundle-writer": "Bundle Writer",
    "audit-semantic": "Semantic auditor",
    "audit-teaching-alignment": "Teaching-alignment auditor",
    "audit-repository-integrity": "Repository-integrity auditor",
    "deterministic-validator": "Deterministic validator",
  };
  if (labels[role]) return labels[role];
  return role
    .replaceAll("-", " ")
    .replace(/\b\w/gu, (value) => value.toUpperCase());
}

function targetLabel(kind: string) {
  return kind.replaceAll("_", " ").toLowerCase();
}

export function reviewSuggestionCounts(proposal: ReviewProposalView) {
  const unresolvedAutomatic = proposal.changes.filter(
    (change) =>
      change.state === "PENDING" && change.applicationMode === "AUTOMATIC",
  ).length;
  const unresolvedManual = proposal.changes.filter(
    (change) =>
      change.state === "PENDING" && change.applicationMode === "MANUAL",
  ).length;
  const linkedFindingIds = new Set(
    proposal.changes.flatMap((change) => change.findingIds),
  );
  return {
    unresolvedAutomatic,
    unresolvedManual,
    unlinkedFindings: proposal.findings.filter(
      (finding) => !linkedFindingIds.has(finding.id),
    ).length,
  };
}

export function inlineSuggestionPieces(change: ReviewChangeView) {
  return diffWordsWithSpace(
    change.beforeBody ?? "",
    change.editorBody ?? change.afterBody,
  );
}

function InlineSuggestionDiff({ change }: { change: ReviewChangeView }) {
  const after = change.editorBody ?? change.afterBody;
  const pieces = useMemo(() => inlineSuggestionPieces(change), [change]);
  return (
    <div
      className="inlineSuggestionDiff"
      role="group"
      aria-label={`Inline change for ${change.targetKey}`}
    >
      <span className="srOnly">
        Before: {change.beforeBody ?? "No existing value"}. Proposed:{" "}
        {after || "No replacement text"}.
      </span>
      <span className="inlineDiffVisual" aria-hidden="true">
        {change.beforeBody === null ? (
          <span className="inlineDiffAdded">
            {after || "No replacement text"}
          </span>
        ) : (
          pieces.map((piece, index) => (
            <span
              key={`${piece.value.slice(0, 20)}-${index}`}
              className={
                piece.added
                  ? "inlineDiffAdded"
                  : piece.removed
                    ? "inlineDiffRemoved"
                    : undefined
              }
            >
              {piece.value}
            </span>
          ))
        )}
      </span>
    </div>
  );
}

export function AgentRevisionReview({
  proposal,
  inputRevisionId,
  currentRevisionId,
  inputBundleHash,
  inputBody,
  checkoutAvailable,
  pending,
  publicationLocked,
  onAccept,
  onReject,
  onEdit,
  onAcceptAll,
}: {
  proposal: ReviewProposalView;
  inputRevisionId: string;
  currentRevisionId: string | null;
  inputBundleHash: string;
  inputBody: string;
  checkoutAvailable: boolean;
  pending: boolean;
  publicationLocked: boolean;
  onAccept: (changeId: string) => Promise<boolean>;
  onReject: (changeId: string) => Promise<boolean>;
  onEdit: (changeId: string, editedBody: string) => Promise<boolean>;
  onAcceptAll: () => Promise<boolean>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editedBody, setEditedBody] = useState("");
  const counts = reviewSuggestionCounts(proposal);
  const unresolvedAutomatic = proposal.changes.filter(
    (change) =>
      change.state === "PENDING" && change.applicationMode === "AUTOMATIC",
  );
  const unresolvedManual = proposal.changes.filter(
    (change) =>
      change.state === "PENDING" && change.applicationMode === "MANUAL",
  );
  const linkedFindingIds = new Set(
    proposal.changes.flatMap((change) => change.findingIds),
  );
  const unresolvedFindings = proposal.findings.filter(
    (finding) => !linkedFindingIds.has(finding.id),
  );
  const candidateBody =
    proposal.candidate?.body ??
    (proposal.changes.length === 0 ? inputBody : null);
  const controlsDisabled = !checkoutAvailable || pending || publicationLocked;

  const beginEdit = (change: ReviewChangeView) => {
    setEditingId(change.id);
    setEditedBody(change.editorBody ?? change.afterBody);
  };

  return (
    <section
      className="agentRevisionReview"
      aria-labelledby="agent-review-title"
    >
      <header className="agentRevisionHeader">
        <div>
          <p className="cardEyebrow">Agent revision</p>
          <h2 id="agent-review-title">Review suggested changes in context</h2>
          <p>
            Review findings and candidate edits are shown against the saved
            draft.
          </p>
          <details className="overallReviewRationale">
            <summary>View overall review rationale</summary>
            <p>{proposal.summary}</p>
          </details>
          <span className="candidateIdentity">
            Based on {inputBundleHash.slice(0, 10)}…
            {currentRevisionId !== inputRevisionId ? " · draft has moved" : ""}
          </span>
        </div>
        {counts.unresolvedAutomatic > 0 ? (
          <button
            className="primaryButton"
            type="button"
            disabled={controlsDisabled}
            onClick={() => void onAcceptAll()}
          >
            Accept all {counts.unresolvedAutomatic}{" "}
            {counts.unresolvedAutomatic === 1 ? "change" : "changes"}
          </button>
        ) : null}
      </header>

      {currentRevisionId !== inputRevisionId ? (
        <p className="staleCandidateNotice" role="status">
          The saved draft changed after this review. Each acceptance still
          checks its exact target and will stop on a conflict.
        </p>
      ) : null}

      {candidateBody !== null ? (
        <>
          <RenderedComparison
            production={inputBody}
            draft={candidateBody}
            productionRevision="Review input"
            draftRevision={
              proposal.candidate
                ? `${proposal.candidate.candidateHash.slice(0, 10)}…`
                : "No materialized edit"
            }
            productionLabel="Saved draft"
            draftLabel="Agent revision"
            ariaLabel="Saved draft and agent revision comparison"
          />
          <details className="diffDisclosure agentSourceDiff">
            <summary>Agent revision source diff</summary>
            <SynchronizedDiff production={inputBody} draft={candidateBody} />
          </details>
        </>
      ) : (
        <p className="legacyCandidateNotice">
          This retained review predates full candidate snapshots. Its structured
          suggestions remain reviewable below.
        </p>
      )}

      {proposal.changes.length === 0 ? (
        <div className="noCandidateEdits">
          <strong>No safe automatic change was generated.</strong>
          <span>
            Review the anchored findings below; the saved draft is unchanged.
          </span>
        </div>
      ) : unresolvedAutomatic.length === 0 && unresolvedManual.length > 0 ? (
        <div className="noCandidateEdits">
          <strong>No safe automatic change is available.</strong>
          <span>
            The remaining items are explicit manual suggestions and will not be
            silently applied.
          </span>
        </div>
      ) : null}

      <div className="reviewHunks">
        {proposal.changes.map((change, index) => {
          const linkedFindings = proposal.findings.filter((finding) =>
            change.findingIds.includes(finding.id),
          );
          const editing = editingId === change.id;
          return (
            <article
              className={`reviewHunk hunk-${change.state.toLowerCase()} ${
                change.applicationMode === "MANUAL" ? "hunk-manual" : ""
              }`}
              key={change.id}
            >
              <header>
                <div>
                  <span className="hunkNumber">
                    Change {index + 1} · {targetLabel(change.targetKind)}
                  </span>
                  <h3>{change.targetKey}</h3>
                </div>
                <div className="hunkBadges">
                  {change.applicationMode === "MANUAL" ? (
                    <span className="manualBadge">Manual only</span>
                  ) : null}
                  {change.modified ? (
                    <span className="modifiedBadge">Modified by editor</span>
                  ) : null}
                  {change.state !== "PENDING" ? (
                    <span className="decisionBadge">
                      {change.state.toLowerCase()}
                    </span>
                  ) : null}
                </div>
              </header>
              {editing ? (
                <div
                  className="suggestionEditor"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingId(null);
                    }
                  }}
                >
                  <label htmlFor={`suggestion-${change.id}`}>
                    Edit the proposed replacement
                  </label>
                  <textarea
                    id={`suggestion-${change.id}`}
                    rows={8}
                    value={editedBody}
                    autoFocus
                    onChange={(event) => setEditedBody(event.target.value)}
                  />
                  <div>
                    <button
                      className="textButton"
                      type="button"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </button>
                    <button
                      className="secondaryButton"
                      type="button"
                      disabled={pending || !editedBody.length}
                      onClick={async () => {
                        if (await onEdit(change.id, editedBody))
                          setEditingId(null);
                      }}
                    >
                      Save edited suggestion
                    </button>
                  </div>
                </div>
              ) : (
                <InlineSuggestionDiff change={change} />
              )}
              <div className="hunkExplanation">
                <p>{change.explanation}</p>
                <details>
                  <summary>View explanation</summary>
                  <dl>
                    <div>
                      <dt>Problem addressed</dt>
                      <dd>{change.problem}</dd>
                    </div>
                    <div>
                      <dt>Identified by</dt>
                      <dd>
                        {change.identifiedByRoleCodes.length
                          ? change.identifiedByRoleCodes
                              .map(roleLabel)
                              .join(", ")
                          : "Retained finding lineage"}
                      </dd>
                    </div>
                    <div>
                      <dt>Replacement written by</dt>
                      <dd>{roleLabel(change.writtenByRoleCode)}</dd>
                    </div>
                    <div>
                      <dt>Evidence informed by</dt>
                      <dd>
                        {change.evidenceRoleCodes.length
                          ? change.evidenceRoleCodes.map(roleLabel).join(", ")
                          : "Pinned review evidence"}
                      </dd>
                    </div>
                  </dl>
                  <p>{change.rationale}</p>
                  {linkedFindings.length ? (
                    <ul>
                      {linkedFindings.map((finding) => (
                        <li key={finding.id}>
                          <strong>{finding.findingKey}</strong>:{" "}
                          {finding.summary}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </details>
              </div>
              {change.state === "PENDING" ? (
                <footer className="hunkActions">
                  <button
                    className="textButton"
                    type="button"
                    disabled={controlsDisabled}
                    onClick={() => void onReject(change.id)}
                  >
                    Reject
                  </button>
                  {change.applicationMode === "AUTOMATIC" ? (
                    <>
                      <button
                        className="textButton"
                        type="button"
                        disabled={controlsDisabled}
                        onClick={() => beginEdit(change)}
                      >
                        Edit suggestion
                      </button>
                      <button
                        className="secondaryButton"
                        type="button"
                        disabled={controlsDisabled}
                        onClick={() => void onAccept(change.id)}
                      >
                        Accept
                      </button>
                    </>
                  ) : (
                    <span>
                      Apply manually in Edit, or reject this suggestion.
                    </span>
                  )}
                </footer>
              ) : null}
            </article>
          );
        })}
      </div>

      {unresolvedFindings.length > 0 ? (
        <section
          className="inlineFindings"
          aria-labelledby="unresolved-findings-title"
        >
          <header>
            <p className="cardEyebrow">Inline review comments</p>
            <h3 id="unresolved-findings-title">
              Findings without a safe replacement
            </h3>
          </header>
          {unresolvedFindings.map((finding) => (
            <article key={finding.id}>
              <div>
                <span
                  className={`findingSeverity severity-${finding.severity.toLowerCase()}`}
                >
                  {finding.severity.toLowerCase()}
                </span>
                <strong>
                  {targetLabel(finding.targetKind)} · {finding.targetKey}
                </strong>
              </div>
              <p>{finding.summary}</p>
              <details>
                <summary>View finding rationale</summary>
                <p>{finding.rationale}</p>
                <small>
                  Identified by {roleLabel(finding.sourceRoleCode)}
                  {finding.evidenceRoleCodes.length
                    ? ` · evidence from ${finding.evidenceRoleCodes
                        .map(roleLabel)
                        .join(", ")}`
                    : ""}
                </small>
              </details>
            </article>
          ))}
        </section>
      ) : null}
    </section>
  );
}
