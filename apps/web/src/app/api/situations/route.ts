import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  briefReadiness,
  canonicalJson,
  detectSensitiveText,
  sha256,
  type SharedUnderstandingBrief,
} from "@situation-studio/domain";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { audit } from "@/server/audit";

const text = z.string().trim().min(3).max(4000);
const schema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(100),
  title: z.string().trim().min(20).max(240),
  relatedSituationIdA: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  relatedSituationIdB: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  observedProblem: z.string().trim().min(50).max(4000),
  audience: text,
  managerRole: text,
  knownContext: text,
  assumptions: text,
  unknowns: text,
  unknownImpact: text,
  desiredOutcome: z.string().trim().min(30).max(4000),
  safetyEscalation: text,
  learningObjective: text,
  sources: text,
  shouldAdvise: text,
  mustNotAdvise: text,
  affectedSurfaces: text,
  humanConfirmed: z.literal("yes"),
});

function initialMdx(input: z.infer<typeof schema>) {
  const description = input.observedProblem.replaceAll("\n", " ").slice(0, 180);
  return `---\nslug: ${input.slug}\ntitle: ${JSON.stringify(input.title)}\ndescription: ${JSON.stringify(description)}\nstakes: ${JSON.stringify(input.desiredOutcome.replaceAll("\n", " "))}\nprimarySkill: feedback\ntags: [draft, discovery]\naudience: [manager]\npreparationTime: 15 minutes\nemotionalLoad: medium\npattern: emerging-pattern\nscope: individual\nsupport: [hr]\npublished: 2026-07-18\nlastReviewed: 2026-07-18\nauthor: situation-studio\nreviewer: pending-human-review\nsourceReferences: [course-syllabus]\nrelatedSituationIds: [${input.relatedSituationIdA}, ${input.relatedSituationIdB}]\npracticeId: feedback-fork\npracticeVariant: diagnostic\nfieldNotePresent: false\nsafetyEscalationNotePresent: true\nsocialHook: A useful leadership rule begins with behavior specific enough to discuss.\ncampaignCluster: studio_draft\nreviewStatus: draft\n---\n\n## The short answer\n\n${input.shouldAdvise}\n\n## When this guidance fits\n\n${input.knownContext}\n\n> **Stop and get support:** ${input.safetyEscalation}\n\n## 1 — See\n\n${input.observedProblem}\n\n## 2 — Choose\n\n${input.mustNotAdvise}\n\n## 3 — Say\n\nDraft one observable opening and test it in review.\n\n## If they respond with…\n\n### “I see it differently.”\n\nReturn to specific evidence, ask one diagnostic question, and revise the working hypothesis when new facts warrant it.\n\n## 4 — Sustain\n\n${input.desiredOutcome}\n\n## Two-minute practice\n\n<PracticeEmbed practiceId="feedback-fork" variant="diagnostic" surface="situation" compact />\n\n## I have my next move\n\n<PreparedAction scenario="${input.slug}" skill="feedback" />\n\n## Sources and next moves\n\n${input.sources}\n`;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateMutation(request, "situation.create");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: "Every discovery field is required." },
      { status: 400 },
    );
  if (parsed.data.relatedSituationIdA === parsed.data.relatedSituationIdB)
    return NextResponse.json(
      { error: "Choose two distinct related situations." },
      { status: 400 },
    );
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 120)
    return NextResponse.json(
      { error: "idempotency key required" },
      { status: 400 },
    );
  const route = "/api/situations";
  const requestHash = sha256(canonicalJson(parsed.data));
  const replay = await database().idempotencyKey.findUnique({
    where: {
      actorId_route_key: {
        actorId: auth.session.userId,
        route,
        key: idempotencyKey,
      },
    },
  });
  if (replay) {
    if (replay.requestHash !== requestHash)
      return NextResponse.json(
        { error: "idempotency key reused with different input" },
        { status: 409 },
      );
    const situation = replay.responseRef
      ? await database().situation.findUnique({
          where: { id: replay.responseRef },
        })
      : null;
    if (situation)
      return NextResponse.json({
        id: situation.id,
        slug: situation.slug,
        reused: true,
      });
  }
  const sensitive = detectSensitiveText(canonicalJson(parsed.data));
  if (sensitive.blocked)
    return NextResponse.json(
      { error: "Sensitive content was blocked before persistence." },
      { status: 422 },
    );
  const unknownIsEmpty = /^none\b/iu.test(parsed.data.unknowns);
  const relatedCount = await database().situation.count({
    where: {
      slug: {
        in: [parsed.data.relatedSituationIdA, parsed.data.relatedSituationIdB],
      },
      lifecycle: "ACTIVE",
    },
  });
  if (relatedCount !== 2)
    return NextResponse.json(
      { error: "Related situations must reference two active records." },
      { status: 409 },
    );
  const brief: SharedUnderstandingBrief = {
    observedProblem: {
      value: parsed.data.observedProblem,
      state: "CONFIRMED_FACT",
    },
    audience: { value: parsed.data.audience, state: "CONFIRMED_FACT" },
    managerRole: { value: parsed.data.managerRole, state: "CONFIRMED_FACT" },
    knownContext: { value: parsed.data.knownContext, state: "CONFIRMED_FACT" },
    assumptions: {
      value: parsed.data.assumptions,
      state: "USER_ACCEPTED_ASSUMPTION",
    },
    unknowns: {
      value: parsed.data.unknowns,
      state: unknownIsEmpty ? "CONFIRMED_FACT" : "DELIBERATE_UNKNOWN",
      ...(unknownIsEmpty ? {} : { impact: parsed.data.unknownImpact }),
    },
    desiredOutcome: {
      value: parsed.data.desiredOutcome,
      state: "CONFIRMED_FACT",
    },
    safetyEscalation: {
      value: parsed.data.safetyEscalation,
      state: "CONFIRMED_FACT",
    },
    learningObjective: {
      value: parsed.data.learningObjective,
      state: "CONFIRMED_FACT",
    },
    sources: { value: parsed.data.sources, state: "CONFIRMED_FACT" },
    shouldAdvise: { value: parsed.data.shouldAdvise, state: "CONFIRMED_FACT" },
    mustNotAdvise: {
      value: parsed.data.mustNotAdvise,
      state: "CONFIRMED_FACT",
    },
    affectedSurfaces: {
      value: parsed.data.affectedSurfaces,
      state: "CONFIRMED_FACT",
    },
  };
  const readiness = briefReadiness(brief);
  if (!readiness.ready)
    return NextResponse.json(
      { error: "Brief is not ready.", reasons: readiness.reasons },
      { status: 409 },
    );
  const body = initialMdx(parsed.data);
  const contentHash = sha256(body);
  const briefHash = sha256(canonicalJson(brief));
  let result;
  try {
    result = await database().$transaction(
      async (transaction) => {
        const snapshot = await transaction.repositorySnapshot.findFirstOrThrow({
          orderBy: { createdAt: "desc" },
        });
        const situation = await transaction.situation.create({
          data: {
            slug: parsed.data.slug,
            title: parsed.data.title,
            lifecycle: "UNPUBLISHED",
            publicationState: "NEVER_PUBLISHED",
            fence: 1,
          },
        });
        const artifact = await transaction.artifact.create({
          data: {
            logicalId: `situation:${parsed.data.slug}`,
            type: "SITUATION",
            canonicalPath: `content/situations/${parsed.data.slug}.mdx`,
            primarySituationId: situation.id,
            repositorySnapshotId: snapshot.id,
          },
        });
        await transaction.contentBlob.create({
          data: {
            hash: contentHash,
            body,
            byteLength: Buffer.byteLength(body),
          },
        });
        const draft = await transaction.draft.create({
          data: {
            situationId: situation.id,
            baseSnapshotId: snapshot.id,
            currentRevision: 1,
            state: "DRAFTING",
          },
        });
        const revision = await transaction.draftRevision.create({
          data: {
            draftId: draft.id,
            revision: 1,
            manifestHash: contentHash,
            actorId: auth.session.userId,
            namedCheckpoint: "Confirmed discovery brief",
          },
        });
        await transaction.draftArtifact.create({
          data: {
            revisionId: revision.id,
            artifactId: artifact.id,
            path: artifact.canonicalPath,
            type: "SITUATION",
            contentHash,
            changeKind: "ADD",
          },
        });
        const conversation = await transaction.conversation.create({
          data: {
            situationId: situation.id,
            draftId: draft.id,
            kind: "NEW_SITUATION",
            state: "READY",
            ownerId: auth.session.userId,
          },
        });
        await transaction.conversationMessage.create({
          data: {
            conversationId: conversation.id,
            sequence: 1,
            role: "USER",
            body: canonicalJson(parsed.data),
            bodyHash: sha256(canonicalJson(parsed.data)),
            actorId: auth.session.userId,
          },
        });
        const briefRow = await transaction.sharedUnderstandingBrief.create({
          data: {
            conversationId: conversation.id,
            canonicalFields: brief,
            fieldStates: Object.fromEntries(
              Object.entries(brief).map(([name, item]) => [name, item.state]),
            ),
            sourceSequence: 1,
            readiness,
            hash: briefHash,
          },
        });
        await transaction.conversation.update({
          where: { id: conversation.id },
          data: { currentBriefId: briefRow.id },
        });
        await transaction.briefConfirmation.create({
          data: {
            briefId: briefRow.id,
            actorId: auth.session.userId,
            sessionId: auth.session.id,
            permissionSnapshot: [...auth.session.permissions],
            acceptedUnknowns: unknownIsEmpty
              ? []
              : [{ field: "unknowns", impact: parsed.data.unknownImpact }],
          },
        });
        await transaction.situationCheckout.create({
          data: {
            situationId: situation.id,
            holderUserId: auth.session.userId,
            mode: "EDITING",
            custody: "USER",
            draftId: draft.id,
            fencingToken: 1,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          },
        });
        await transaction.idempotencyKey.create({
          data: {
            actorId: auth.session.userId,
            route,
            key: idempotencyKey,
            requestHash,
            responseRef: situation.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        return situation;
      },
      { isolationLevel: "Serializable", timeout: 30_000 },
    );
  } catch (error) {
    const concurrentReplay = await database().idempotencyKey.findUnique({
      where: {
        actorId_route_key: {
          actorId: auth.session.userId,
          route,
          key: idempotencyKey,
        },
      },
    });
    if (
      concurrentReplay?.requestHash === requestHash &&
      concurrentReplay.responseRef
    ) {
      const existingSituation = await database().situation.findUnique({
        where: { id: concurrentReplay.responseRef },
      });
      if (existingSituation)
        return NextResponse.json({
          id: existingSituation.id,
          slug: existingSituation.slug,
          reused: true,
        });
    }
    throw error;
  }
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "situation.create_from_confirmed_brief",
    targetType: "situation",
    targetId: result.id,
    targetVersion: briefHash,
    outcome: "SUCCEEDED",
    after: { slug: result.slug, briefHash },
  });
  return NextResponse.json(
    { id: result.id, slug: result.slug },
    { status: 201 },
  );
}
