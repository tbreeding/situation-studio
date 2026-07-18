import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";

const studioRoot = path.resolve(import.meta.dirname, "../../..");
const leadershipRoot = path.resolve(
  process.env.LEADERSHIP_REPO_PATH ?? path.join(studioRoot, "../leadership"),
);
const outputRoot = path.join(studioRoot, "artifacts/baseline");
const expectedCommit = "9a870e5c70fef9ae71506cb3138745b88363a190";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, sort(child)]),
      );
    return item;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function filesIn(relative: string, extension: string): string[] {
  const directory = path.join(leadershipRoot, relative);
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(extension))
    .sort()
    .map((file) => path.posix.join(relative, file));
}

const trackedPaths = [
  ...filesIn("content/situations", ".mdx"),
  ...filesIn("content/guides", ".mdx"),
  ...filesIn("content/practices", ".json"),
  "content/bibliography/sources.json",
  "content/authors/authors.json",
  "lib/tools.ts",
  "sourceMaterial/leadership-workshops-master/000_Syllabus.md",
  ...filesIn("sourceMaterial/leadership-workshops-master/lesson-plans", ".md"),
  ...filesIn("sourceMaterial/leadership-workshops-master/misc", ".md"),
];

const typeForPath = (relativePath: string) => {
  if (relativePath.startsWith("content/situations/")) return "SITUATION";
  if (relativePath.startsWith("content/guides/")) return "GUIDE";
  if (relativePath.startsWith("content/practices/")) return "PRACTICE";
  if (
    relativePath.includes("/lesson-plans/") ||
    relativePath.endsWith("000_Syllabus.md")
  )
    return "LESSON_PLAN";
  if (relativePath.includes("/misc/")) return "PREPARATION_PROMPT";
  if (relativePath.endsWith("sources.json")) return "SOURCE";
  if (relativePath.endsWith("authors.json")) return "AUTHOR";
  return "TOOL";
};

const logicalIdFor = (relativePath: string, body: string) => {
  if (relativePath.endsWith(".mdx"))
    return `${typeForPath(relativePath).toLowerCase()}:${String(matter(body).data.slug)}`;
  if (relativePath.startsWith("content/practices/"))
    return `practice:${String((JSON.parse(body) as { id: string }).id)}`;
  if (relativePath.endsWith("sources.json")) return "source:catalog";
  if (relativePath.endsWith("authors.json")) return "author:catalog";
  if (relativePath === "lib/tools.ts") return "tool:catalog";
  return `${typeForPath(relativePath).toLowerCase()}:${path
    .basename(relativePath, path.extname(relativePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")}`;
};

const artifacts = trackedPaths.map((relativePath) => {
  const bytes = fs.readFileSync(path.join(leadershipRoot, relativePath));
  const body = bytes.toString("utf8");
  return {
    logicalId: logicalIdFor(relativePath, body),
    type: typeForPath(relativePath),
    path: relativePath,
    contentHash: sha256(bytes),
    byteLength: bytes.byteLength,
  };
});

type Node = { id: string; type: string; path?: string; label: string };
type Edge = { source: string; target: string; type: string; evidence: string };
const nodes = new Map<string, Node>();
const edges: Edge[] = [];
for (const artifact of artifacts)
  nodes.set(artifact.logicalId, {
    id: artifact.logicalId,
    type: artifact.type,
    path: artifact.path,
    label: artifact.logicalId.split(":").slice(1).join(":"),
  });
nodes.set("route:home", { id: "route:home", type: "ROUTE", label: "/" });
nodes.set("route:situations", {
  id: "route:situations",
  type: "ROUTE",
  label: "/situations",
});
nodes.set("route:guides", {
  id: "route:guides",
  type: "ROUTE",
  label: "/guides",
});
nodes.set("route:practice", {
  id: "route:practice",
  type: "ROUTE",
  label: "/practice",
});
nodes.set("validator:content-graph", {
  id: "validator:content-graph",
  type: "VALIDATOR",
  path: "lib/content.ts",
  label: "Content graph validator",
});

const addEdge = (
  source: string,
  target: string,
  type: string,
  evidence: string,
) => {
  edges.push({ source, target, type, evidence });
};

