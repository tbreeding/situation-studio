import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const studioRoot = path.resolve(import.meta.dirname, "../../..");
const leadershipRoot = path.resolve(
  process.env.LEADERSHIP_REPO_PATH ?? path.join(studioRoot, "../leadership"),
);
const artifactRoot = path.join(studioRoot, "artifacts/baseline");
const expectedCommit = "9a870e5c70fef9ae71506cb3138745b88363a190";
const manifest = JSON.parse(
  fs.readFileSync(path.join(artifactRoot, "manifest.json"), "utf8"),
) as {
  commit: string;
  artifacts: {
    logicalId: string;
    type: string;
    path: string;
    contentHash: string;
    byteLength: number;
  }[];
};
const graph = JSON.parse(
  fs.readFileSync(path.join(artifactRoot, "graph.json"), "utf8"),
) as {
  sourceCommit: string;
  nodes: { id: string }[];
  edges: { source: string; target: string; type: string }[];
};

const failures: string[] = [];
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: leadershipRoot,
  encoding: "utf8",
}).trim();
const remote = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], {
  cwd: leadershipRoot,
  encoding: "utf8",
})
  .trim()
  .split(/\s/u)[0];
if (head !== expectedCommit) failures.push(`HEAD mismatch: ${head}`);
if (remote !== expectedCommit) failures.push(`origin/main mismatch: ${remote}`);
if (manifest.commit !== head || graph.sourceCommit !== head)
  failures.push("Baseline files do not address current HEAD");

const ids = new Set<string>();
const paths = new Set<string>();
for (const artifact of manifest.artifacts) {
  if (ids.has(artifact.logicalId))
    failures.push(`Duplicate logical ID: ${artifact.logicalId}`);
  if (paths.has(artifact.path))
    failures.push(`Duplicate artifact path: ${artifact.path}`);
  ids.add(artifact.logicalId);
  paths.add(artifact.path);
  const bytes = fs.readFileSync(path.join(leadershipRoot, artifact.path));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== artifact.contentHash || bytes.byteLength !== artifact.byteLength)
    failures.push(`Byte mismatch: ${artifact.path}`);
}

const counts = manifest.artifacts.reduce<
  Record<string, typeof manifest.artifacts>
>((result, artifact) => {
  (result[artifact.type] ??= []).push(artifact);
  return result;
}, {});
if (counts.SITUATION?.length !== 15)
  failures.push(`Expected 15 situations, got ${counts.SITUATION?.length ?? 0}`);
if (counts.GUIDE?.length !== 3)
  failures.push(`Expected 3 guides, got ${counts.GUIDE?.length ?? 0}`);
if (counts.PRACTICE?.length !== 3)
  failures.push(`Expected 3 practices, got ${counts.PRACTICE?.length ?? 0}`);

const nodeIds = new Set(graph.nodes.map((node) => node.id));
for (const edge of graph.edges) {
  if (!nodeIds.has(edge.source))
    failures.push(`Unknown edge source: ${edge.source}`);
  if (!nodeIds.has(edge.target))
    failures.push(`Unknown edge target: ${edge.target}`);
}
for (const practice of ["listen-first", "coaching-choice", "feedback-fork"]) {
  const consumers = graph.edges.filter(
    (edge) =>
      edge.target === `practice:${practice}` && edge.type === "EMBEDS_PRACTICE",
  );
  const expected = manifest.artifacts
    .filter((artifact) => ["SITUATION", "GUIDE"].includes(artifact.type))
    .filter((artifact) =>
      fs
        .readFileSync(path.join(leadershipRoot, artifact.path), "utf8")
        .includes(`practiceId: ${practice}`),
    ).length;
  if (consumers.length !== expected)
    failures.push(
      `${practice} consumer mismatch: graph=${consumers.length}, files=${expected}`,
    );
}

if (failures.length)
  throw new Error(`Baseline verification failed:\n- ${failures.join("\n- ")}`);
process.stdout.write(
  `Baseline verified independently: ${manifest.artifacts.length} files, ${graph.nodes.length} nodes, ${graph.edges.length} edges, commit ${head}.\n`,
);
