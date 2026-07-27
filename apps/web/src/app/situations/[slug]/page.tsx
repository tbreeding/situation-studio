import { notFound } from "next/navigation";
import {
  parseSituationSections,
  requiredSituationSections,
  situationBundleSchema,
} from "@situation-studio/domain";
import { AppShell } from "@/components/app-shell";
import { WorkspaceEditor } from "@/components/workspace-editor";
import { workspaceTabFromSearchParam } from "@/components/workspace-tabs";
import { requireSession } from "@/server/auth/request";
import {
  newSituationTemplate,
  workspaceForSlug,
} from "@/server/workflows/situations";
import { reconcileLeadershipRelease } from "@/server/leadership-sync";
import { buildReviewStatusSnapshot } from "@/server/review-status";

export const dynamic = "force-dynamic";

export default async function SituationPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const initialTab = workspaceTabFromSearchParam(query.tab);
  const returnTo = `/situations/${slug}${
    initialTab === "edit" ? "" : `?tab=${initialTab}`
  }`;
  const session = await requireSession(returnTo);
  await reconcileLeadershipRelease();
  const workspace = await workspaceForSlug(slug);
  if (!workspace) notFound();
  const checkout = workspace.checkouts[0] ?? null;
  const draft = workspace.drafts[0];
  const revision = draft?.revisions[0];
  const production = workspace.productionVersions[0];
  const productionBody =
    production?.artifacts.find((artifact) => artifact.kind === "SITUATION")
      ?.content.textBody ?? "";
  const initialBody =
    revision?.artifacts.find((artifact) => artifact.kind === "SITUATION")
      ?.content.textBody ??
    productionBody ??
    "";
  const fallback = newSituationTemplate({
    situationId: workspace.id,
    slug: workspace.slug,
    title: workspace.title,
  });
  const initialBundle = situationBundleSchema.parse(
    revision?.bundleManifest ?? production?.bundleManifest ?? fallback.bundle,
  );
  let initialSections: Record<string, string>;
  try {
    initialSections = parseSituationSections(initialBody || fallback.body);
  } catch {
    initialSections = parseSituationSections(fallback.body);
  }
  const activeReview = workspace.reviewJobs[0];
  const publicationJob = workspace.publicationJobs[0];
  const review = activeReview
    ? {
        id: activeReview.id,
        queuedAt: activeReview.queuedAt.toISOString(),
        status: buildReviewStatusSnapshot(activeReview),
        proposal: activeReview.proposal
          ? {
              id: activeReview.proposal.id,
              summary: activeReview.proposal.summary,
              changes: activeReview.proposal.changes.map((change) => ({
                id: change.id,
                targetKind: change.targetKind,
                targetKey: change.targetKey,
                rationale: change.rationale,
                state: change.state,
              })),
            }
          : null,
      }
    : null;
  const variantsByLogicalId = new Map(
    workspace.variants.map((variant) => [variant.forkedFromLogicalId, variant]),
  );
  const context = initialBundle.relationships.map((relationship) => ({
    logicalId: relationship.logicalId,
    kind: relationship.kind,
    visibility: relationship.visibility,
    contentHash: relationship.contentHash,
    sharingCount: 1,
    hasVariant: variantsByLogicalId.has(relationship.logicalId),
  }));
  return (
    <AppShell
      active="situations"
      csrfToken={session.csrfToken}
      user={{
        displayName: session.user.displayName,
        isAdmin: session.roles.has("ADMIN"),
      }}
    >
      <WorkspaceEditor
        initialTab={initialTab}
        situation={{
          id: workspace.id,
          slug: workspace.slug,
          title: workspace.title,
          visibility: workspace.visibility,
          productionBundleHash: workspace.productionBundleHash,
        }}
        initialBundle={initialBundle}
        initialSections={initialSections}
        initialBody={initialBody || fallback.body}
        productionBody={productionBody}
        sectionNames={[...requiredSituationSections]}
        checkout={
          checkout
            ? {
                id: checkout.id,
                fence: checkout.fence.toString(),
                holderId: checkout.holder.id,
                holderName: checkout.holder.displayName,
              }
            : null
        }
        currentUserId={session.userId}
        csrfToken={session.csrfToken}
        review={review}
        publication={publicationJob ? { state: publicationJob.state } : null}
        history={workspace.productionVersions.map((version) => ({
          id: version.id,
          bundleHash: version.bundleHash,
          productionAt: version.productionAt.toISOString(),
          sourceKind: version.sourceKind,
          releaseId: version.observation.releaseId,
          manifestHash: version.observation.manifestHash,
          changeSummary: version.changeSummary,
          editorNote: version.editorNote,
          body:
            version.artifacts.find((artifact) => artifact.kind === "SITUATION")
              ?.content.textBody ?? "",
        }))}
        context={context}
      />
    </AppShell>
  );
}