for (const relativePath of [
  ...filesIn("content/situations", ".mdx"),
  ...filesIn("content/guides", ".mdx"),
]) {
  const raw = fs.readFileSync(path.join(leadershipRoot, relativePath), "utf8");
  const parsed = matter(raw);
  const kind = relativePath.includes("/situations/") ? "situation" : "guide";
  const sourceId = `${kind}:${String(parsed.data.slug)}`;
  addEdge(
    sourceId,
    `practice:${String(parsed.data.practiceId)}`,
    "EMBEDS_PRACTICE",
    `${relativePath}:practiceId`,
  );
  for (const related of (parsed.data.relatedSituationIds ?? []) as string[])
    addEdge(
      sourceId,
      `situation:${related}`,
      "LINKS_TO",
      `${relativePath}:relatedSituationIds`,
    );
  for (const source of (parsed.data.sourceReferences ?? []) as string[]) {
    if (!nodes.has(`source:${source}`))
      nodes.set(`source:${source}`, {
        id: `source:${source}`,
        type: "SOURCE",
        path: "content/bibliography/sources.json",
        label: source,
      });
    addEdge(
      sourceId,
      `source:${source}`,
      "CITES_SOURCE",
      `${relativePath}:sourceReferences`,
    );
  }
  addEdge(
    sourceId,
    kind === "situation" ? "route:situations" : "route:guides",
    "CONSUMED_BY_ROUTE",
    relativePath,
  );
  addEdge(
    sourceId,
    "validator:content-graph",
    "VALIDATED_BY",
    "lib/content.ts",
  );
}

for (const practicePath of filesIn("content/practices", ".json")) {
  const practice = JSON.parse(
    fs.readFileSync(path.join(leadershipRoot, practicePath), "utf8"),
  ) as { id: string };
  addEdge(
    `practice:${practice.id}`,
    "route:practice",
    "CONSUMED_BY_ROUTE",
    "app/practice/[slug]/page.tsx",
  );
  if (practice.id === "listen-first")
    addEdge(
      `practice:${practice.id}`,
      "route:home",
      "CONSUMED_BY_ROUTE",
      "app/page.tsx:weeklyPractice",
    );
  addEdge(
    `practice:${practice.id}`,
    "validator:content-graph",
    "VALIDATED_BY",
    "lib/content.ts",
  );
}

const oneOnOneLesson = [...nodes.values()].find((node) =>
  node.id.includes("the-trinity-and-1on1s"),
);
if (oneOnOneLesson) {
  for (const slug of [
    "nothing-in-one-on-ones",
    "one-on-ones-became-status-updates",
    "repair-cancelled-one-on-ones",
  ])
    addEdge(
      `situation:${slug}`,
      oneOnOneLesson.id,
      "TAUGHT_BY_LESSON",
      "sourceReference:one-on-one-lesson",
    );
}

const manifest = {
  schemaVersion: "1",
  sourceRepository: "git@github.com:tbreeding/leadership-field-guide.git",
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: leadershipRoot,
    encoding: "utf8",
  }).trim(),
  expectedCommit,
  parserVersion: "studio-baseline-v1",
  artifacts,
};
const graph = {
  schemaVersion: "1",
  sourceCommit: manifest.commit,
  parserVersion: manifest.parserVersion,
  nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
  edges: edges.sort((a, b) =>
    `${a.source}:${a.type}:${a.target}`.localeCompare(
      `${b.source}:${b.type}:${b.target}`,
    ),
  ),
};

fs.mkdirSync(outputRoot, { recursive: true });
const manifestBody = canonical(manifest);
const graphBody = canonical(graph);
fs.writeFileSync(path.join(outputRoot, "manifest.json"), manifestBody);
fs.writeFileSync(path.join(outputRoot, "graph.json"), graphBody);
fs.writeFileSync(
  path.join(outputRoot, "receipt.json"),
  canonical({
    commit: manifest.commit,
    manifestHash: sha256(manifestBody),
    graphHash: sha256(graphBody),
    generatedAt: new Date().toISOString(),
  }),
);
process.stdout.write(
  `Generated ${artifacts.length} artifacts, ${nodes.size} graph nodes, and ${edges.length} edges at ${manifest.commit}.\n`,
);
