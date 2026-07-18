import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { WorkspaceEditor } from "@/components/workspace-editor";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";

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
  const artifactEntry = draftArtifactEntry ?? publishedArtifactEntry ?? null;
  const bundle = draft?.bundles[0] ?? null;
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
  const nextAction = checkout
    ? ownsCheckout
      ? draft
        ? "Continue the checked-out draft, then save, start review, or check in to release it."
        : "This checkout is yours; continue the workflow or check in to release it."
      : `Read the published guidance while ${checkout.holder?.displayName ?? "another operator"} holds the exclusive checkout.`
    : session.permissions.has("draft.update")
      ? "Check out this situation when you are ready to create or continue a draft."
      : "Read the published guidance. Your current permissions do not include editing.";
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
            Situation workspace · published base{" "}
            {situation.publications[0]?.commitSha.slice(0, 8)}
          </p>
          <h1>{situation.title}</h1>
        </div>
        <div className="workspaceActions">
          <span className="badge ink">{situation.publicationState}</span>
          {draft && <span className="badge gold">{draft.state}</span>}
          {checkout && (
            <span className="badge rust">
              {checkout.mode} ·{" "}
              {checkout.holder?.displayName ?? checkout.custody}
            </span>
          )}
        </div>
      </div>
      <section
        className="workspaceSummary"
        aria-label="Current situation state"
      >
        <div>
          <span>Published baseline</span>
          <strong>
            {situation.publicationState.toLowerCase().replaceAll("_", " ")}
          </strong>
          <small>
            Commit{" "}
            {situation.publications[0]?.commitSha.slice(0, 8) ??
              "not published"}
          </small>
        </div>
        <div>
          <span>Exclusive checkout</span>
          <strong>{checkout ? "In use" : "Available"}</strong>
          <small>
            {checkout
              ? `${checkout.mode.toLowerCase().replaceAll("_", " ")} · ${checkout.holder?.displayName ?? checkout.custody.toLowerCase()}`
              : "No active owner"}
          </small>
        </div>
        <div className="nextActionSummary">
          <span>Next valid action</span>
          <strong>{nextAction}</strong>
        </div>
        <div>
          <span>Blast radius</span>
          <strong>{graphItems.length} direct connections</strong>
          <small>Detail remains available below</small>
        </div>
      </section>
      {checkout &&
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
              draftArtifactEntry ? (bundle ? "PROPOSAL" : "DRAFT") : "PUBLISHED"
            }
            publishedBody={publishedArtifactEntry?.content.body ?? null}
            revision={draft?.currentRevision ?? null}
            csrfToken={session.csrfToken}
            bundle={
              bundle
                ? {
                    id: bundle.id,
                    state: bundle.state,
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
              bundle?.publicationRequests[0]
                ? {
                    id: bundle.publicationRequests[0].id,
                    state: bundle.publicationRequests[0].state,
                    previewCommitSha:
                      bundle.publicationRequests[0].steps.find(
                        (step) =>
                          step.step === "COMMITTED" &&
                          step.state === "SUCCEEDED",
                      )?.externalId ?? null,
                    finalConfirmed: Boolean(
                      bundle.publicationRequests[0].finalConfirmedAt,
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
              Candidate workflow is layered over the valid published baseline;
              an empty later stage does not invalidate what is already live.
            </p>
            <ol className="lifecycleList">
              <li className="complete">
                <span>1</span>
                <div>
                  <strong>Published baseline</strong>
                  <small>Exact source is read-only until checkout.</small>
                </div>
              </li>
              <li className={draft ? "current" : undefined}>
                <span>2</span>
                <div>
                  <strong>Draft</strong>
                  <small>
                    {draft
                      ? `Revision ${draft.currentRevision} · ${draft.state.toLowerCase().replaceAll("_", " ")}`
                      : "No current candidate draft."}
                  </small>
                </div>
              </li>
              <li className={bundle ? "current" : undefined}>
                <span>3</span>
                <div>
                  <strong>Proposal</strong>
                  <small>
                    {bundle
                      ? `${bundle.state.toLowerCase().replaceAll("_", " ")} · ${bundle.canonicalHash.slice(0, 10)}…`
                      : "Awaiting a candidate bundle."}
                  </small>
                </div>
              </li>
              <li
                className={
                  failedValidations ? "blocked" : bundle ? "current" : undefined
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
              <li className={bundle?.approvals[0] ? "complete" : undefined}>
                <span>5</span>
                <div>
                  <strong>Approval</strong>
                  <small>
                    {bundle?.approvals[0]
                      ? "The exact validated bundle is approved."
                      : "No approval is expected without a validated candidate."}
                  </small>
                </div>
              </li>
              <li
                className={
                  bundle?.publicationRequests[0] ? "current" : undefined
                }
              >
                <span>6</span>
                <div>
                  <strong>Publication</strong>
                  <small>
                    {bundle?.publicationRequests[0]
                      ? bundle.publicationRequests[0].state
                          .toLowerCase()
                          .replaceAll("_", " ")
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
