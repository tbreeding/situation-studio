import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const studioRoot = path.resolve(import.meta.dirname, "../../..");
const baselineRoot = path.join(studioRoot, "artifacts/baseline");
const outputRoot = path.join(studioRoot, "artifacts/reports");
const manifestBody = fs.readFileSync(
  path.join(baselineRoot, "manifest.json"),
  "utf8",
);
const graphBody = fs.readFileSync(
  path.join(baselineRoot, "graph.json"),
  "utf8",
);
const manifest = JSON.parse(manifestBody) as {
  commit: string;
  artifacts: {
    logicalId: string;
    type: string;
    path: string;
    contentHash: string;
  }[];
};
const graph = JSON.parse(graphBody) as {
  nodes: { id: string; type: string }[];
  edges: unknown[];
};
const situations = manifest.artifacts.filter(
  (artifact) => artifact.type === "SITUATION",
);

const report = {
  mode: "DRY_RUN_NO_DATABASE_WRITES",
  baselineCommit: manifest.commit,
  manifestHash: createHash("sha256").update(manifestBody).digest("hex"),
  graphHash: createHash("sha256").update(graphBody).digest("hex"),
  proposedRows: {
    repositorySnapshots: 1,
    situations: situations.length,
    situationVersions: situations.length,
    publications: situations.length,
    artifacts: manifest.artifacts.length,
    artifactEdges: graph.edges.length,
  },
  lifecycle: "ACTIVE",
  publicationState: "PUBLISHED",
  sourceKind: "LEGACY_IMPORT",
  auditActor: "system:legacy-import",
  idempotencyIdentity: `${manifest.commit}:${createHash("sha256").update(manifestBody).digest("hex")}`,
  repositoryMutation: false,
  databaseMutation: false,
  blockers: [] as string[],
};
if (situations.length !== 15)
  report.blockers.push("Legacy import requires exactly 15 baseline situations");
if (manifest.commit !== "9a870e5c70fef9ae71506cb3138745b88363a190")
  report.blockers.push("Baseline commit mismatch");
fs.mkdirSync(outputRoot, { recursive: true });
fs.writeFileSync(
  path.join(outputRoot, "legacy-import-dry-run.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(
  `Legacy dry run: ${report.proposedRows.situations} situations, ${report.proposedRows.artifacts} artifacts, ${report.blockers.length} blockers, no writes.\n`,
);
