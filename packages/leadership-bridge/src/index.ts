import { Client } from "pg";
import {
  Prisma,
  type DatabaseClient,
  type ProductionSourceKind,
} from "@situation-studio/db";
import {
  CONTRACT_VERSION,
  VALIDATION_POLICY_VERSION,
  bundleHash,
  canonicalText,
  sha256,
  situationBundleSchema,
  type SituationBundle,
  type SituationMetadata,
} from "@situation-studio/domain";

export * from "./runtime-capabilities";

type ReleaseRow = {
  release_id: string;
  manifest_hash: string;
  generation: string;
  state: string;
  schema_version: string;
  source_kind: string;
  manifest: string;
  published_at: Date | null;
  artifact_count: number;
  edge_count: number;
};

type SituationRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  stakes: string;
  primary_skill: string;
  preparation_time: "5 minutes" | "15 minutes" | "30 minutes";
  emotional_load: "low" | "medium" | "high";
  pattern: "first-occurrence" | "emerging-pattern" | "repeated-pattern";
  scope: "individual" | "pair" | "team";
  published: string;
  last_reviewed: string;
  author_id: string;
  reviewer_id: string;
  practice_id: string;
  body_mdx: string;
  social_hook: string;
  campaign_cluster: string;
  visibility: "PUBLIC" | "RETIRED";
  tags: string[];
  audiences: Array<"manager" | "technical-lead">;
  supports: Array<"hr" | "legal" | "safety" | "security" | "senior-leader">;
  related_slugs: string[];
  source_ids: string[];
  guide_slugs: string[];
  promotion: Record<string, unknown> | null;
};

type ArtifactRow = {
  logical_id: string;
  type: string;
  content_hash: string;
  byte_length: number;
  media_type: string;
  text_body: string | null;
  binary_body: Buffer | null;
  encoding: "UTF8" | "BINARY";
  visibility: "GLOBAL" | "SITUATION_SCOPED" | "INTERNAL";
  owner_situation_slug: string | null;
  forked_from_logical_id: string | null;
  forked_from_content_hash: string | null;
};

type BindingRow = {
  situation_slug: string;
  artifact_type: string;
  original_logical_id: string;
  resolved_logical_id: string;
  visibility: "GLOBAL" | "SITUATION_SCOPED" | "INTERNAL";
  position: number;
};

export type LeadershipSituationSnapshot = {
  slug: string;
  title: string;
  body: string;
  bundle: SituationBundle;
  artifacts: ArtifactRow[];
};

export type LeadershipReleaseSnapshot = {
  identity: {
    releaseId: string;
    manifestHash: string;
    generation: string;
    state: string;
    schemaVersion: string;
    sourceKind: string;
    manifest: unknown;
    publishedAt: Date | null;
    artifactCount: number;
    edgeCount: number;
  };
  situations: LeadershipSituationSnapshot[];
};

