import { notFound } from "next/navigation";
import {
  bundleHash,
  parseSituationSections,
  requiredSituationSections,
  situationBundleSchema,
} from "@situation-studio/domain";
import { AppShell } from "@/components/app-shell";
import { WorkspaceEditor } from "@/components/workspace-editor";
import { workspaceTabFromSearchParam } from "@/components/workspace-tabs";
import { requireSession } from "@/server/auth/request";
import {
  publicationBackupReadiness,
  publicationRecoveryRequired,
  workspaceForSlug,
} from "@/server/workflows/situations";
import { reconcileLeadershipRelease } from "@/server/leadership-sync";
import { buildPublicationStatusSnapshot } from "@/server/publication-status";
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
  const [workspace, globalRecoveryRequired, publicationBackup] =
    await Promise.all([
      workspaceForSlug(slug),
      publicationRecoveryRequired(),
      publicationBackupReadiness(),
    ]);
  if (!workspace) notFound();
  const checkout = workspace.checkouts[0] ?? null;
  const draft = workspace.drafts[0];
  const revision = draft?.revisions[0];
  const production = workspace.productionVersions[0];
  if (!revision && !production) notFound();
  const productionBody =
    production?.artifacts.find((artifact) => artifact.kind === "SITUATION")
      ?.content.textBody ?? "";
  const initialBody =
    revision?.artifacts.find((artifact) => artifact.kind === "SITUATION")
      ?.content.textBody ??
    productionBody ??
    "";
  const initialBundle = situationBundleSchema.parse(
    revision?.bundleManifest ?? production?.bundleManifest,
  );
  let initialSections: Record<string, string>;
  try {
    initialSections = parseSituationSections(initialBody);
  } catch {
    initialSections = Object.fromEntries(
      requiredSituationSections.map((section) => [section, ""]),
    );
  }
  const activeReview = workspace.reviewJobs[0];
  const publicationJob = workspace.publicationJobs[0];
  const stringArray = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const review = activeReview
    ? {
        id: activeReview.id,
        queuedAt: activeReview.queuedAt.toISOString(),
        status: buildReviewStatusSnapshot(activeReview),
        inputRevisionId: activeReview.inputRevisionId,
        currentRevisionId: revision?.id ?? null,
        inputBundleHash: activeReview.inputRevision.bundleHash,
        inputBody:
          activeReview.inputRevision.artifacts.find(
            (artifact) => artifact.kind === "SITUATION",
          )?.content.textBody ?? "",
        proposal: activeReview.proposal
          ? {
              id: activeReview.proposal.id,
              summary: activeReview.proposal.summary,
              currentRevisionId: activeReview.proposal.currentRevisionId,
              currentBundleHash: activeReview.proposal.currentBundleHash,
              supersededAt:
                activeReview.proposal.supersededAt?.toISOString() ?? null,
              candidate: activeReview.proposal.candidate
                ? {
                    body: activeReview.proposal.candidate.body,
                    bodyHash: activeReview.proposal.candidate.bodyHash,
                    bundleHash: activeReview.proposal.candidate.bundleHash,
                    candidateHash:
                      activeReview.proposal.candidate.candidateHash,
                  }
                : null,
              findings: activeReview.proposal.findings.map((finding) => ({
                id: finding.id,
                findingKey: finding.findingKey,
                severity: finding.severity,
                targetKind: finding.targetKind,
                targetKey: finding.targetKey,
                summary: finding.summary,
                rationale: finding.rationale,
                sourceRoleCode: finding.sourceRoleCode,
                evidenceRoleCodes: stringArray(finding.evidenceRoleCodes),
              })),
              changes: activeReview.proposal.changes.map((change) => ({
                id: change.id,
                targetKind: change.targetKind,
                targetKey: change.targetKey,
                applicationMode: change.applicationMode,
                beforeHash: change.beforeHash,
                beforeBody: change.beforeBody,
                afterBody: change.afterBody,
                afterHash: change.afterHash,
                editorBody: change.editorBody,
                editorHash: change.editorHash,
                modified: Boolean(change.editorBody),
                problem: change.problem,
                explanation: change.explanation,
                rationale: change.rationale,
                writtenByRoleCode: change.writtenByRoleCode,
                identifiedByRoleCodes: stringArray(
                  change.identifiedByRoleCodes,
                ),
                evidenceRoleCodes: stringArray(change.evidenceRoleCodes),
                findingIds: change.findingLinks.map((link) => link.finding.id),
                state: change.state,
              })),
            }
          : null,
      }
    : null;
  const variantsByLogicalId = new Map(
    workspace.variants.map((variant) => [variant.logicalId, variant]),
  );
  const context = initialBundle.relationships.map((relationship) => ({
    logicalId: relationship.logicalId,
    kind: relationship.kind,
    visibility: relationship.visibility,
    contentHash: relationship.contentHash,
    sharingCount: 1,
    hasVariant: variantsByLogicalId.has(relationship.logicalId),
    body:
      variantsByLogicalId.get(relationship.logicalId)?.content.textBody ?? "",
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
        initialBody={initialBody}
        initialRevision={{
          id: revision?.id ?? production?.id ?? workspace.id,
          revision: revision?.revision ?? 0,
          bundleHash:
            revision?.bundleHash ??
            production?.bundleHash ??
            bundleHash(initialBundle),
          savedAt: (
            revision?.createdAt ??
            production?.createdAt ??
            workspace.createdAt
          ).toISOString(),
        }}
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
        publication={
          publicationJob ? buildPublicationStatusSnapshot(publicationJob) : null
        }
        globalRecoveryRequired={globalRecoveryRequired}
        publicationBackup={publicationBackup}
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
