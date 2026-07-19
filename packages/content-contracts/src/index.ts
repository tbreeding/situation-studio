import { createHash } from "node:crypto";
import { compile } from "@mdx-js/mdx";
import matter from "gray-matter";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import {
  authorSchema,
  bibliographyEntrySchema,
  guideFrontmatterSchema,
  practiceSchema,
  situationFrontmatterSchema,
  toolCatalogSchema,
  type GuideFrontmatter,
  type Practice,
  type SituationFrontmatter,
  type ToolConfig,
} from "./schemas";

export * from "./schemas";

export const artifactTypes = [
  "SITUATION",
  "GUIDE",
  "PRACTICE",
  "LESSON_PLAN",
  "PREPARATION_PROMPT",
  "TOOL",
  "SOURCE",
  "AUTHOR",
  "ASSET",
] as const;

export const artifactEdgeTypes = [
  "EMBEDS_PRACTICE",
  "TAUGHT_BY_LESSON",
  "PREPARES_WITH",
  "CITES_SOURCE",
  "LINKS_TO",
] as const;

export const contentEncodings = ["UTF8", "BINARY"] as const;
export type ArtifactType = (typeof artifactTypes)[number];
export type ArtifactEdgeType = (typeof artifactEdgeTypes)[number];
export type ContentEncoding = (typeof contentEncodings)[number];

const safePathSegment = /^(?!\.)(?!.*\.$)[\p{L}\p{N} _.,()&+'-]+$/u;
const exactContentPaths = new Set([
  "content/bibliography/sources.json",
  "content/authors/authors.json",
  "content/tools/tools.json",
]);

function hasSafeSegments(candidatePath: string): boolean {
  if (
    !candidatePath ||
    candidatePath.startsWith("/") ||
    candidatePath.includes("\\") ||
    candidatePath.includes("\0")
  )
    return false;
  return candidatePath
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        safePathSegment.test(segment),
    );
}

export function isApprovedArtifactPath(candidatePath: string): boolean {
  if (!hasSafeSegments(candidatePath)) return false;
  if (exactContentPaths.has(candidatePath)) return true;
  if (/^content\/situations\/[a-z0-9-]+\.mdx$/u.test(candidatePath))
    return true;
  if (/^content\/guides\/[a-z0-9-]+\.mdx$/u.test(candidatePath)) return true;
  if (/^content\/practices\/[a-z0-9-]+\.json$/u.test(candidatePath))
    return true;
  return (
    candidatePath.startsWith("sourceMaterial/") &&
    /\.(?:md|csv|png)$/iu.test(candidatePath)
  );
}