function dateOnly(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function artifactKind(type: string) {
  if (
    [
      "SITUATION",
      "GUIDE",
      "PRACTICE",
      "SOURCE",
      "LESSON_PLAN",
      "PREPARATION_PROMPT",
      "PROMOTION",
    ].includes(type)
  )
    return type as
      | "SITUATION"
      | "GUIDE"
      | "PRACTICE"
      | "SOURCE"
      | "LESSON_PLAN"
      | "PREPARATION_PROMPT"
      | "PROMOTION";
  return null;
}

async function readLeadershipRelease(
  databaseUrl: string,
  releaseId?: string,
): Promise<LeadershipReleaseSnapshot> {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "situation-studio-read-only-bootstrap",
    statement_timeout: 15_000,
  });
  await client.connect();
  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const releaseResult = await client.query<ReleaseRow>(
      `
      SELECT
        release.id AS release_id,
        release.manifest_hash,
        COALESCE(pointer.generation, 0)::text AS generation,
        release.state::text,
        release.schema_version,
        release.source_kind,
        release.manifest,
        release.published_at,
        release.artifact_count,
        release.edge_count
      FROM content_releases release
      LEFT JOIN current_release pointer
        ON pointer.id = 'official' AND pointer.release_id = release.id
      WHERE (
        $1::uuid IS NULL
        AND pointer.id = 'official'
      ) OR release.id = $1::uuid
    `,
      [releaseId ?? null],
    );
    const release = releaseResult.rows[0];
    if (!release) throw new Error("Leadership has no official release.");
    const [situationsResult, artifactsResult, bindingsResult] =
      await Promise.all([
        client.query<SituationRow>(
          `
          SELECT
            situation.id,
            situation.slug,
            situation.title,
            situation.description,
            situation.stakes,
            situation.primary_skill,
            situation.preparation_time,
            situation.emotional_load,
            situation.pattern,
            situation.scope,
            situation.published::text,
            situation.last_reviewed::text,
            situation.author_id,
            situation.reviewer_id,
            situation.practice_id,
            situation.body_mdx,
            situation.social_hook,
            situation.campaign_cluster,
            situation.visibility::text,
            COALESCE((
              SELECT json_agg(tag.value ORDER BY tag.position)
              FROM situation_tags tag WHERE tag.situation_id = situation.id
            ), '[]'::json) AS tags,
            COALESCE((
              SELECT json_agg(audience.value ORDER BY audience.position)
              FROM situation_audiences audience
              WHERE audience.situation_id = situation.id
            ), '[]'::json) AS audiences,
            COALESCE((
              SELECT json_agg(support.value ORDER BY support.position)
              FROM situation_support support
              WHERE support.situation_id = situation.id
            ), '[]'::json) AS supports,
            COALESCE((
              SELECT json_agg(target.slug ORDER BY relation.position)
              FROM situation_relations relation
              JOIN situations target ON target.id = relation.target_situation_id
              WHERE relation.source_situation_id = situation.id
            ), '[]'::json) AS related_slugs,
            COALESCE((
              SELECT json_agg(source.source_id ORDER BY reference.position)
              FROM situation_source_references reference
              JOIN sources source ON source.id = reference.source_id
              WHERE reference.situation_id = situation.id
            ), '[]'::json) AS source_ids,
            COALESCE((
              SELECT json_agg(guide.slug ORDER BY membership.position)
              FROM guide_situations membership
              JOIN guides guide ON guide.id = membership.guide_id
              WHERE membership.situation_id = situation.id
            ), '[]'::json) AS guide_slugs,
            (
              SELECT json_build_object(
                'status', promotion.status,
                'canonical', promotion.canonical,
                'socialDrafts', promotion.social_drafts,
                'scenarioQuestion', promotion.scenario_question,
                'pullQuoteIdea', promotion.pull_quote_idea,
                'utm', promotion.utm,
                'ogPreview', promotion.og_preview
              )
              FROM promotion_packets promotion
              WHERE promotion.release_id = situation.release_id
                AND promotion.slug = situation.slug
            ) AS promotion
          FROM situations situation
          WHERE situation.release_id = $1
          ORDER BY situation.slug
        `,
          [release.release_id],
        ),
        client.query<ArtifactRow>(
          `
          SELECT
            membership.logical_id,
            membership.type::text,
            membership.content_hash,
            membership.byte_length,
            version.media_type,
            version.text_body,
            version.binary_body,
            version.encoding::text,
            artifact.visibility::text,
            artifact.owner_situation_slug,
            artifact.forked_from_logical_id,
            artifact.forked_from_content_hash
          FROM release_artifacts membership
          JOIN artifact_versions version
            ON version.id = membership.artifact_version_id
          JOIN content_artifacts artifact
            ON artifact.id = version.artifact_id
          WHERE membership.release_id = $1
          ORDER BY membership.sort_order
        `,
          [release.release_id],
        ),
        client.query<BindingRow>(
          `
          SELECT situation_slug, artifact_type::text, original_logical_id,
                 resolved_logical_id, visibility::text, position
            FROM situation_artifact_bindings
           WHERE release_id = $1
           ORDER BY situation_slug, position
        `,
          [release.release_id],
        ),
      ]);
    const artifacts = new Map(
      artifactsResult.rows.map((artifact) => [artifact.logical_id, artifact]),
    );
    const snapshots = situationsResult.rows.map((row) => {
      const situationArtifact = artifacts.get(`situation:${row.slug}`);
      const bindings = bindingsResult.rows.filter(
        (binding) => binding.situation_slug === row.slug,
      );
      const scopedResolved = new Set(
        bindings.map((binding) => binding.resolved_logical_id),
      );
      const resolvedPractice =
        bindings.find((binding) => binding.artifact_type === "PRACTICE")
          ?.resolved_logical_id ?? `practice:${row.practice_id}`;
      const resolvedGuides = [
        ...bindings
          .filter((binding) => binding.artifact_type === "GUIDE")
          .map((binding) => binding.resolved_logical_id),
        ...row.guide_slugs
          .map((slug) => `guide:${slug}`)
          .filter((logicalId) => !scopedResolved.has(logicalId)),
      ];
      const resolvedSources = [
        ...bindings
          .filter((binding) => binding.artifact_type === "SOURCE")
          .map((binding) => binding.resolved_logical_id),
        ...(row.source_ids.length >
        bindings.filter((binding) => binding.artifact_type === "SOURCE").length
          ? ["source:catalog"]
          : []),
      ];
      const relationshipIds = [
        resolvedPractice,
        ...resolvedGuides,
        ...resolvedSources,
      ];
      const contextArtifacts = relationshipIds
        .map((logicalId) => artifacts.get(logicalId))
        .filter((artifact): artifact is ArtifactRow => Boolean(artifact));
      const selectedArtifacts = [
        ...(situationArtifact ? [situationArtifact] : []),
        ...contextArtifacts,
      ];
      const metadata: SituationMetadata = {
        slug: row.slug,
        title: row.title,
        description: row.description,
        stakes: row.stakes,
        primarySkill: row.primary_skill,
        preparationTime: row.preparation_time,
        emotionalLoad: row.emotional_load,
        pattern: row.pattern,
        scope: row.scope,
        tags: row.tags,
        audience: row.audiences,
        support: row.supports,
        published: dateOnly(row.published),
        lastReviewed: dateOnly(row.last_reviewed),
        author: row.author_id,
        reviewer: row.reviewer_id,
        socialHook: row.social_hook,
        campaignCluster: row.campaign_cluster,
      };
      const situationId = crypto.randomUUID();
      const body = canonicalText(row.body_mdx);
      const scopedBundleArtifacts = contextArtifacts
        .filter((artifact) => artifact.visibility !== "GLOBAL")
        .map((artifact) => ({
          logicalId: artifact.logical_id,
          kind: artifactKind(artifact.type) ?? "SOURCE",
          contentHash: artifact.content_hash,
          byteLength: artifact.byte_length,
          visibility: artifact.visibility,
          ownerSituationId: situationId,
          forkedFromLogicalId: artifact.forked_from_logical_id,
          forkedFromContentHash: artifact.forked_from_content_hash,
        }));
      const bundle: SituationBundle = {
        schemaVersion: "situation-bundle-v1",
        contractVersion: CONTRACT_VERSION,
        validationPolicyVersion: VALIDATION_POLICY_VERSION,
        situationId,
        visibility: row.visibility,
        metadata,
        bodyHash: sha256(body),
        artifacts: scopedBundleArtifacts,
        relationships: contextArtifacts.map((artifact, position) => ({
          kind: artifact.type,
          logicalId: artifact.logical_id,
          position,
          contentHash: artifact.content_hash,
          visibility:
            bindings.find(
              (binding) => binding.resolved_logical_id === artifact.logical_id,
            )?.visibility ?? "GLOBAL",
        })),
        promotion: row.promotion ?? {},
        contextHashes: contextArtifacts.map(
          (artifact) => artifact.content_hash,
        ),
      };
      return {
        slug: row.slug,
        title: row.title,
        body,
        bundle,
        artifacts: selectedArtifacts,
      };
    });
    await client.query("COMMIT");
    return {
      identity: {
        releaseId: release.release_id,
        manifestHash: release.manifest_hash,
        generation: release.generation,
        state: release.state,
        schemaVersion: release.schema_version,
        sourceKind: release.source_kind,
        manifest: JSON.parse(release.manifest) as unknown,
        publishedAt: release.published_at,
        artifactCount: release.artifact_count,
        edgeCount: release.edge_count,
      },
      situations: snapshots,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export async function readOfficialLeadershipRelease(databaseUrl: string) {
  return readLeadershipRelease(databaseUrl);
}

export async function readLeadershipReleaseHistory(databaseUrl: string) {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "situation-studio-history-discovery",
    statement_timeout: 15_000,
  });
  await client.connect();
  try {
    const releases = await client.query<{ id: string }>(`
      SELECT id
        FROM content_releases
       WHERE state IN ('OFFICIAL', 'RETIRED')
         AND published_at IS NOT NULL
       ORDER BY published_at, created_at, id
    `);
    const snapshots: LeadershipReleaseSnapshot[] = [];
    for (const release of releases.rows)
      snapshots.push(await readLeadershipRelease(databaseUrl, release.id));
    return snapshots;
  } finally {
    await client.end();
  }
}

