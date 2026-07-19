import fs from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  sha256,
  snapshotManifestSchema,
  validateCanonicalSnapshot,
} from "@situation-studio/content-contracts";
import {
  createBootstrapPackage,
  packageRoot,
  readPackagedBodies,
} from "./database-bootstrap-package";

const studioRoot = path.resolve(import.meta.dirname, "../../..");
const leadershipRoot = path.resolve(
  process.env.LEADERSHIP_REPO_PATH ?? path.join(studioRoot, "../leadership"),
);
const outputRoot = packageRoot(studioRoot);
const first = await createBootstrapPackage(leadershipRoot);
const second = await createBootstrapPackage(leadershipRoot);
if (
  first.manifestBody !== second.manifestBody ||
  first.manifestHash !== second.manifestHash
)
  throw new Error("Rebuilding identical source produced a different snapshot.");

const packagedManifestBody = fs.readFileSync(
  path.join(outputRoot, "manifest.json"),
  "utf8",
);
if (packagedManifestBody !== first.manifestBody)
  throw new Error(
    "Packaged manifest does not match the current managed inventory.",
  );
const manifest = snapshotManifestSchema.parse(JSON.parse(packagedManifestBody));
const bodies = readPackagedBodies(studioRoot, manifest.artifacts);
const parsed = await validateCanonicalSnapshot(packagedManifestBody, bodies);

const expectedFiles = new Map([
  ["inventory.json", canonicalJson(first.inventory)],
  ["parity-report.json", canonicalJson(first.parityReport)],
  ["route-probes.json", canonicalJson(first.routeProbes)],
  ["tool-extraction.json", canonicalJson(first.toolExtraction)],
  [
    "graph.json",
    canonicalJson({
      schemaVersion: "content-snapshot-graph-v1",
      edges: first.manifest.edges,
    }),
  ],
]);
for (const [filename, expected] of expectedFiles) {
  const actual = fs.readFileSync(path.join(outputRoot, filename), "utf8");
  if (actual !== expected)
    throw new Error(`${filename} is stale or noncanonical.`);
}
const packagedBlobNames = fs
  .readdirSync(path.join(outputRoot, "blobs"))
  .sort((left, right) => left.localeCompare(right));
const expectedBlobNames = [...first.bodies.keys()].sort((left, right) =>
  left.localeCompare(right),
);
if (canonicalJson(packagedBlobNames) !== canonicalJson(expectedBlobNames))
  throw new Error(
    "Packaged blob inventory is incomplete or contains stale data.",
  );
for (const [hash, bytes] of bodies)
  if (sha256(bytes) !== hash)
    throw new Error(`Packaged blob ${hash} is corrupt.`);

process.stdout.write(
  `Database bootstrap verified without Git: ${manifest.artifacts.length} artifacts, ${manifest.edges.length} relationships, ${parsed.routeProbes.length} MDX-compile and route-contract probes, manifest ${first.manifestHash}.\n`,
);
