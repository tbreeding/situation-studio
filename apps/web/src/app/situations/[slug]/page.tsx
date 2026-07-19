import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ReviewProgress } from "@/components/review-progress";
import { WorkspaceEditor } from "@/components/workspace-editor";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";
import {
  exactArtifactsMatchReviewProvenance,
  exactArtifactsMatchStoredHashes,
  readPreparedReviewProvenance,
} from "@/server/workflows/review-provenance";
import { publicationDecisionLabel } from "@/lib/publication-presentation";
import { reviewJobSnapshotById } from "@/server/review-progress";

export default async function SituationWorkspace({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login?expired=1");
  const { slug } = await params;
  const situation = await database().situation.findUnique({
    where: { slug },
    include: {
      checkouts: {
        where: { releasedAt: null },
        include: { holder: true, resources: true },
        take: 1,
      },
      drafts: {
        where: { active: true },
        take: 1,
        include: {
          revisions: {
            orderBy: { revision: "desc" },
            take: 1,
            include: {
              artifacts: { include: { artifact: true, content: true } },
            },
          },
          bundles: {
            where: { state: { notIn: ["STALE", "PUBLISHED"] } },
            orderBy: { revision: "desc" },
            take: 1,
            include: {
              validations: true,
              artifacts: { include: { artifact: true, content: true } },
              approvals: {
                where: { invalidatedAt: null },
                orderBy: { approvedAt: "desc" },
                take: 1,
              },
              comments: { where: { status: "OPEN" } },
              publicationRequests: {
                orderBy: { createdAt: "desc" },
                take: 1,
                include: { steps: true },
              },
            },
          },
        },
      },
      versions: {
        orderBy: { createdAt: "asc" },
        take: 1,
        include: { artifacts: { include: { artifact: true, content: true } } },
      },
      currentPublication: {
        include: {
          version: {
            include: {
              artifacts: { include: { artifact: true, content: true } },
            },
          },
        },
      },
      artifacts: {
        include: {
          outgoingEdges: {
            include: { target: { include: { primarySituation: true } } },
          },
          incomingEdges: {
            include: { source: { include: { primarySituation: true } } },
          },
        },
      },
      publications: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });
  if (!situation) notFound();
  const rollbackRequest = await database().rollbackRequest.findFirst({
    where: { situationId: situation.id },
    orderBy: { createdAt: "desc" },
  });
  const checkout = situation.checkouts[0] ?? null;
  const reviewJobRecord =
    checkout?.custody === "AI_JOB" && checkout.custodyReference
      ? await reviewJobSnapshotById(checkout.custodyReference)
      : null;
  const reviewActive = Boolean(reviewJobRecord);
  const reviewJob =
    reviewJobRecord &&
    (reviewJobRecord.ownerId === session.userId ||
      session.permissions.has("system.admin"))
      ? reviewJobRecord.snapshot
      : null;
  const draft = situation.drafts[0] ?? null;
  const revision = draft?.revisions[0] ?? null;
  const publishedArtifactEntry =
    situation.currentPublication?.version?.artifacts.find(
      (item) => item.artifact.logicalId === `situation:${slug}`,
    ) ??
    situation.versions[0]?.artifacts.find(
      (item) => item.artifact.logicalId === `situation:${slug}`,
    ) ??
    null;
  const draftArtifactEntry =
    revision?.artifacts.find(
      (item) => item.artifact.logicalId === `situation:${slug}`,
    ) ?? null;
  const bundle = draft?.bundles[0] ?? null;
  const publicationRequest = bundle?.publicationRequests[0] ?? null;
  const publishedCommitSha =
    publicationRequest?.baseCommit ??
    situation.currentPublication?.commitSha ??
    situation.publications[0]?.commitSha ??
    null;
  const candidateCommitSha =
    publicationRequest?.steps.find(
      (step) => step.step === "COMMITTED" && step.state === "SUCCEEDED",
    )?.externalId ?? null;
  const bundleArtifactEntry =
    bundle?.artifacts.find(
      (item) => item.artifact.logicalId === `situation:${slug}`,
    ) ?? null;
  const artifactEntry =
    bundleArtifactEntry ?? draftArtifactEntry ?? publishedArtifactEntry ?? null;
  const preparedProvenance = readPreparedReviewProvenance(
    bundle?.decisionLedger,
  );
  const provenanceReady = Boolean(
    bundle &&
    preparedProvenance &&
    preparedProvenance.repositoryReviewerId ===
      session.user.repositoryReviewerId &&
    preparedProvenance.preparedByUserId === session.userId &&
    bundle.validations.some(
      (validation) =>
        validation.validator === "human-review-provenance" &&
        validation.state === "PASSED" &&
        validation.bundleHash === bundle.canonicalHash,
    ) &&
    exactArtifactsMatchReviewProvenance(bundle.artifacts, preparedProvenance) &&
    exactArtifactsMatchStoredHashes(bundle.artifacts),
  );
  const graphItems = situation.artifacts.flatMap((artifact) => [
    ...artifact.outgoingEdges.map((edge) => ({
      id: edge.id,
      direction: "Uses",
      relationship: edge.edgeType,
      item: edge.target,
    })),
    ...artifact.incomingEdges.map((edge) => ({
      id: edge.id,
      direction: "Used by",
      relationship: edge.edgeType,
      item: edge.source,
    })),
  ]);
  const graphGroups = graphItems.reduce<Record<string, typeof graphItems>>(
    (groups, item) => {
      (groups[item.item.type] ??= []).push(item);
      return groups;
    },
    {},
  );
  const groupedGraphItems = Object.entries(graphGroups).sort(
    ([left], [right]) =>
      left === "SITUATION"
        ? -1
        : right === "SITUATION"
          ? 1
          : left.localeCompare(right),
  );
  const ownsCheckout =
    checkout?.holderUserId === session.userId && checkout.custody === "USER";
  const nextAction = publicationRequest
    ? publicationRequest.state === "AWAITING_CONFIRMATION" &&
      !publicationRequest.finalConfirmedAt
      ? session.permissions.has("publication.publish")
        ? "Review the staged candidate, then explicitly confirm this exact commit."
        : "The staged candidate is awaiting confirmation from an authorized publisher."
      : publicationRequest.state === "FAILED_PREVIEW"
        ? "Candidate staging failed safely; inspect the recorded failure before retrying."
        : publicationRequest.state === "RECONCILIATION_REQUIRED"
          ? "Publication is blocked until Git, Leadership, and Studio are reconciled."
          : "No action required while the trusted publisher completes and verifies publication."
    : reviewActive
      ? "No action required—your complete review is durable and this page updates automatically."
      : checkout
        ? ownsCheckout
          ? draft
            ? "Continue the checked-out draft, then save, start review, or check in to release it."
            : "This checkout is yours; continue the workflow or check in to release it."
          : `Read the official baseline while ${checkout.holder?.displayName ?? "another operator"} holds the exclusive checkout.`
        : session.permissions.has("draft.update")
          ? "Check out this situation when you are ready to create or continue a draft."
          : "Read the official baseline. Your current permissions do not include editing.";
  const passedValidations =
    bundle?.validations.filter((item) => item.state === "PASSED").length ?? 0;
  const failedValidations =
    bundle?.validations.filter((item) => item.state === "FAILED").length ?? 0;
  return (
    <AppShell
      user={session.user}
      csrfToken={session.csrfToken}
      canAccessAdministration={session.permissions.has("system.admin")}
    >
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Situations</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{situation.title}</span>
      </nav>
      <div className="workspaceTop">
        <div>
          <p className="eyebrow">
            Situation workspace · official baseline{" "}
            {publishedCommitSha?.slice(0, 8) ?? "unavailable"}
          </p>
          <h1>{situation.title}</h1>
        </div>
        <div className="workspaceActions">
          {publicationRequest ? (
            <>
              <span className="badge ink">Official baseline</span>
              <span className="badge gold">
                {candidateCommitSha
                  ? "Candidate staged"
                  : "Candidate preparing"}
              </span>
              <span className="badge rust">
                {publicationDecisionLabel(
                  publicationRequest.state,
                  Boolean(publicationRequest.finalConfirmedAt),
                )}
              </span>
            </>
          ) : (
            <>
              <span className="badge ink">{situation.publicationState}</span>
              {reviewActive ? (
                <>
                  <span className="badge gold">Complete review active</span>
                  <span className="badge rust">Live progress below</span>
                </>
              ) : (
                draft && <span className="badge gold">{draft.state}</span>
              )}
              {checkout && !reviewActive && (
                <span className="badge rust">
                  {checkout.mode} ·{" "}
                  {checkout.holder?.displayName ?? checkout.custody}
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <section
        className="workspaceSummary"
        aria-label="Current situation state"
      >
        <div>
          <span>Official baseline</span>
          <strong>
            {publishedCommitSha ? "Published" : "No official publication"}
          </strong>
          <small>
            Protected Git main ·{" "}
            {publishedCommitSha?.slice(0, 8) ?? "not published"}
          </small>
        </div>
        {publicationRequest ? (
          <div>
            <span>Leadership display</span>
            <strong>
              {candidateCommitSha ? "Staged candidate" : "Preparing candidate"}
            </strong>
            <small>
              {candidateCommitSha
                ? `Commit ${candidateCommitSha.slice(0, 8)} · not yet official`
                : "Publisher is preparing the exact approved bytes"}
            </small>
          </div>
        ) : (
          <div>
            <span>Exclusive checkout</span>
            <strong>
              {reviewActive
                ? "Protected during review"
                : checkout
                  ? "In use"
                  : "Available"}
            </strong>
            <small>
              {reviewActive
                ? "The review job has custody of the saved draft"
                : checkout
                  ? `${checkout.mode.toLowerCase().replaceAll("_", " ")} · ${checkout.holder?.displayName ?? checkout.custody.toLowerCase()}`
                  : "No active owner"}
            </small>
          </div>
        )}
        <div className="nextActionSummary">
          <span>
            {publicationRequest ? "Publication decision" : "Next valid action"}
          </span>
          <strong>{nextAction}</strong>
          {publicationRequest && (
            <small>
              Publisher custody protects the reviewed candidate during this
              decision.
            </small>
          )}
        </div>
        <div>
          <span>Blast radius</span>
          <strong>{graphItems.length} direct connections</strong>
          <small>Detail remains available below</small>
        </div>
      </section>
      {reviewJob && <ReviewProgress initialJob={reviewJob} />}
      {reviewActive && !reviewJob && (
        <section
          aria-labelledby="review-progress-restricted-title"
          className="reviewProgressCard"
        >
          <header className="reviewProgressHeader">
            <div>
              <p className="eyebrow">Complete review active</p>
              <h2 id="review-progress-restricted-title">
                Another operator’s review is in progress
              </h2>
            </div>
          </header>
          <p className="reviewProgressDetail">
            The saved draft is protected while the durable review job runs.
            Detailed live progress is available to the job owner and system
            administrators.
          </p>
          <footer className="reviewProgressFooter">
            <p>
              <strong>What you should do:</strong> No action is required.
            </p>
            <p>The official published guidance remains live.</p>
          </footer>
        </section>
      )}
      {!publicationRequest &&
        !reviewActive &&
        checkout &&
        (checkout.holderUserId !== session.userId ||
          checkout.custody !== "USER") && (
          <p className="alert" role="status">
            Read-only: checkout held by{" "}
            {checkout.custody === "USER"
              ? (checkout.holder?.displayName ?? "another operator")
              : checkout.custody.toLowerCase().replaceAll("_", " ")}{" "}
            for {checkout.mode.toLowerCase().replaceAll("_", " ")}. Last active{" "}
            {checkout.renewedAt.toISOString()}.
          </p>
        )}
      <div className="workspaceGrid">
        <div className="workspacePrimary">
          <WorkspaceEditor
            situationId={situation.id}
            lifecycle={situation.lifecycle}
            draftId={draft?.id ?? null}
            checkout={
              checkout
                ? {
                    id: checkout.id,
                    fencingToken: checkout.fencingToken.toString(),
                    holderUserId: checkout.holderUserId,
                    custody: checkout.custody,
                  }
                : null
            }
            userId={session.userId}
            artifact={
              artifactEntry
                ? {
                    id: artifactEntry.artifactId,
                    body: artifactEntry.content.body,
                  }
                : null
            }
            displayedArtifactState={
              bundleArtifactEntry
                ? "PROPOSAL"
                : draftArtifactEntry
                  ? "DRAFT"
                  : "PUBLISHED"
            }
            publishedBody={publishedArtifactEntry?.content.body ?? null}
            publishedCommitSha={publishedCommitSha}
            revision={bundle?.revision ?? draft?.currentRevision ?? null}
            csrfToken={session.csrfToken}
            bundle={
              bundle
                ? {
                    id: bundle.id,
                    state: bundle.state,
                    canonicalHash: bundle.canonicalHash,
                    repositoryReviewerId:
                      session.user.repositoryReviewerId ?? null,
                    provenanceReady,
                    preparedReviewDate: preparedProvenance?.reviewDate ?? null,
                    artifacts: bundle.artifacts.map((artifact) => ({
                      id: artifact.artifactId,
                      logicalId: artifact.artifact.logicalId,
                      path: artifact.path,
                      changeKind: artifact.changeKind,
                      candidateHash: artifact.candidateHash,
                      body: artifact.content.body,
                    })),
                    comments: bundle.comments.map((comment) => ({
                      id: comment.id,
                      body: comment.body,
                      blocking: comment.blocking,
                    })),
                  }
                : null
            }
            approvalId={bundle?.approvals[0]?.id ?? null}
            publicationRequest={
              publicationRequest
                ? {
                    id: publicationRequest.id,
                    state: publicationRequest.state,
                    currentStep: publicationRequest.currentStep,
                    previewCommitSha: candidateCommitSha,
                    finalConfirmed: Boolean(
                      publicationRequest.finalConfirmedAt,
                    ),
                  }
                : null
            }
            rollbackTarget={
              situation.publications.find(
                (publication) =>
                  publication.id !== situation.currentPublicationId,
              ) ?? null
            }
            rollbackRequest={
              rollbackRequest
                ? {
                    id: rollbackRequest.id,
                    state: rollbackRequest.state,
                    currentStep: rollbackRequest.currentStep,
                  }
                : null
            }
            permissions={[...session.permissions]}
          />
          <details className="panel dependencyPanel">
            <summary>
              <span>
                <strong>Connected bundle surfaces</strong>
                <small>Grouped dependency detail and exact identifiers</small>
              </span>
              <span className="badge">
                {graphItems.length} direct connections
              </span>
            </summary>
            <div className="panelBody dependencyGroups">
              <section>
                <h3>Situation guidance</h3>
                <code>
                  {artifactEntry?.path ?? "No artifact path available"}
                </code>
              </section>
              {groupedGraphItems.map(([type, items]) => (
                <section key={type}>
                  <h3>{type.toLowerCase().replaceAll("_", " ")}</h3>
                  <ul>
                    {items?.map(({ id, direction, relationship, item }) => {
                      const label =
                        item.primarySituation?.title ??
                        item.logicalId.split(":").slice(1).join(":");
                      return (
                        <li key={id}>
                          <div>
                            {item.type === "SITUATION" &&
                            item.primarySituation ? (
                              <Link
                                href={`/situations/${item.primarySituation.slug}`}
                              >
                                {label}
                              </Link>
                            ) : (
                              <strong>{label}</strong>
                            )}
                            <small>
                              {direction} ·{" "}
                              {relationship.toLowerCase().replaceAll("_", " ")}
                            </small>
                          </div>
                          <code>{item.canonicalPath}</code>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          </details>
        </div>
        <aside className="panel contextPanel">
          <div className="panelHeader">
            <h2>Candidate lifecycle</h2>
          </div>
          <div className="panelBody">
            <p className="lifecycleExplanation">
              One official baseline remains in force while a separate candidate
              moves through review and publication.
            </p>
            <ol className="lifecycleList">
              <li className="complete">
                <span>1</span>
                <div>
                  <strong>Official baseline</strong>
                  <small>
                    Protected Git main ·{" "}
                    {publishedCommitSha?.slice(0, 8) ?? "unavailable"}
                  </small>
                </div>
              </li>
              <li
                className={bundle ? "complete" : draft ? "current" : undefined}
              >
                <span>2</span>
                <div>
                  <strong>Candidate created</strong>
                  <small>
                    {bundle
                      ? `Revision ${bundle.revision} immutable candidate`
                      : draft
                        ? `Draft revision ${draft.currentRevision} in progress`
                        : "No current candidate draft."}
                  </small>
                </div>
              </li>
              <li
                className={
                  bundle?.approvals[0]
                    ? "complete"
                    : bundle
                      ? "current"
                      : undefined
                }
              >
                <span>3</span>
                <div>
                  <strong>Review bundle</strong>
                  <small>
                    {bundle
                      ? `Exact bundle ${bundle.canonicalHash.slice(0, 10)}…`
                      : "Awaiting a candidate bundle."}
                  </small>
                </div>
              </li>
              <li
                className={
                  failedValidations
                    ? "blocked"
                    : bundle?.validations.length &&
                        passedValidations === bundle.validations.length
                      ? "complete"
                      : bundle
                        ? "current"
                        : undefined
                }
              >
                <span>4</span>
                <div>
                  <strong>Validation</strong>
                  <small>
                    {bundle
                      ? failedValidations
                        ? `${failedValidations} candidate validation run${failedValidations === 1 ? "" : "s"} failed.`
                        : `${passedValidations}/${bundle.validations.length} candidate validations passed.`
                      : "Not applicable until a candidate bundle exists."}
                  </small>
                </div>
              </li>
              <li
                className={
                  bundle?.approvals[0]
                    ? "complete"
                    : bundle &&
                        !failedValidations &&
                        passedValidations === bundle.validations.length
                      ? "current"
                      : undefined
                }
              >
                <span>5</span>
                <div>
                  <strong>Human approval</strong>
                  <small>
                    {bundle?.approvals[0]
                      ? "The exact validated bundle is approved."
                      : "No approval is expected without a validated candidate."}
                  </small>
                </div>
              </li>
              <li
                className={
                  publicationRequest
                    ? [
                        "FAILED_PREVIEW",
                        "AUTO_ROLLED_BACK",
                        "RECONCILIATION_REQUIRED",
                      ].includes(publicationRequest.state)
                      ? "blocked"
                      : publicationRequest.state === "RECONCILED"
                        ? "complete"
                        : "current"
                    : undefined
                }
              >
                <span>6</span>
                <div>
                  <strong>Final publication</strong>
                  <small>
                    {publicationRequest
                      ? publicationRequest.state === "AWAITING_CONFIRMATION" &&
                        !publicationRequest.finalConfirmedAt
                        ? `Candidate ${candidateCommitSha?.slice(0, 8) ?? ""} staged · awaiting you`
                        : publicationDecisionLabel(
                            publicationRequest.state,
                            Boolean(publicationRequest.finalConfirmedAt),
                          )
                      : "No candidate publication is pending."}
                  </small>
                </div>
              </li>
            </ol>
            <p className="blockingCount">
              <strong>
                {bundle?.comments.filter((comment) => comment.blocking)
                  .length ?? 0}
              </strong>{" "}
              blocking comments on the current candidate
            </p>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