export async function proveLeadershipConnectionReadOnly(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const authority = await client.query<{
      current_user: string;
      can_update_pointer: boolean;
      is_superuser: boolean;
    }>(`
      SELECT current_user,
             has_table_privilege(
               current_user,
               'current_release',
               'UPDATE'
             ) AS can_update_pointer,
             role.rolsuper AS is_superuser
        FROM pg_roles role
       WHERE role.rolname = current_user
    `);
    const before = await client.query<{
      release_id: string;
      generation: string;
      release_count: string;
    }>(`
      SELECT
        pointer.release_id,
        pointer.generation::text,
        (SELECT count(*)::text FROM content_releases) AS release_count
      FROM current_release pointer
      WHERE pointer.id = 'official'
    `);
    let rejected = false;
    try {
      await client.query(
        "UPDATE current_release SET reason = reason WHERE id = 'official'",
      );
    } catch {
      rejected = true;
    }
    await client.query("ROLLBACK");
    if (!rejected)
      throw new Error(
        "Leadership bootstrap connection unexpectedly allowed a write.",
      );
    const after = await client.query<{
      release_id: string;
      generation: string;
      release_count: string;
    }>(`
      SELECT pointer.release_id, pointer.generation::text,
             (SELECT count(*)::text FROM content_releases) AS release_count
        FROM current_release pointer
       WHERE pointer.id = 'official'
    `);
    if (
      JSON.stringify(before.rows[0]) !== JSON.stringify(after.rows[0]) ||
      authority.rows[0]?.can_update_pointer ||
      authority.rows[0]?.is_superuser
    )
      throw new Error("Leadership reader authority proof failed.");
    return {
      ...before.rows[0],
      currentUser: authority.rows[0]?.current_user,
      writeRejected: true,
    };
  } finally {
    await client.end();
  }
}