export function canonicalText(value: string): string {
  return `${value.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "")}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalArtifactBytes(
  candidatePath: string,
  sourceBytes: Uint8Array,
): { bytes: Uint8Array; encoding: ContentEncoding; normalization: string } {
  if (candidatePath.toLowerCase().endsWith(".png"))
    return { bytes: sourceBytes, encoding: "BINARY", normalization: "NONE" };
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  const normalized = canonicalText(decoded);
  return {
    bytes: new TextEncoder().encode(normalized),
    encoding: "UTF8",
    normalization: normalized === decoded ? "NONE" : "CANONICAL_NEWLINE",
  };
}

export function classifyArtifactPath(candidatePath: string): ArtifactType {
  if (!isApprovedArtifactPath(candidatePath))
    throw new Error(`Unapproved managed artifact path: ${candidatePath}`);
  if (candidatePath.startsWith("content/situations/")) return "SITUATION";
  if (candidatePath.startsWith("content/guides/")) return "GUIDE";
  if (candidatePath.startsWith("content/practices/")) return "PRACTICE";
  if (candidatePath === "content/bibliography/sources.json") return "SOURCE";
  if (candidatePath === "content/authors/authors.json") return "AUTHOR";
  if (candidatePath === "content/tools/tools.json") return "TOOL";
  if (candidatePath.toLowerCase().endsWith(".png")) return "ASSET";
  if (candidatePath.toLowerCase().endsWith(".csv")) return "SOURCE";
  if (candidatePath.includes("/misc/")) return "PREPARATION_PROMPT";
  if (
    candidatePath.includes("/lesson-plans/") ||
    /\/\d+[_ ]syllabus\.md$/iu.test(candidatePath)
  )
    return "LESSON_PLAN";
  return "SOURCE";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

export function mediaTypeForPath(candidatePath: string): string {
  if (candidatePath.endsWith(".mdx")) return "text/mdx; charset=utf-8";
  if (candidatePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (candidatePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (candidatePath.endsWith(".csv")) return "text/csv; charset=utf-8";
  if (candidatePath.endsWith(".png")) return "image/png";
  throw new Error(`Unknown media type for ${candidatePath}`);
}

export function logicalIdForArtifact(
  candidatePath: string,
  canonicalBytes: Uint8Array,
): string {
  const type = classifyArtifactPath(candidatePath);
  const text =
    type === "ASSET"
      ? ""
      : new TextDecoder("utf-8", { fatal: true }).decode(canonicalBytes);
  if (type === "SITUATION" || type === "GUIDE") {
    const parsed = matter(text);
    return `${type.toLowerCase()}:${String(parsed.data.slug)}`;
  }
  if (type === "PRACTICE")
    return `practice:${String((JSON.parse(text) as { id?: unknown }).id)}`;
  if (candidatePath === "content/bibliography/sources.json")
    return "source:catalog";
  if (candidatePath === "content/authors/authors.json") return "author:catalog";
  if (candidatePath === "content/tools/tools.json") return "tool:catalog";
  if (candidatePath.endsWith("Booklist - Copy of Sheet1.csv"))
    return "source:workshop-booklist";
  if (candidatePath.endsWith("/README.md")) return "source:workshop-readme";
  if (candidatePath.endsWith("/assets/logo.png")) return "asset:workshop-logo";
  if (/\/\d+[_ ]syllabus\.md$/iu.test(candidatePath))
    return "lesson-plan:workshop-syllabus";
  const basename = candidatePath.split("/").at(-1) ?? candidatePath;
  return `${type.toLowerCase().replaceAll("_", "-")}:${slugify(
    basename.replace(/\.[^.]+$/u, ""),
  )}`;
}

export const snapshotArtifactSchema = z.object({
  logicalId: z.string().min(1).max(200),
  type: z.enum(artifactTypes),
  path: z.string().refine(isApprovedArtifactPath),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  byteLength: z
    .number()
    .int()
    .nonnegative()
    .max(2 * 1024 * 1024),
  encoding: z.enum(contentEncodings),
  mediaType: z.string().min(1).max(100),
});

export const snapshotEdgeSchema = z.object({
  source: z.string().min(1).max(200),
  target: z.string().min(1).max(200),
  type: z.enum(artifactEdgeTypes),
  evidence: z.string().min(1).max(500),
});

export const snapshotManifestSchema = z.object({
  schemaVersion: z.literal("content-snapshot-v1"),
  validationPolicyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.object({
    releaseId: z.string().min(1),
    historicalCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    frozenManifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  artifacts: z.array(snapshotArtifactSchema).min(1),
  edges: z.array(snapshotEdgeSchema),
});

export type SnapshotArtifact = z.infer<typeof snapshotArtifactSchema>;
export type SnapshotEdge = z.infer<typeof snapshotEdgeSchema>;
export type SnapshotManifest = z.infer<typeof snapshotManifestSchema>;
export type SnapshotSource = SnapshotManifest["source"];

export const validationPolicy = {
  schemaVersion: "leadership-content-policy-v1",
  allowedMdxComponents: ["PracticeEmbed", "PreparedAction"],
  maxArtifactBytes: 2 * 1024 * 1024,
  maxSnapshotBytes: 32 * 1024 * 1024,
  canonicalNewline: "CRLF and CR become LF; trailing newlines become one LF",
} as const;
export const validationPolicyHash = sha256(canonicalJson(validationPolicy));

const requiredSituationHeadings = [
  "## The short answer",
  "## When this guidance fits",
  "## 1 — See",
  "## 2 — Choose",
  "## 3 — Say",
  "## If they respond with…",
  "## 4 — Sustain",
  "## Two-minute practice",
  "## I have my next move",
  "## Field note",
  "## Sources and next moves",
] as const;

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size)
    throw new Error(`Duplicate ${label}: ${[...duplicates].sort().join(", ")}`);
}

function assertOrdered<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): void {
  const actual = values.map(key);
  const expected = [...actual].sort((left, right) => left.localeCompare(right));
  if (actual.some((value, index) => value !== expected[index]))
    throw new Error(`${label} must be sorted canonically.`);
}

function validateSafeMdx(path: string, source: string): string[] {
  if (/^(?:import|export)\s/gmu.test(source))
    throw new Error(`${path}: MDX module syntax is forbidden.`);
  if (/<\/?(?:script|style|iframe|object|embed)\b/iu.test(source))
    throw new Error(`${path}: unsafe HTML element is forbidden.`);
  if (
    /\bon[A-Z_a-z][\w-]*\s*=/u.test(source) ||
    /javascript\s*:/iu.test(source)
  )
    throw new Error(`${path}: executable MDX attribute is forbidden.`);
  const components = [...source.matchAll(/<\/?([A-Z][A-Za-z0-9]*)\b/gu)].map(
    (match) => match[1] ?? "",
  );
  const unknown = [...new Set(components)].filter(
    (component) =>
      !validationPolicy.allowedMdxComponents.includes(
        component as (typeof validationPolicy.allowedMdxComponents)[number],
      ),
  );
  if (unknown.length)
    throw new Error(`${path}: unknown MDX components: ${unknown.join(", ")}`);
  return [...new Set(components)].sort();
}

export async function compileSafeMdx(
  path: string,
  source: string,
): Promise<{ components: string[]; compiledHash: string }> {
  const components = validateSafeMdx(path, source);
  const compiled = await compile(source, {
    format: "mdx",
    outputFormat: "function-body",
    remarkPlugins: [remarkGfm],
  });
  return { components, compiledHash: sha256(String(compiled)) };
}

function parseJson(path: string, body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(
      `${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type ParsedSnapshot = {
  artifactIds: Set<string>;
  situations: Map<string, SituationFrontmatter>;
  guides: Map<string, GuideFrontmatter>;
  practices: Map<string, Practice>;
  sources: z.infer<typeof bibliographyEntrySchema>[];
  authors: z.infer<typeof authorSchema>[];
  tools: ToolConfig[];
  componentUses: number;
  routeProbes: { path: string; logicalId: string; kind: string }[];
};

export async function validateSnapshotBodies(
  artifacts: readonly SnapshotArtifact[],
  bodies: ReadonlyMap<string, Uint8Array>,
): Promise<ParsedSnapshot> {
  const situations = new Map<string, SituationFrontmatter>();
  const guides = new Map<string, GuideFrontmatter>();
  const practices = new Map<string, Practice>();
  let sources: z.infer<typeof bibliographyEntrySchema>[] = [];
  let authors: z.infer<typeof authorSchema>[] = [];
  let tools: ToolConfig[] = [];
  let componentUses = 0;
  let totalBytes = 0;

  for (const artifact of artifacts) {
    const bytes = bodies.get(artifact.contentHash);
    if (!bytes) throw new Error(`Missing body for ${artifact.logicalId}.`);
    if (bytes.byteLength !== artifact.byteLength)
      throw new Error(`${artifact.path}: byte length mismatch.`);
    if (sha256(bytes) !== artifact.contentHash)
      throw new Error(`${artifact.path}: content hash mismatch.`);
    totalBytes += bytes.byteLength;
    if (artifact.encoding === "BINARY") {
      if (artifact.type !== "ASSET")
        throw new Error(
          `${artifact.path}: only assets may use binary encoding.`,
        );
      continue;
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (canonicalText(body) !== body)
      throw new Error(
        `${artifact.path}: text does not use the canonical newline rule.`,
      );
    if (artifact.type === "SITUATION" || artifact.type === "GUIDE") {
      const parsed = matter(body);
      const frontmatter =
        artifact.type === "SITUATION"
          ? situationFrontmatterSchema.parse(parsed.data)
          : guideFrontmatterSchema.parse(parsed.data);
      const { components } = await compileSafeMdx(
        artifact.path,
        parsed.content,
      );
      componentUses += components.length;
      if (artifact.type === "SITUATION") {
        const situation = frontmatter as SituationFrontmatter;
        for (const heading of requiredSituationHeadings) {
          const current = parsed.content.indexOf(heading);
          const previous = requiredSituationHeadings
            .slice(0, requiredSituationHeadings.indexOf(heading))
            .map((candidate) => parsed.content.indexOf(candidate))
            .at(-1);
          if (current < 0)
            throw new Error(`${artifact.path}: missing heading “${heading}”.`);
          if (previous !== undefined && current <= previous)
            throw new Error(
              `${artifact.path}: heading order is invalid at “${heading}”.`,
            );
        }
        const practiceTag = new RegExp(
          `<PracticeEmbed\\s+practiceId=["']${situation.practiceId}["']\\s+variant=["']${situation.practiceVariant}["']\\s+surface=["']situation["']`,
          "u",
        );
        if (!practiceTag.test(parsed.content))
          throw new Error(
            `${artifact.path}: PracticeEmbed does not match frontmatter.`,
          );
        const actionTag = new RegExp(
          `<PreparedAction\\s+scenario=["']${situation.slug}["']\\s+skill=["']${situation.primarySkill}["']\\s*/>`,
          "u",
        );
        if (!actionTag.test(parsed.content))
          throw new Error(
            `${artifact.path}: PreparedAction does not match frontmatter.`,
          );
        situations.set(situation.slug, situation);
      } else {
        const guide = frontmatter as GuideFrontmatter;
        guides.set(guide.slug, guide);
      }
      continue;
    }
    if (artifact.type === "PRACTICE") {
      const practice = practiceSchema.parse(parseJson(artifact.path, body));
      assertUnique(
        practice.rounds.map((round) => round.id),
        `${artifact.path} round IDs`,
      );
      for (const round of practice.rounds)
        assertUnique(
          round.choices.map((choice) => choice.id),
          `${artifact.path} ${round.id} choice IDs`,
        );
      practices.set(practice.id, practice);
    } else if (artifact.path === "content/bibliography/sources.json") {
      sources = bibliographyEntrySchema
        .array()
        .parse(parseJson(artifact.path, body));
      assertUnique(
        sources.map((source) => source.id),
        "bibliography IDs",
      );
    } else if (artifact.path === "content/authors/authors.json") {
      authors = authorSchema.array().parse(parseJson(artifact.path, body));
      assertUnique(
        authors.map((author) => author.id),
        "author IDs",
      );
    } else if (artifact.path === "content/tools/tools.json") {
      tools = toolCatalogSchema.parse(parseJson(artifact.path, body));
      assertUnique(
        tools.map((tool) => tool.id),
        "tool IDs",
      );
      for (const tool of tools)
        assertUnique(
          tool.fields.map((field) => field.id),
          `${tool.id} field IDs`,
        );
    }
  }
  if (totalBytes > validationPolicy.maxSnapshotBytes)
    throw new Error(
      `Snapshot exceeds ${validationPolicy.maxSnapshotBytes} bytes.`,
    );
  assertUnique([...situations.keys()], "situation slugs");
  assertUnique([...guides.keys()], "guide slugs");
  assertUnique([...practices.keys()], "practice IDs");
  const sourceIds = new Set(sources.map((source) => source.id));
  const authorIds = new Set(authors.map((author) => author.id));
  for (const situation of situations.values()) {
    for (const relation of situation.relatedSituationIds) {
      if (!situations.has(relation))
        throw new Error(
          `${situation.slug}: missing related situation ${relation}.`,
        );
      if (relation === situation.slug)
        throw new Error(`${situation.slug}: cannot relate to itself.`);
    }
    for (const source of situation.sourceReferences)
      if (!sourceIds.has(source))
        throw new Error(`${situation.slug}: missing source ${source}.`);
    if (!authorIds.has(situation.author))
      throw new Error(`${situation.slug}: missing author ${situation.author}.`);
    if (!authorIds.has(situation.reviewer))
      throw new Error(
        `${situation.slug}: missing reviewer ${situation.reviewer}.`,
      );
    if (!practices.has(situation.practiceId))
      throw new Error(
        `${situation.slug}: missing practice ${situation.practiceId}.`,
      );
  }
  for (const guide of guides.values()) {
    for (const relation of guide.relatedSituationIds)
      if (!situations.has(relation))
        throw new Error(
          `${guide.slug}: missing related situation ${relation}.`,
        );
    if (!practices.has(guide.practiceId))
      throw new Error(`${guide.slug}: missing practice ${guide.practiceId}.`);
    if (!authorIds.has(guide.author) || !authorIds.has(guide.reviewer))
      throw new Error(`${guide.slug}: missing author or reviewer.`);
  }
  return {
    artifactIds: new Set(artifacts.map((artifact) => artifact.logicalId)),
    situations,
    guides,
    practices,
    sources,
    authors,
    tools,
    componentUses,
    routeProbes: [
      ...[...situations.values()].map((value) => ({
        path: `/situations/${value.slug}`,
        logicalId: `situation:${value.slug}`,
        kind: "situation",
      })),
      ...[...guides.values()].map((value) => ({
        path: `/guides/${value.slug}`,
        logicalId: `guide:${value.slug}`,
        kind: "guide",
      })),
      ...[...practices.values()].map((value) => ({
        path: `/practice/${value.id}`,
        logicalId: `practice:${value.id}`,
        kind: "practice",
      })),
      ...tools.map((value) => ({
        path: `/tools/${value.id}`,
        logicalId: "tool:catalog",
        kind: "tool",
      })),
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function buildSnapshotEdges(parsed: ParsedSnapshot): SnapshotEdge[] {
  const edges: SnapshotEdge[] = [];
  for (const situation of parsed.situations.values()) {
    const source = `situation:${situation.slug}`;
    edges.push({
      source,
      target: `practice:${situation.practiceId}`,
      type: "EMBEDS_PRACTICE",
      evidence: `content/situations/${situation.slug}.mdx:practiceId`,
    });
    for (const targetSlug of situation.relatedSituationIds)
      edges.push({
        source,
        target: `situation:${targetSlug}`,
        type: "LINKS_TO",
        evidence: `content/situations/${situation.slug}.mdx:relatedSituationIds`,
      });
    edges.push({
      source,
      target: "source:catalog",
      type: "CITES_SOURCE",
      evidence: `content/situations/${situation.slug}.mdx:sourceReferences=${situation.sourceReferences.join(",")}`,
    });
    edges.push({
      source,
      target: "author:catalog",
      type: "LINKS_TO",
      evidence: `content/situations/${situation.slug}.mdx:author,reviewer`,
    });
    if (situation.sourceReferences.includes("one-on-one-lesson"))
      edges.push({
        source,
        target: "lesson-plan:003-manager-tools-the-trinity-and-1on1s",
        type: "TAUGHT_BY_LESSON",
        evidence: "sourceReferences:one-on-one-lesson",
      });
  }
  for (const guide of parsed.guides.values()) {
    const source = `guide:${guide.slug}`;
    edges.push({
      source,
      target: `practice:${guide.practiceId}`,
      type: "EMBEDS_PRACTICE",
      evidence: `content/guides/${guide.slug}.mdx:practiceId`,
    });
    for (const targetSlug of guide.relatedSituationIds)
      edges.push({
        source,
        target: `situation:${targetSlug}`,
        type: "LINKS_TO",
        evidence: `content/guides/${guide.slug}.mdx:relatedSituationIds`,
      });
    edges.push({
      source,
      target: "author:catalog",
      type: "LINKS_TO",
      evidence: `content/guides/${guide.slug}.mdx:author,reviewer`,
    });
  }
  if (
    parsed.artifactIds.has("source:workshop-readme") &&
    parsed.artifactIds.has("asset:workshop-logo")
  )
    edges.push({
      source: "source:workshop-readme",
      target: "asset:workshop-logo",
      type: "LINKS_TO",
      evidence: "sourceMaterial/leadership-workshops-master/README.md:logo",
    });
  return edges.sort((left, right) =>
    `${left.source}\0${left.type}\0${left.target}`.localeCompare(
      `${right.source}\0${right.type}\0${right.target}`,
    ),
  );
}

export async function validateCanonicalSnapshot(
  manifestBody: string,
  bodies: ReadonlyMap<string, Uint8Array>,
): Promise<ParsedSnapshot> {
  const manifest = snapshotManifestSchema.parse(JSON.parse(manifestBody));
  if (canonicalJson(manifest) !== manifestBody)
    throw new Error("Snapshot manifest is not exact canonical JSON.");
  if (manifest.validationPolicyHash !== validationPolicyHash)
    throw new Error("Snapshot validation policy hash is not current.");
  assertUnique(
    manifest.artifacts.map((artifact) => artifact.logicalId),
    "snapshot logical IDs",
  );
  assertUnique(
    manifest.artifacts.map((artifact) => artifact.path),
    "snapshot paths",
  );
  assertOrdered(manifest.artifacts, (artifact) => artifact.path, "Artifacts");
  assertOrdered(
    manifest.edges,
    (edge) => `${edge.source}\0${edge.type}\0${edge.target}`,
    "Edges",
  );
  const ids = new Set(manifest.artifacts.map((artifact) => artifact.logicalId));
  for (const edge of manifest.edges) {
    if (!ids.has(edge.source))
      throw new Error(`Unknown graph source: ${edge.source}.`);
    if (!ids.has(edge.target))
      throw new Error(`Unknown graph target: ${edge.target}.`);
  }
  const parsed = await validateSnapshotBodies(manifest.artifacts, bodies);
  if (
    canonicalJson(buildSnapshotEdges(parsed)) !== canonicalJson(manifest.edges)
  )
    throw new Error(
      "Snapshot graph does not match body-derived relationships.",
    );
  return parsed;
}

export async function buildCanonicalSnapshot(
  source: SnapshotSource,
  artifactsInput: readonly SnapshotArtifact[],
  bodies: ReadonlyMap<string, Uint8Array>,
): Promise<{
  manifest: SnapshotManifest;
  manifestBody: string;
  manifestHash: string;
  parsed: ParsedSnapshot;
}> {
  const artifacts = [...artifactsInput].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const parsed = await validateSnapshotBodies(artifacts, bodies);
  const manifest = snapshotManifestSchema.parse({
    schemaVersion: "content-snapshot-v1",
    validationPolicyHash,
    source,
    artifacts,
    edges: buildSnapshotEdges(parsed),
  });
  const manifestBody = canonicalJson(manifest);
  await validateCanonicalSnapshot(manifestBody, bodies);
  return {
    manifest,
    manifestBody,
    manifestHash: sha256(manifestBody),
    parsed,
  };
}

export type ArtifactOverlay = {
  logicalId: string;
  changeKind: "ADD" | "MODIFY" | "DELETE" | "NO_CHANGE";
  artifact?: SnapshotArtifact;
};

export function applyArtifactOverlay(
  baseArtifacts: readonly SnapshotArtifact[],
  overlay: readonly ArtifactOverlay[],
): SnapshotArtifact[] {
  assertUnique(
    baseArtifacts.map((artifact) => artifact.logicalId),
    "base logical IDs",
  );
  assertUnique(
    overlay.map((change) => change.logicalId),
    "overlay logical IDs",
  );
  const result = new Map(
    baseArtifacts.map((artifact) => [artifact.logicalId, artifact]),
  );
  for (const change of overlay) {
    const current = result.get(change.logicalId);
    if (change.changeKind === "DELETE") {
      if (!current)
        throw new Error(`Cannot delete missing artifact ${change.logicalId}.`);
      if (change.artifact)
        throw new Error(`Delete ${change.logicalId} must not include a body.`);
      result.delete(change.logicalId);
      continue;
    }
    if (!change.artifact || change.artifact.logicalId !== change.logicalId)
      throw new Error(
        `Overlay body is missing or mismatched for ${change.logicalId}.`,
      );
    if (change.changeKind === "ADD" && current)
      throw new Error(`Cannot add existing artifact ${change.logicalId}.`);
    if (change.changeKind === "MODIFY" && !current)
      throw new Error(`Cannot modify missing artifact ${change.logicalId}.`);
    if (
      change.changeKind === "NO_CHANGE" &&
      (!current || canonicalJson(current) !== canonicalJson(change.artifact))
    )
      throw new Error(
        `No-change artifact ${change.logicalId} changed identity.`,
      );
    result.set(change.logicalId, change.artifact);
  }
  const artifacts = [...result.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  assertUnique(
    artifacts.map((artifact) => artifact.path),
    "result paths",
  );
  return artifacts;
}
