import {
  canonicalBundleHash,
  LEADERSHIP_REVIEW_WORKFLOW_VERSION,
  MODEL_POLICY,
  sha256,
  workflowRoles,
  type BundleManifest,
} from "@situation-studio/domain";
import type { DatabaseClient } from "@situation-studio/db";

function deterministicCandidateBody(body: string, changeKind: string) {
  if (changeKind !== "ADD") return body;
  const candidate = body
    .replace("reviewer: pending-human-review", "reviewer: situation-studio")
    .replace("fieldNotePresent: false", "fieldNotePresent: true")
    .replace("reviewStatus: draft", "reviewStatus: human-approved")
    .replace(
      "## Sources and next moves",
      "## Field note\n\nThis draft was assembled through the Situation Studio review workflow. Replace this note with source-specific teaching evidence whenever the human reviewer requests it.\n\n## Sources and next moves",
    );
  if (
    candidate.includes("pending-human-review") ||
    candidate.includes("reviewStatus: draft") ||
    !/relatedSituationIds: \[[^,\]]+, [^\]]+\]/u.test(candidate) ||
    !candidate.includes("## Field note")
  )
    throw new Error(
      "Deterministic candidate failed the new-situation publication contract.",
    );
  return candidate;
}

export async function runDeterministicReview(
  database: DatabaseClient,
  input: {
    draftId: string;
    situationId: string;
    userId: string;
    idempotencyKey: string;
  },
) {
  const draft = await database.draft.findUniqueOrThrow({
    where: { id: input.draftId },
    include: {
      baseSnapshot: true,
      revisions: {
        orderBy: { revision: "desc" },
        take: 1,
        include: { artifacts: { include: { artifact: true } } },
      },
    },
  });
  const revision = draft.revisions[0];
  if (!revision) throw new Error("Draft has no revision");
  const candidateArtifacts = [];
  for (const artifact of revision.artifacts) {
    const content = await database.contentBlob.findUniqueOrThrow({
      where: { hash: artifact.contentHash },
    });
    const candidateBody = deterministicCandidateBody(
      content.body,
      artifact.changeKind,
    );
    const candidateHash = sha256(candidateBody);
    if (candidateHash !== content.hash)
      await database.contentBlob.upsert({
        where: { hash: candidateHash },
        create: {
          hash: candidateHash,
          body: candidateBody,
          byteLength: Buffer.byteLength(candidateBody),
        },
        update: {},
      });
    candidateArtifacts.push({ artifact, candidateHash });
  }
  const latestBundle = await database.proposedBundle.aggregate({
    where: { situationId: input.situationId },
    _max: { revision: true },
  });
  const bundleRevision = (latestBundle._max.revision ?? 0) + 1;
  const graphHash = sha256(JSON.stringify(draft.baseSnapshot.manifest));
  const provider = await database.providerAccount.upsert({
    where: {
      provider_label: { provider: "deterministic", label: "CI fake adapter" },
    },
    create: {
      provider: "deterministic",
      label: "CI fake adapter",
      state: "ENABLED",
      credentialMode: "FAKE",
    },
    update: {},
  });
  const job = await database.aiJob.create({
    data: {
      kind: "FULL_REVIEW",
      ownerId: input.userId,
      situationId: input.situationId,
      draftId: input.draftId,
      inputBundleHash: revision.manifestHash,
      graphHash,
      workflowVersion: LEADERSHIP_REVIEW_WORKFLOW_VERSION,
      modelPolicyVersion: MODEL_POLICY.version,
      state: "RUNNING",
      stage: "Mapping connected learning surfaces",
      idempotencyKey: input.idempotencyKey,
      startedAt: new Date(),
    },
  });
  let predecessorHash = revision.manifestHash;
  for (const role of workflowRoles) {
    const step = await database.workflowStep.create({
      data: {
        jobId: job.id,
        role,
        stage: role.replaceAll("_", " ").toLowerCase(),
        dependencyIds: [],
        inputHash: predecessorHash,
        state: "SUCCEEDED",
        fencingToken: 1,
      },
    });
    const output = {
      role,
      result: "complete",
      findings: [],
      provenance: "deterministic-fake-adapter",
    };
    const outputHash = sha256(JSON.stringify(output));
    const run = await database.agentRun.create({
      data: {
        stepId: step.id,
        attempt: 1,
        providerAccountId: provider.id,
        requestedModel: role.includes("TEACHING_DESIGNER")
          ? "gpt-5.6-sol"
          : "opus",
        resolvedModel: "deterministic-fixture-v1",
        effort:
          role.includes("WRITER") || role.includes("ADJUDICATOR")
            ? "xhigh"
            : "high",
        adapterVersion: "fake-v1",
        inputHash: predecessorHash,
        outputHash,
        normalizedOutput: output,
        usage: { inputTokens: 0, outputTokens: 0, estimated: false },
        finishedAt: new Date(),
      },
    });
    await database.workflowStep.update({
      where: { id: step.id },
      data: { selectedRunId: run.id },
    });
    predecessorHash = outputHash;
  }
  const artifacts = candidateArtifacts.map(({ artifact, candidateHash }) => ({
    logicalId: artifact.artifact.logicalId,
    type: artifact.type as BundleManifest["artifacts"][number]["type"],
    path: artifact.path,
    baseHash: artifact.changeKind === "ADD" ? null : artifact.contentHash,
    candidateHash,
    changeKind:
      artifact.changeKind as BundleManifest["artifacts"][number]["changeKind"],
    noChangeRationale:
      artifact.changeKind === "NO_CHANGE"
        ? "Reviewed; the existing artifact remains consistent with the candidate rule."
        : null,
  }));
  const bundleManifest: BundleManifest = {
    schemaVersion: "1",
    situationId: input.situationId,
    revision: bundleRevision,
    baseCommit: draft.baseSnapshot.commitSha,
    baseManifestHash: draft.baseSnapshot.manifestHash,
    briefHash: null,
    graphHash,
    artifacts,
    relationshipChanges: [],
  };
  const canonicalHash = canonicalBundleHash(bundleManifest);
  const bundle = await database.proposedBundle.create({
    data: {
      situationId: input.situationId,
      revision: bundleRevision,
      snapshotId: draft.baseSnapshotId,
      draftId: input.draftId,
      aiJobId: job.id,
      baseCommit: draft.baseSnapshot.commitSha,
      baseManifestHash: draft.baseSnapshot.manifestHash,
      graphHash,
      canonicalHash,
      manifest: bundleManifest,
      decisionLedger: {
        requiredRoles: workflowRoles,
        completedRoles: workflowRoles,
        tradeoffs: [],
        uncertainties: [],
      },
      contradictionMatrix: {
        status: "PASSED",
        surfaces: artifacts.map((artifact) => artifact.logicalId),
      },
      state: "HUMAN_REVIEW",
    },
  });
  for (const { artifact, candidateHash } of candidateArtifacts)
    await database.bundleArtifact.create({
      data: {
        bundleId: bundle.id,
        artifactId: artifact.artifactId,
        path: artifact.path,
        type: artifact.type,
        baseHash: artifact.contentHash,
        candidateHash,
        contentHash: candidateHash,
        changeKind: artifact.changeKind,
        noChangeRationale:
          artifact.changeKind === "NO_CHANGE"
            ? "Reviewed; no change required."
            : null,
      },
    });
  const environmentHash = sha256("deterministic-ci-environment-v1");
  for (const validator of [
    "instant-schema",
    "affected-graph",
    "publication-policy",
  ])
    await database.validationRun.create({
      data: {
        bundleId: bundle.id,
        bundleHash: canonicalHash,
        validator,
        version: "1",
        environmentHash,
        state: "PASSED",
        summary: "Deterministic fixture passed.",
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
  await database.aiJob.update({
    where: { id: job.id },
    data: {
      state: "SUCCEEDED",
      stage: "Ready for human review",
      finishedAt: new Date(),
    },
  });
  await database.draft.update({
    where: { id: draft.id },
    data: { state: "HUMAN_REVIEW" },
  });
  return { job, bundle };
}