function sourceKind(kind: "BOOTSTRAP_IMPORT" | "EXTERNAL_IMPORT") {
  return kind as ProductionSourceKind;
}

export async function importLeadershipRelease(
  studio: DatabaseClient,
  snapshot: LeadershipReleaseSnapshot,
  kind: "BOOTSTRAP_IMPORT" | "EXTERNAL_IMPORT" = "EXTERNAL_IMPORT",
) {
  return studio.$transaction(
    async (transaction) => {
      const observation =
        (await transaction.leadershipReleaseObservation.findUnique({
          where: { releaseId: snapshot.identity.releaseId },
        })) ??
        (await transaction.leadershipReleaseObservation.create({
          data: {
            releaseId: snapshot.identity.releaseId,
            manifestHash: snapshot.identity.manifestHash,
            pointerGeneration: BigInt(snapshot.identity.generation),
            state: snapshot.identity.state,
            sourceKind:
              kind === "BOOTSTRAP_IMPORT"
                ? "READ_ONLY_BOOTSTRAP"
                : "EXTERNAL_PRODUCTION_IMPORT",
            manifest: snapshot.identity.manifest as Prisma.InputJsonValue,
            publishedAt: snapshot.identity.publishedAt,
          },
        }));
      let imported = 0;
      for (const item of snapshot.situations) {
        const existingSituation = await transaction.situation.findUnique({
          where: { slug: item.slug },
        });
        const situation =
          existingSituation ??
          (await transaction.situation.create({
            data: {
              id: item.bundle.situationId,
              slug: item.slug,
              title: item.title,
              visibility: item.bundle.visibility,
            },
          }));
        const stableBundle = situationBundleSchema.parse({
          ...item.bundle,
          situationId: situation.id,
          artifacts: item.bundle.artifacts.map((artifact) => ({
            ...artifact,
            ownerSituationId:
              artifact.visibility === "GLOBAL" ? null : situation.id,
          })),
        });
        const stableBundleHash = bundleHash(stableBundle);
        const existingVersion =
          await transaction.productionSituationVersion.findFirst({
            where: {
              situationId: situation.id,
              bundleHash: stableBundleHash,
            },
          });
        if (!existingVersion) {
          const bodyHash = stableBundle.bodyHash;
          await transaction.contentBlob.createMany({
            data: {
              hash: bodyHash,
              encoding: "UTF8",
              mediaType: "text/mdx; charset=utf-8",
              byteLength: new TextEncoder().encode(item.body).byteLength,
              textBody: item.body,
            },
            skipDuplicates: true,
          });
          for (const artifact of item.artifacts)
            await transaction.contentBlob.createMany({
              data: {
                hash: artifact.content_hash,
                encoding: artifact.encoding,
                mediaType: artifact.media_type,
                byteLength: artifact.byte_length,
                textBody: artifact.text_body,
                binaryBody: artifact.binary_body
                  ? Uint8Array.from(artifact.binary_body)
                  : null,
              },
              skipDuplicates: true,
            });
          for (const artifact of stableBundle.artifacts)
            await transaction.scopedArtifactVariant.createMany({
              data: {
                ownerSituationId: situation.id,
                logicalId: artifact.logicalId,
                kind: artifact.kind,
                visibility: artifact.visibility,
                forkedFromLogicalId:
                  artifact.forkedFromLogicalId ??
                  (() => {
                    throw new Error("Imported scoped artifact lacks lineage.");
                  })(),
                forkedFromContentHash:
                  artifact.forkedFromContentHash ??
                  (() => {
                    throw new Error(
                      "Imported scoped artifact lacks base hash.",
                    );
                  })(),
                contentHash: artifact.contentHash,
              },
              skipDuplicates: true,
            });
          const exactArtifacts = item.artifacts
            .map((artifact) => {
              const kind = artifactKind(artifact.type);
              if (!kind) return null;
              const relationship = stableBundle.relationships.find(
                (candidate) => candidate.logicalId === artifact.logical_id,
              );
              return {
                logicalId:
                  artifact.logical_id === `situation:${item.slug}`
                    ? `leadership:${artifact.logical_id}`
                    : artifact.logical_id,
                kind,
                visibility: relationship?.visibility ?? "GLOBAL",
                contentHash: artifact.content_hash,
                metadata: {
                  source: "leadership-release-artifact",
                  originalLogicalId: artifact.logical_id,
                  mediaType: artifact.media_type,
                  encoding: artifact.encoding,
                },
              };
            })
            .filter((artifact) => artifact !== null);
          const version = await transaction.productionSituationVersion.create({
            data: {
              situationId: situation.id,
              observationId: observation.id,
              bundleHash: stableBundleHash,
              bundleManifest: stableBundle as Prisma.InputJsonValue,
              contractVersion: stableBundle.contractVersion,
              validationPolicy: stableBundle.validationPolicyVersion,
              sourceKind: sourceKind(kind),
              productionAt: snapshot.identity.publishedAt ?? new Date(),
              changeSummary:
                kind === "BOOTSTRAP_IMPORT"
                  ? "Imported existing Leadership production"
                  : "External production import",
              artifacts: {
                create: [
                  {
                    logicalId: `situation:${item.slug}`,
                    kind: "SITUATION",
                    visibility: "GLOBAL",
                    contentHash: bodyHash,
                    position: 0,
                    metadata: { source: "leadership-read-only" },
                  },
                  ...exactArtifacts.map((artifact, position) => ({
                    ...artifact,
                    position: position + 1,
                  })),
                ],
              },
            },
          });
          imported += 1;
          if (snapshot.identity.state === "OFFICIAL")
            await transaction.situation.update({
              where: { id: situation.id },
              data: {
                title: item.title,
                visibility: stableBundle.visibility,
                productionBundleHash: version.bundleHash,
                productionReleaseId: snapshot.identity.releaseId,
                productionAt: version.productionAt,
              },
            });
        } else {
          if (snapshot.identity.state === "OFFICIAL")
            await transaction.situation.update({
              where: { id: situation.id },
              data: {
                title: item.title,
                visibility: stableBundle.visibility,
                productionBundleHash: existingVersion.bundleHash,
                productionReleaseId: snapshot.identity.releaseId,
                productionAt: existingVersion.productionAt,
              },
            });
        }
      }
      if (snapshot.identity.state === "OFFICIAL")
        await transaction.leadershipSyncCursor.upsert({
          where: { id: "official" },
          create: {
            id: "official",
            lastReleaseId: snapshot.identity.releaseId,
            lastManifestHash: snapshot.identity.manifestHash,
            lastPointerGeneration: BigInt(snapshot.identity.generation),
            lastSuccessfulAt: new Date(),
          },
          update: {
            lastReleaseId: snapshot.identity.releaseId,
            lastManifestHash: snapshot.identity.manifestHash,
            lastPointerGeneration: BigInt(snapshot.identity.generation),
            lastSuccessfulAt: new Date(),
            lastErrorCode: null,
          },
        });
      return { observationId: observation.id, imported };
    },
    { isolationLevel: "Serializable" },
  );
}
