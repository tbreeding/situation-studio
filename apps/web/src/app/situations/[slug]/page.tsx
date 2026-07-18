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
              publicationRequests: { orderBy: { createdAt: "desc" }, take: 1 },
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
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
        },
      },
      publications: { orderBy: { createdAt: "desc" }, take: 8 },
    },
  });
  if (!situation) notFound();
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
  const artifactEntry =
    revision?.artifacts.find(
      (item) => item.artifact.logicalId === `situation:${slug}`,
    ) ??
    publishedArtifactEntry ??
    null;
  const bundle = draft?.bundles[0] ?? null;
  const graphItems = situation.artifacts.flatMap((artifact) => [
    ...artifact.outgoingEdges.map((edge) => ({
      direction: "Uses",
      item: edge.target,
    })),
    ...artifact.incomingEdges.map((edge) => ({
      direction: "Used by",
      item: edge.source,
    })),
  ]);
  return (
    <AppShell user={session.user} csrfToken={session.csrfToken}>
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
      {checkout && checkout.holderUserId !== session.userId && (
        <p className="alert" role="status">
          Read-only: checked out by{" "}
          {checkout.holder?.displayName ?? "a server job"} for{" "}
          {checkout.mode.toLowerCase().replaceAll("_", " ")}. Last active{" "}
          {checkout.renewedAt.toISOString()}.
        </p>
      )}
      <div className="workspaceGrid">
        <aside className="panel artifactNav">
          <div className="panelHeader">
            <h2>Bundle surfaces</h2>
          </div>
          <div className="panelBody">
            <ul>
              <li>
                <strong>Situation guidance</strong>
                <small>{artifactEntry?.path}</small>
              </li>
              {graphItems.slice(0, 12).map(({ direction, item }) => (
                <li key={`${direction}-${item.id}`}>
                  <strong>
                    {direction}: {item.logicalId.split(":").slice(1).join(":")}
                  </strong>
                  <small>{item.type.toLowerCase().replaceAll("_", " ")}</small>
                </li>
              ))}
            </ul>
          </div>
        </aside>
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
                }
              : null
          }
          rollbackTarget={
            situation.publications.find(
              (publication) =>
                publication.id !== situation.currentPublicationId,
            ) ?? null
          }
          permissions={[...session.permissions]}
        />
        <aside className="panel contextPanel">
          <div className="panelHeader">
            <h2>Review state</h2>
          </div>
          <div className="panelBody">
            <dl className="definitionList">
              <div>
                <dt>Checkout</dt>
                <dd>
                  {checkout
                    ? `${checkout.custody.toLowerCase()} custody · fence ${checkout.fencingToken}`
                    : "Available"}
                </dd>
              </div>
              <div>
                <dt>Draft</dt>
                <dd>
                  {draft
                    ? `Revision ${draft.currentRevision} · ${draft.state.toLowerCase().replaceAll("_", " ")}`
                    : "No mutable draft yet"}
                </dd>
              </div>
              <div>
                <dt>Bundle</dt>
                <dd>
                  {bundle
                    ? `${bundle.canonicalHash.slice(0, 12)}… · ${bundle.state.toLowerCase().replaceAll("_", " ")}`
                    : "No proposal"}
                </dd>
              </div>
              <div>
                <dt>Validations</dt>
                <dd>
                  {bundle
                    ? `${bundle.validations.filter((item) => item.state === "PASSED").length}/${bundle.validations.length} passed`
                    : "Not run"}
                </dd>
              </div>
              <div>
                <dt>Blocking comments</dt>
                <dd>
                  {bundle?.comments.filter((comment) => comment.blocking)
                    .length ?? 0}
                </dd>
              </div>
              <div>
                <dt>Blast radius</dt>
                <dd>
                  {graphItems.length} direct connected edges in this baseline.
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
