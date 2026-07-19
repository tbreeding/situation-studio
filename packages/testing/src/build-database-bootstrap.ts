import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "@situation-studio/content-contracts";
import {
  createBootstrapPackage,
  packageRoot,
} from "./database-bootstrap-package";

const studioRoot = path.resolve(import.meta.dirname, "../../..");
const leadershipRoot = path.resolve(
  process.env.LEADERSHIP_REPO_PATH ?? path.join(studioRoot, "../leadership"),
);
const outputRoot = packageRoot(studioRoot);
const result = await createBootstrapPackage(leadershipRoot);

fs.mkdirSync(path.join(outputRoot, "blobs"), { recursive: true, mode: 0o700 });
for (const [hash, bytes] of result.bodies)
  fs.writeFileSync(path.join(outputRoot, "blobs", hash), bytes, {
    mode: 0o600,
  });

const expectedBlobs = new Set(result.bodies.keys());
const unexpectedBlobs = fs
  .readdirSync(path.join(outputRoot, "blobs"))
  .filter((name) => !expectedBlobs.has(name));
if (unexpectedBlobs.length)
  throw new Error(
    `Bootstrap blob directory has stale files: ${unexpectedBlobs.join(", ")}`,
  );

fs.writeFileSync(path.join(outputRoot, "manifest.json"), result.manifestBody);
fs.writeFileSync(
  path.join(outputRoot, "graph.json"),
  canonicalJson({
    schemaVersion: "content-snapshot-graph-v1",
    edges: result.manifest.edges,
  }),
);
fs.writeFileSync(
  path.join(outputRoot, "inventory.json"),
  canonicalJson(result.inventory),
);
fs.writeFileSync(
  path.join(outputRoot, "parity-report.json"),
  canonicalJson(result.parityReport),
);
fs.writeFileSync(
  path.join(outputRoot, "route-probes.json"),
  canonicalJson(result.routeProbes),
);
fs.writeFileSync(
  path.join(outputRoot, "tool-extraction.json"),
  canonicalJson(result.toolExtraction),
);
fs.writeFileSync(
  path.join(outputRoot, "receipt.json"),
  canonicalJson({
    schemaVersion: "database-bootstrap-receipt-v1",
    manifestHash: result.manifestHash,
    validationPolicyHash: result.manifest.validationPolicyHash,
    artifactCount: result.manifest.artifacts.length,
    edgeCount: result.manifest.edges.length,
    totalByteLength: result.inventory.canonicalByteLength,
    source: result.manifest.source,
  }),
);

process.stdout.write(
  `Built canonical bootstrap ${result.manifestHash}: ${result.manifest.artifacts.length} artifacts, ${result.manifest.edges.length} edges, ${result.routeProbes.routes.length} route probes.\n`,
);
